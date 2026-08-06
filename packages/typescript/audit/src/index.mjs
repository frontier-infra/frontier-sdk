import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AUDIT_PACKAGE_VERSION = '0.1.0-rc.2';
export const AUDIT_PACKET_SCHEMA_VERSION = 'frontier.audit.packet.v1';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatedRoot = path.join(packageRoot, 'assets/generated');
const kitAdapter = path.join(generatedRoot, 'the-machine/kit_json_adapter.py');
const kitRoot = path.join(generatedRoot, 'the-machine');
const aarTool = path.join(generatedRoot, 'agentcontrolplane/tools/aar.mjs');
const snapshotLockPath = path.join(generatedRoot, 'audit-snapshot-lock.json');

const sha256 = (content) => crypto.createHash('sha256').update(content).digest('hex');
const b64u = (content) => crypto.createHash('sha256').update(content).digest('base64url');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function ensureSnapshotIntegrity() {
  const missing = [kitAdapter, aarTool, snapshotLockPath].filter((file) => !fs.existsSync(file));
  if (missing.length) {
    throw new Error(`audit package snapshot is incomplete: ${missing.map((file) => path.relative(packageRoot, file)).join(', ')}`);
  }
  const lock = readJson(snapshotLockPath);
  const mismatches = [];
  for (const [relative, expected] of Object.entries(lock.files ?? {})) {
    const absolute = path.join(generatedRoot, relative);
    if (!fs.existsSync(absolute)) {
      mismatches.push(`${relative}: missing`);
      continue;
    }
    const actual = sha256(fs.readFileSync(absolute));
    if (actual !== expected.generated_sha256) {
      mismatches.push(`${relative}: expected ${expected.generated_sha256}, got ${actual}`);
    }
  }
  if (mismatches.length) {
    throw new Error(`audit package snapshot lock verification failed:\n- ${mismatches.join('\n- ')}`);
  }
  return lock;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: options.encoding ?? 'utf8',
    input: options.input,
    maxBuffer: 30 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const stderr = result.stderr ? `\n${result.stderr.trim()}` : '';
    throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}${stderr}`);
  }
  return result;
}

function git(cwd, args, options = {}) {
  return run('git', ['-C', cwd, ...args], options);
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function realpathForContainment(candidate) {
  const resolved = path.resolve(candidate);
  if (fs.existsSync(resolved)) return fs.realpathSync(resolved);

  const missingParts = [];
  let cursor = resolved;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new Error(`cannot resolve output path for containment check: ${candidate}`);
    }
    missingParts.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.join(fs.realpathSync(cursor), ...missingParts);
}

function assertOutputOutsideRepo(outDir, gitRoot) {
  const outputReal = realpathForContainment(outDir);
  const repoReal = fs.realpathSync(gitRoot);
  if (isInside(outputReal, repoReal)) {
    throw new Error(`--out must be outside the audited Git repository: ${outDir}`);
  }
}

function splitNul(output) {
  return output.split('\0').filter(Boolean);
}

function collectGitBinding(target) {
  const top = git(target, ['rev-parse', '--show-toplevel']).stdout.trim();
  const commit = git(top, ['rev-parse', 'HEAD']).stdout.trim();
  const branchResult = git(top, ['branch', '--show-current'], { allowFailure: true });
  const statusRaw = git(top, ['status', '--porcelain=v1', '-z']).stdout;
  const trackedDiff = git(top, ['diff', '--binary', 'HEAD', '--']).stdout;
  const stagedDiff = git(top, ['diff', '--binary', '--cached', 'HEAD', '--']).stdout;
  const untracked = splitNul(git(top, ['ls-files', '--others', '--exclude-standard', '-z']).stdout);

  const untrackedFiles = untracked.map((relative) => {
    const absolute = path.join(top, relative);
    const stat = fs.statSync(absolute);
    return {
      path: relative,
      bytes: stat.size,
      sha256: stat.isFile() && stat.size <= 10_000_000 ? sha256(fs.readFileSync(absolute)) : null,
    };
  });

  return {
    branch: branchResult.status === 0 && branchResult.stdout.trim() ? branchResult.stdout.trim() : null,
    commit,
    dirty: statusRaw.length > 0,
    git_root: top,
    staged_diff_sha256: sha256(Buffer.from(stagedDiff)),
    status_entries: splitNul(statusRaw),
    status_sha256: sha256(Buffer.from(statusRaw)),
    tracked_diff_sha256: sha256(Buffer.from(trackedDiff)),
    untracked_files: untrackedFiles,
  };
}

function packageMetadata(snapshotLock) {
  return {
    audit_package_version: AUDIT_PACKAGE_VERSION,
    node: process.version,
    platform: `${os.platform()}-${os.arch()}`,
    snapshot_lock_sha256: sha256(fs.readFileSync(snapshotLockPath)),
    snapshot_lock: snapshotLock,
  };
}

function assertNoKeyPrefix(value, prefix, pathParts = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoKeyPrefix(entry, prefix, [...pathParts, String(index)]));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith(prefix)) {
      throw new Error(`canonical kit JSON contains unsupported ${prefix} field at ${[...pathParts, key].join('.')}`);
    }
    assertNoKeyPrefix(child, prefix, [...pathParts, key]);
  }
}

function assertStaticScoreInvariants(score) {
  assertNoKeyPrefix(score, 'confirmed_');
  if (score.full_conformance_claimed !== false) {
    throw new Error('canonical kit JSON must set full_conformance_claimed=false');
  }
  if (score.live_checks_executed !== false) {
    throw new Error('canonical kit JSON must set live_checks_executed=false');
  }
}

function runKitAdapter({ target, name, shape, jsonOut, markdownOut }) {
  const env = {
    ...process.env,
    PYTHONPATH: kitRoot,
  };
  const baseArgs = ['-m', 'kit', 'score', target, '--shape', shape];
  if (name) baseArgs.push('--name', name);
  const jsonResult = run('python3', [...baseArgs, '--format', 'json', '--out', jsonOut], { env, allowFailure: true });
  if (jsonResult.status === 0) {
    run('python3', [...baseArgs, '--format', 'markdown', '--out', markdownOut], { env });
    return;
  }

  const args = [kitAdapter, target, '--shape', shape, '--json-out', jsonOut, '--markdown-out', markdownOut];
  if (name) args.splice(2, 0, '--name', name);
  run('python3', args, { env });
}

function renderMarkdown(packet, kitMarkdown, signing) {
  const lines = [];
  lines.push(`# Frontier audit packet — ${packet.target.name}`);
  lines.push('');
  lines.push(`_Audit ${packet.audit.id} · ${packet.audit.issued_at} · schema ${packet.schema_version}_`);
  lines.push('');
  lines.push('## Preflight binding');
  lines.push('');
  lines.push(`- Target: \`${packet.target.path}\``);
  lines.push(`- Git root: \`${packet.preflight.git_root}\``);
  lines.push(`- Commit: \`${packet.preflight.commit}\``);
  lines.push(`- Dirty tree: \`${packet.preflight.dirty ? 'yes' : 'no'}\``);
  lines.push(`- Status SHA-256: \`${packet.preflight.status_sha256}\``);
  lines.push(`- Tracked diff SHA-256: \`${packet.preflight.tracked_diff_sha256}\``);
  lines.push(`- Staged diff SHA-256: \`${packet.preflight.staged_diff_sha256}\``);
  lines.push('');
  lines.push('## Live checks');
  lines.push('');
  for (const check of packet.live_checks) {
    lines.push(`- \`${check.id}\`: ${check.status} — ${check.reason}`);
  }
  lines.push('');
  lines.push('## Signature');
  lines.push('');
  if (signing) {
    lines.push(`- AAR record: \`${path.basename(signing.aar_path)}\``);
    lines.push(`- Verification: ${signing.verification.status}`);
  } else {
    lines.push('- NOT_RUN — no signing key path and DID JSON were provided by the operator.');
  }
  lines.push('');
  lines.push('## Canonical kit packet');
  lines.push('');
  lines.push(kitMarkdown.trimEnd());
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function aarRecord({ packet, evidenceJsonPath, evidenceJson, didJsonPath, verifierIndependence, principalId }) {
  const did = readJson(didJsonPath);
  if (typeof did.id !== 'string' || !did.id.trim()) {
    throw new Error('--did-json must contain a top-level DID id');
  }
  const principal = principalId ?? did.id;
  if (packet.target.subject === did.id) {
    throw new Error('--subject must differ from the verifier DID for a signed Frontier Audit receipt');
  }
  if (verifierIndependence !== 'same_principal') {
    if (packet.target.subject_source !== 'operator_supplied') {
      throw new Error('--subject is required when --verifier-independence is separate_principal or third_party');
    }
    if (!principalId) {
      throw new Error('--principal is required when --verifier-independence is separate_principal or third_party');
    }
    if (principal === did.id) {
      throw new Error('--principal must differ from the verifier DID for separate_principal or third_party receipts');
    }
  }
  const observedAt = packet.audit.issued_at;
  const response = {
    evidence_packet_sha256: sha256(Buffer.from(evidenceJson)),
    path: evidenceJsonPath,
    static_candidate_level_name: packet.static_score.static_candidate_level_name,
  };
  const preimage = {
    observed_at: observedAt,
    query: 'frontier-audit run --local-static',
    response,
  };
  return {
    aar: '0.02',
    subject: packet.target.subject,
    principal,
    task: {
      id: packet.audit.id,
      claim: `Generated a local static Frontier audit evidence packet for ${packet.target.name} at ${packet.preflight.commit}`,
    },
    verdict: 'verified',
    quality: 'substantive',
    ground_truth: 'confirmed',
    reason: 'The canonical The Machine static kit completed and the evidence packet hash was recorded.',
    checks: [{
      source: `file://${evidenceJsonPath}`,
      query: preimage.query,
      observed_at: observedAt,
      response_sha256: b64u(JSON.stringify(preimage)),
      excerpt: JSON.stringify(response),
    }],
    verifier: {
      id: did.id,
      model: `@frontier-infra/audit@${AUDIT_PACKAGE_VERSION}`,
      policy_sha256: packet.package.snapshot_lock_sha256,
      independence: verifierIndependence,
    },
    issued: observedAt,
    sig: { by: did.id },
  };
}

