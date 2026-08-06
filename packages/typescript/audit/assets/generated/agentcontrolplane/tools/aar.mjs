#!/usr/bin/env node
// aar.mjs — Agent Attestation Record (AAR) reference signer / verifier.
//
// Zero-dependency (Node >= 20). Ed25519 signatures over a minimal JCS-style
// canonicalization. Reference tooling for agentscontrolplane.org.
//
//   aar keygen --did did:web:example.com --out-priv secrets/k.json --out-did specs/fixtures/.well-known/did.json
//   aar sign   <record.json> --priv secrets/k.json
//   aar verify <record.json> [--did-json <did.json>]      # --did-json = offline; else resolve did:web
//
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Minimal JCS (RFC 8785 subset): recursively sort object keys, drop the `sig`
// field and any `_`-prefixed annotation, serialize compactly. Sufficient for
// AAR's string/enum/bool records (no problematic floats). Full RFC 8785 number
// handling is a v0.2 item.
function canonical(obj) {
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) {
        if (k === "sig" || k.startsWith("_")) continue;
        out[k] = strip(v[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(strip(obj));
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const writeJson = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2) + "\n");
const b64u = (buf) => Buffer.from(buf).toString("base64url");

function keygen(args) {
  const did = args["--did"] || "did:web:example.com";
  const outPriv = args["--out-priv"] || "secrets/signing.jwk.json";
  const outDid = args["--out-did"] || ".well-known/did.json";
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  fs.mkdirSync(path.dirname(outPriv), { recursive: true });
  writeJson(outPriv, privateKey.export({ format: "jwk" }));
  fs.mkdirSync(path.dirname(outDid), { recursive: true });
  writeJson(outDid, {
    "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/suites/jws-2020/v1"],
    id: did,
    verificationMethod: [{
      id: `${did}#key-1`, type: "JsonWebKey2020", controller: did,
      publicKeyJwk: publicKey.export({ format: "jwk" }),
    }],
    assertionMethod: [`${did}#key-1`],
  });
  console.log(`keygen: private → ${outPriv} (KEEP SECRET)`);
  console.log(`        did.json → ${outDid} (publish at https://<domain>/.well-known/did.json)`);
}

function sign(args, file) {
  const key = crypto.createPrivateKey({ key: readJson(args["--priv"] || "secrets/signing.jwk.json"), format: "jwk" });
  const rec = readJson(file);
  const sigVal = crypto.sign(null, Buffer.from(canonical(rec), "utf8"), key);
  rec.sig = { alg: "Ed25519", by: (rec.sig && rec.sig.by) || rec.principal, value: b64u(sigVal) };
  writeJson(file, rec);
  console.log(`signed: ${file}  (sig.by=${rec.sig.by})`);
}

async function resolveKey(rec, args) {
  let doc;
  if (args["--did-json"]) {
    doc = readJson(args["--did-json"]);
  } else {
    const parts = rec.sig.by.split(":").slice(2); // did:web:DOMAIN[:p...]
    const host = parts.shift();
    const tail = parts.length ? parts.join("/") + "/" : "";
    doc = await (await fetch(`https://${host}/${tail}.well-known/did.json`)).json();
  }
  const vm = (doc.verificationMethod || []).find((m) => m.publicKeyJwk);
  if (!vm) throw new Error("no publicKeyJwk in did document");
  return crypto.createPublicKey({ key: vm.publicKeyJwk, format: "jwk" });
}

async function verify(args, file) {
  const rec = readJson(file);
  const results = [];
  // L0 — signature + required fields
  if (!rec.sig || rec.sig.alg !== "Ed25519") {
    results.push(["L0", false, `sig.alg must be Ed25519 (got ${rec.sig && rec.sig.alg})`]);
  } else {
    try {
      const key = await resolveKey(rec, args);
      const ok = crypto.verify(null, Buffer.from(canonical(rec), "utf8"), key, Buffer.from(rec.sig.value, "base64url"));
      results.push(["L0", ok, ok ? "Ed25519 signature valid" : "signature does NOT verify"]);
    } catch (e) {
      results.push(["L0", false, `key resolution/verify error: ${e.message}`]);
    }
  }
  const missing = ["aar", "subject", "principal", "task", "verdict", "reason", "issued"].filter((k) => rec[k] === undefined);
  if (missing.length) results.push(["L0", false, `missing required fields: ${missing.join(", ")}`]);
  // L1 — ground truth, evidence-committed
  if (rec.ground_truth !== undefined) {
    const gtOk = ["confirmed", "contradicted", "unchecked"].includes(rec.ground_truth);
    results.push(["L1", gtOk, gtOk ? `ground_truth=${rec.ground_truth}` : `invalid ground_truth=${rec.ground_truth}`]);
    if (rec.ground_truth === "confirmed" || rec.ground_truth === "contradicted") {
      const cs = Array.isArray(rec.checks) ? rec.checks : [];
      const ok = cs.length > 0 && cs.every((c) => c && c.source && c.query && c.observed_at && c.response_sha256);
      results.push(["L1", ok, ok
        ? `evidence committed (${cs.length} check${cs.length > 1 ? "s" : ""})`
        : "confirmed/contradicted requires checks[] with source, query, observed_at, response_sha256"]);
    }
  }
  // L2 — independent verifier (structural) + evidence-backed ground_truth. quality is advisory.
  if (rec.verifier !== undefined || rec.ground_truth !== undefined) {
    const indep = !!(rec.verifier && rec.verifier.id && rec.verifier.id !== rec.subject);
    results.push(["L2", indep, indep ? "independent verifier (id != subject)" : "verifier missing or self-referential (id == subject)"]);
  }
  const grade = rec.verifier && rec.verifier.independence;
  if (grade) results.push(["info", true, `independence: ${grade}${grade === "same_principal" ? " (organizational attestation — disclose; not audit-grade)" : ""}`]);
  if (rec.quality !== undefined) results.push(["info", true, `quality: ${rec.quality} (advisory, non-gating)`]);
  const lvlOk = (lvl) => { const cs = results.filter((c) => c[0] === lvl); return cs.length > 0 && cs.every((c) => c[1]); };
  let level = "FAIL";
  if (lvlOk("L0")) { level = "L0"; if (lvlOk("L1")) { level = "L1"; if (lvlOk("L2")) level = "L2"; } }
  console.log(`\n${file}`);
  for (const [lvl, ok, msg] of results) console.log(`  [${ok ? "✓" : "✗"}] ${lvl === "info" ? "ℹ" : lvl}: ${msg}`);
  console.log(`  → conformance: ${level}`);
  return level;
}

const [cmd, ...rest] = process.argv.slice(2);
const args = {}, pos = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) { args[rest[i]] = rest[i + 1]; i++; } else pos.push(rest[i]);
}
const main = async () => {
  if (cmd === "keygen") keygen(args);
  else if (cmd === "sign") sign(args, pos[0]);
  else if (cmd === "verify") process.exitCode = (await verify(args, pos[0])) === "FAIL" ? 2 : 0;
  else { console.log("usage: aar keygen|sign <record>|verify <record> [--priv f][--did-json f][--did d][--out-priv f][--out-did f]"); process.exit(1); }
};
main().catch((e) => { console.error("error:", e.message); process.exit(1); });
