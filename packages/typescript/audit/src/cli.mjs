#!/usr/bin/env node

import process from 'node:process';

import { runAudit, verifyAudit } from './index.mjs';

function usage() {
  return `Usage:
  frontier-audit run <target> --out <dir> [--name NAME] [--shape auto|machine|orchestrator]
                     [--sign-key private-jwk.json --did-json did.json] [--subject did:web:...]
                     [--principal did:web:...]
                     [--verifier-independence same_principal|separate_principal|third_party]
  frontier-audit verify --evidence evidence.json --aar aar.json --did-json did.json

Local-only static audit. The CLI does not install dependencies, fetch DID documents,
or run live chaos/replay checks. Signing is detached and requires operator-provided
private key and DID JSON paths. Verification recomputes the evidence hash committed
inside the AAR before invoking offline AAR signature verification.`;
}

function parse(argv) {
  const [cmd, maybeTarget, ...rest] = argv;
  if (cmd !== 'run' && cmd !== 'verify') throw new Error(usage());
  const options = { cmd };
  const args = cmd === 'run' ? rest : [maybeTarget, ...rest].filter(Boolean);
  if (cmd === 'run') options.target = maybeTarget;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    if (next === undefined || next.startsWith('--')) throw new Error(`${arg} requires a value`);
    i += 1;
    if (cmd === 'run' && arg === '--out') options.outDir = next;
    else if (cmd === 'run' && arg === '--name') options.name = next;
    else if (cmd === 'run' && arg === '--shape') options.shape = next;
    else if (cmd === 'run' && arg === '--sign-key') options.signKeyPath = next;
    else if (arg === '--did-json') options.didJsonPath = next;
    else if (cmd === 'run' && arg === '--subject') options.subject = next;
    else if (cmd === 'run' && arg === '--principal') options.principal = next;
    else if (cmd === 'run' && arg === '--verifier-independence') options.verifierIndependence = next;
    else if (cmd === 'verify' && arg === '--evidence') options.evidenceJsonPath = next;
    else if (cmd === 'verify' && arg === '--aar') options.aarPath = next;
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

try {
  const options = parse(process.argv.slice(2));
  if (options.cmd === 'verify') {
    const result = verifyAudit(options);
    console.log(`frontier-audit: verified ${result.aar_path}`);
    console.log(`frontier-audit: evidence sha256 ${result.evidence_sha256}`);
  } else {
    const result = runAudit(options);
    console.log(`frontier-audit: wrote ${result.evidenceJsonPath}`);
    console.log(`frontier-audit: wrote ${result.markdownPath}`);
    if (result.signing) {
      console.log(`frontier-audit: signed ${result.signing.aar_path}`);
      console.log('frontier-audit: verified detached AAR signature with provided DID JSON');
    }
  }
} catch (error) {
  console.error(`frontier-audit: ${error.message}`);
  process.exit(1);
}