function signAndVerify({ packet, evidenceJsonPath, evidenceJson, outDir, signKeyPath, didJsonPath, verifierIndependence, principalId }) {
  if (!signKeyPath && !didJsonPath) return null;
  if (!signKeyPath || !didJsonPath) {
    throw new Error('signing requires both --sign-key and --did-json so verification stays offline and explicit');
  }

  const aarPath = path.join(outDir, 'aar.json');
  writeJson(aarPath, aarRecord({ packet, evidenceJsonPath, evidenceJson, didJsonPath, verifierIndependence, principalId }));
  run(process.execPath, [aarTool, 'sign', aarPath, '--priv', signKeyPath]);
  const verification = run(process.execPath, [aarTool, 'verify', aarPath, '--did-json', didJsonPath], { allowFailure: true });
  const verifyText = `${verification.stdout || ''}${verification.stderr || ''}`;
  fs.writeFileSync(path.join(outDir, 'aar-verify.txt'), verifyText);
  if (verification.status !== 0) {
    throw new Error(`AAR signature verification failed; see ${path.join(outDir, 'aar-verify.txt')}`);
  }
  if (!/conformance: L2\b/.test(verifyText)) {
    throw new Error(`signed Frontier Audit receipts must satisfy AAR L2; see ${path.join(outDir, 'aar-verify.txt')}`);
  }
  return {
    aar_path: aarPath,
    did_json_path: path.resolve(didJsonPath),
    signed_payload_path: evidenceJsonPath,
    signed_payload_sha256: sha256(Buffer.from(evidenceJson)),
    verification: {
      status: 'PASS',
      output: verifyText.trim(),
    },
  };
}

export function runAudit(options = {}) {
  const snapshotLock = ensureSnapshotIntegrity();
  const target = path.resolve(options.target ?? process.cwd());
  if (!fs.existsSync(target)) throw new Error(`target does not exist: ${target}`);
  const outDir = path.resolve(options.outDir ?? path.join(process.cwd(), 'frontier-audit-evidence'));
  const name = options.name ?? path.basename(target);
  const shape = options.shape ?? 'auto';
  const verifierIndependence = options.verifierIndependence ?? 'same_principal';
  if (!['auto', 'machine', 'orchestrator'].includes(shape)) {
    throw new Error('--shape must be auto, machine, or orchestrator');
  }
  if (!['same_principal', 'separate_principal', 'third_party'].includes(verifierIndependence)) {
    throw new Error('--verifier-independence must be same_principal, separate_principal, or third_party');
  }

  const preflight = collectGitBinding(target);
  assertOutputOutsideRepo(outDir, preflight.git_root);
  fs.mkdirSync(outDir, { recursive: true });
  const kitJsonPath = path.join(outDir, 'kit-score.json');
  const kitMarkdownPath = path.join(outDir, 'kit-packet.md');
  runKitAdapter({ target, name, shape, jsonOut: kitJsonPath, markdownOut: kitMarkdownPath });

  const staticScore = readJson(kitJsonPath);
  assertStaticScoreInvariants(staticScore);
  const issuedAt = new Date().toISOString();
  const packet = {
    schema_version: AUDIT_PACKET_SCHEMA_VERSION,
    audit: {
      id: `frontier-audit-${sha256(Buffer.from(`${preflight.commit}\0${preflight.status_sha256}\0${issuedAt}`)).slice(0, 16)}`,
      issued_at: issuedAt,
      command: 'frontier-audit run',
      network_actions: 'NOT_RUN',
    },
    target: {
      name,
      path: target,
      subject: options.subject ?? `did:web:frontier-audit.local:${sha256(Buffer.from(target)).slice(0, 16)}`,
      subject_source: options.subject ? 'operator_supplied' : 'derived_local_repository_id',
      output_inside_target: isInside(outDir, target),
    },
    package: packageMetadata(snapshotLock),
    preflight,
    static_score: staticScore,
    live_checks: (staticScore.not_run ?? []).map((row) => ({
      id: row.obligation.id,
      title: row.obligation.title,
      status: 'NOT_RUN',
      reason: row.evidence,
    })),
  };

  const evidenceJson = `${JSON.stringify(packet, null, 2)}\n`;
  const evidenceJsonPath = path.join(outDir, 'evidence.json');
  fs.writeFileSync(evidenceJsonPath, evidenceJson);
  const signing = signAndVerify({
    packet,
    evidenceJsonPath,
    evidenceJson,
    outDir,
    signKeyPath: options.signKeyPath,
    didJsonPath: options.didJsonPath,
    verifierIndependence,
    principalId: options.principal,
  });
  if (signing) writeJson(path.join(outDir, 'signature.json'), signing);
  const kitMarkdown = fs.readFileSync(kitMarkdownPath, 'utf8');
  const markdownPath = path.join(outDir, 'evidence.md');
  fs.writeFileSync(markdownPath, renderMarkdown(packet, kitMarkdown, signing));

  return {
    evidenceJsonPath,
    kitJsonPath,
    kitMarkdownPath,
    markdownPath,
    outDir,
    packet,
    signing,
  };
}

function parseAarEvidenceCommitment(aar) {
  const check = Array.isArray(aar.checks)
    ? aar.checks.find((entry) => entry && entry.query === 'frontier-audit run --local-static')
    : null;
  if (!check) throw new Error('AAR does not contain a frontier-audit evidence commitment');
  let response;
  try {
    response = JSON.parse(check.excerpt);
  } catch {
    throw new Error('AAR evidence commitment excerpt is not valid JSON');
  }
  if (typeof response.evidence_packet_sha256 !== 'string' || !response.evidence_packet_sha256) {
    throw new Error('AAR evidence commitment is missing evidence_packet_sha256');
  }
  const preimage = {
    observed_at: check.observed_at,
    query: check.query,
    response,
  };
  const expectedCheckHash = b64u(JSON.stringify(preimage));
  if (check.response_sha256 !== expectedCheckHash) {
    throw new Error('AAR evidence commitment preimage hash does not match checks[0].response_sha256');
  }
  return response;
}

export function verifyAudit(options = {}) {
  ensureSnapshotIntegrity();
  const evidenceJsonPath = path.resolve(options.evidenceJsonPath ?? 'evidence.json');
  const aarPath = path.resolve(options.aarPath ?? path.join(path.dirname(evidenceJsonPath), 'aar.json'));
  const didJsonPath = options.didJsonPath ? path.resolve(options.didJsonPath) : null;
  if (!didJsonPath) throw new Error('offline verification requires --did-json');
  if (!fs.existsSync(evidenceJsonPath)) throw new Error(`evidence JSON not found: ${evidenceJsonPath}`);
  if (!fs.existsSync(aarPath)) throw new Error(`AAR not found: ${aarPath}`);

  const aar = readJson(aarPath);
  const evidence = readJson(evidenceJsonPath);
  const commitment = parseAarEvidenceCommitment(aar);
  const evidenceBytes = fs.readFileSync(evidenceJsonPath);
  const actualEvidenceHash = sha256(evidenceBytes);
  if (actualEvidenceHash !== commitment.evidence_packet_sha256) {
    throw new Error(`evidence.json hash mismatch: expected ${commitment.evidence_packet_sha256}, got ${actualEvidenceHash}`);
  }
  const expectedModel = `@frontier-infra/audit@${evidence.package?.audit_package_version ?? ''}`;
  if (aar.verifier?.model !== expectedModel) {
    throw new Error(`AAR verifier model mismatch: expected ${expectedModel}, got ${aar.verifier?.model}`);
  }
  if (!evidence.package?.snapshot_lock_sha256 || aar.verifier?.policy_sha256 !== evidence.package.snapshot_lock_sha256) {
    throw new Error('AAR verifier policy SHA-256 does not match evidence package snapshot lock');
  }
  if (!aar.sig?.by || aar.verifier?.id !== aar.sig.by) {
    throw new Error('AAR verifier id must match sig.by for Frontier Audit receipts');
  }
  if (aar.subject === aar.verifier.id) {
    throw new Error('AAR subject must differ from verifier id for Frontier Audit L2 receipts');
  }
  if (!['same_principal', 'separate_principal', 'third_party'].includes(aar.verifier?.independence)) {
    throw new Error('AAR verifier independence disclosure is missing or invalid');
  }

  const verification = run(process.execPath, [aarTool, 'verify', aarPath, '--did-json', didJsonPath], { allowFailure: true });
  const output = `${verification.stdout || ''}${verification.stderr || ''}`;
  if (verification.status !== 0) {
    throw new Error(`AAR signature verification failed:\n${output.trim()}`);
  }
  if (!/conformance: L2\b/.test(output)) {
    throw new Error(`Frontier Audit receipt does not satisfy AAR L2:\n${output.trim()}`);
  }
  return {
    aar_path: aarPath,
    did_json_path: didJsonPath,
    evidence_json_path: evidenceJsonPath,
    evidence_sha256: actualEvidenceHash,
    status: 'PASS',
    output: output.trim(),
  };
}
