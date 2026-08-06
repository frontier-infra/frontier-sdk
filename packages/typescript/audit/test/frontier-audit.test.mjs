import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AUDIT_PACKAGE_VERSION } from '../src/index.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdkRoot = path.resolve(packageRoot, '../../..');
const cli = path.join(packageRoot, 'src/cli.mjs');
const aarTool = path.join(packageRoot, 'assets/generated/agentcontrolplane/tools/aar.mjs');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-audit-repo-'));
  run('git', ['init'], { cwd: root });
  run('git', ['config', 'user.email', 'audit@example.test'], { cwd: root });
  run('git', ['config', 'user.name', 'Frontier Audit Test'], { cwd: root });
  write(path.join(root, 'driver.mjs'), `
const proposed_by = 'planner';
const ratified_by = 'independent-verifier';
const acceptance_tests = ['static packet exists'];
const goal = 'goal.json';
const verify_cmd = 'node verify.mjs';
const failClosed = 'fail-closed';
const effective_autonomy = Math.min(1, autonomy_ceiling, verifier_trust);
const rollback_ref = 'git:HEAD';
const operator_override = { override_effect_slo: 10 };
const prev_hash = 'abc123';
const signing_key = 'did:web:example.test';
const deployment_id = 'fixture-deployment';
const scope_id = 'fixture-scope';
const max_worker_runs = 1;
const alert = 'acknowledged';
const idempotency_key = 'fixture';
const max_attempts = 2;
const cost_gate = 'halt';
const mutation_gate = 'single gate';
const last_success_at = new Date().toISOString();
const anomaly_detectors = ['rate', 'dup'];
while (true) { break; }
`);
  run('git', ['add', 'driver.mjs'], { cwd: root });
  run('git', ['commit', '-m', 'Create audit fixture'], { cwd: root });
  return root;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function hasKeyPrefix(value, prefix) {
  if (Array.isArray(value)) return value.some((entry) => hasKeyPrefix(entry, prefix));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => key.startsWith(prefix) || hasKeyPrefix(child, prefix));
}

function makeDidKeyPair(dir) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privatePath = path.join(dir, 'private.jwk.json');
  const didPath = path.join(dir, 'did.json');
  write(privatePath, `${JSON.stringify(privateKey.export({ format: 'jwk' }), null, 2)}\n`);
  write(didPath, `${JSON.stringify({
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/jws-2020/v1'],
    id: 'did:web:audit.example.test',
    verificationMethod: [{
      id: 'did:web:audit.example.test#key-1',
      type: 'JsonWebKey2020',
      controller: 'did:web:audit.example.test',
      publicKeyJwk: publicKey.export({ format: 'jwk' }),
    }],
    assertionMethod: ['did:web:audit.example.test#key-1'],
  }, null, 2)}\n`);
  return { didPath, privatePath };
}

function assertNoAuditArtifacts(dir) {
  for (const name of ['evidence.json', 'evidence.md', 'kit-score.json', 'kit-packet.md', 'aar.json', 'signature.json']) {
    assert.equal(fs.existsSync(path.join(dir, name)), false, `${name} should not exist in ${dir}`);
  }
}

test('frontier-audit emits local JSON and Markdown packets with dirty-tree binding', () => {
  const repo = makeRepo();
  write(path.join(repo, 'scratch.txt'), 'untracked local state\n');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-audit-out-'));

  const result = run(process.execPath, [cli, 'run', repo, '--out', out, '--shape', 'machine', '--name', 'fixture']);
  assert.match(result.stdout, /evidence\.json/);

  const evidence = readJson(path.join(out, 'evidence.json'));
  assert.equal(evidence.schema_version, 'frontier.audit.packet.v1');
  assert.equal(evidence.package.audit_package_version, AUDIT_PACKAGE_VERSION);
  assert.equal(evidence.package.snapshot_lock_sha256, crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(packageRoot, 'assets/generated/audit-snapshot-lock.json'))).digest('hex'));
  assert.equal(evidence.audit.network_actions, 'NOT_RUN');
  assert.equal(evidence.preflight.dirty, true);
  assert.ok(evidence.preflight.commit);
  assert.ok(evidence.preflight.status_entries.some((entry) => entry.includes('scratch.txt')));
  assert.equal(evidence.static_score.schema_version, 'the-machine.conformance.score.v1');
  assert.equal(hasKeyPrefix(evidence.static_score, 'confirmed_'), false);
  assert.equal(evidence.static_score.full_conformance_claimed, false);
  assert.equal(evidence.static_score.live_checks_executed, false);
  assert.ok(evidence.live_checks.length > 0);
  assert.ok(evidence.live_checks.every((check) => check.status === 'NOT_RUN'));
  assert.ok(fs.readFileSync(path.join(out, 'evidence.md'), 'utf8').includes('Canonical kit packet'));
  assert.equal(fs.existsSync(path.join(out, 'aar.json')), false);
});

test('frontier-audit rejects output paths inside the audited repo before creating artifacts', () => {
  const repo = makeRepo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-audit-outside-'));
  const cases = [
    {
      name: 'nested',
      out: path.join(repo, 'audit-out'),
      artifactDir: path.join(repo, 'audit-out'),
    },
    {
      name: 'equal',
      out: repo,
      artifactDir: repo,
    },
  ];

  const symlinkPath = path.join(outside, 'repo-link');
  try {
    fs.symlinkSync(repo, symlinkPath, 'dir');
    cases.push({
      name: 'symlinked',
      out: path.join(symlinkPath, 'audit-out'),
      artifactDir: path.join(repo, 'audit-out'),
    });
  } catch {
    // Some filesystems disallow symlinks; nested/equal still cover the write-before-reject path.
  }

  for (const testCase of cases) {
    const result = run(process.execPath, [
      cli,
      'run',
      repo,
      '--out',
      testCase.out,
      '--shape',
      'machine',
      '--name',
      testCase.name,
    ], { allowFailure: true });
    assert.notEqual(result.status, 0, testCase.name);
    assert.match(result.stderr, /--out must be outside the audited Git repository/, testCase.name);
    assertNoAuditArtifacts(testCase.artifactDir);
    if (testCase.artifactDir !== repo) assert.equal(fs.existsSync(testCase.artifactDir), false, testCase.name);
  }
});

test('frontier-audit signs only with explicit key path and verifies with DID JSON', () => {
  const repo = makeRepo();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-audit-signed-'));
  const keys = makeDidKeyPair(fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-audit-keys-')));

  const result = run(process.execPath, [
    cli,
    'run',
    repo,
    '--out',
    out,
    '--shape',
    'machine',
    '--sign-key',
    keys.privatePath,
    '--did-json',
    keys.didPath,
  ]);
  assert.match(result.stdout, /verified detached AAR signature/);

  const evidence = fs.readFileSync(path.join(out, 'evidence.json'));
  const signature = readJson(path.join(out, 'signature.json'));
  const aar = readJson(path.join(out, 'aar.json'));
  assert.equal(signature.verification.status, 'PASS');
  assert.equal(signature.signed_payload_sha256, crypto.createHash('sha256').update(evidence).digest('hex'));
  assert.equal('key_path' in signature, false);
  assert.equal(JSON.stringify(signature).includes(keys.privatePath), false);
  assert.equal(result.stdout.includes(keys.privatePath), false);
  assert.equal(aar.sig.alg, 'Ed25519');
  assert.equal(aar.principal, 'did:web:audit.example.test');
  assert.equal(aar.verifier.id, aar.principal);
  assert.equal(aar.verifier.model, `@frontier-infra/audit@${AUDIT_PACKAGE_VERSION}`);
  assert.equal(aar.verifier.policy_sha256, readJson(path.join(out, 'evidence.json')).package.snapshot_lock_sha256);
  assert.equal(aar.verifier.independence, 'same_principal');
  assert.match(fs.readFileSync(path.join(out, 'aar-verify.txt'), 'utf8'), /conformance: L2/);
  assert.match(fs.readFileSync(path.join(out, 'aar-verify.txt'), 'utf8'), /organizational independence \(claimed\): same_principal/);

  const verify = run(process.execPath, [
    cli,
    'verify',
    '--evidence',
    path.join(out, 'evidence.json'),
    '--aar',
    path.join(out, 'aar.json'),
    '--did-json',
    keys.didPath,
  ]);
  assert.match(verify.stdout, /evidence sha256/);
});

test('frontier-audit stamps an explicitly disclosed third-party relationship without changing structural L2', () => {
  const repo = makeRepo();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-audit-third-party-'));
  const keys = makeDidKeyPair(fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-audit-keys-')));

  run(process.execPath, [
    cli,
    'run',
    repo,
    '--out',
    out,
    '--shape',
    'machine',
    '--sign-key',
    keys.privatePath,
    '--did-json',
    keys.didPath,
    '--subject',
    'did:web:subject.example.test',
    '--principal',
    'did:web:owner.example.test',
    '--verifier-independence',
    'third_party',
  ]);

  const aar = readJson(path.join(out, 'aar.json'));
  assert.equal(aar.verifier.independence, 'third_party');
  assert.equal(aar.verifier.id, 'did:web:audit.example.test');
  assert.equal(aar.subject, 'did:web:subject.example.test');
  assert.equal(aar.principal, 'did:web:owner.example.test');
  assert.equal(aar.sig.by, aar.verifier.id);
  assert.match(fs.readFileSync(path.join(out, 'aar-verify.txt'), 'utf8'), /organizational independence \(claimed\): third_party/);
});

test('frontier-audit rejects a non-same-principal disclosure without explicit subject and principal identities', () => {
  const repo = makeRepo();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-audit-unbound-independence-'));
  const keys = makeDidKeyPair(fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-audit-keys-')));

  const result = run(process.execPath, [
    cli,
    'run',
    repo,
    '--out',
    out,
    '--shape',
    'machine',
    '--sign-key',
    keys.privatePath,
    '--did-json',
    keys.didPath,
    '--verifier-independence',
    'third_party',
  ], { allowFailure: true });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--subject is required/);
});

test('frontier-audit rejects a signed receipt whose subject is the verifier DID', () => {
  const repo = makeRepo();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-audit-self-verifier-'));
  const keys = makeDidKeyPair(fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-audit-keys-')));

  const result = run(process.execPath, [
    cli,
    'run',
    repo,
    '--out',
    out,
    '--shape',
    'machine',
    '--sign-key',
    keys.privatePath,
    '--did-json',
    keys.didPath,
    '--subject',
    'did:web:audit.example.test',
  ], { allowFailure: true });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--subject must differ from the verifier DID/);
});

test('frontier-audit verify rejects a signed receipt whose scorer identity does not match its evidence', () => {
  const repo = makeRepo();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-audit-scorer-mismatch-'));
  const keys = makeDidKeyPair(fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-audit-keys-')));
  run(process.execPath, [
    cli, 'run', repo, '--out', out, '--shape', 'machine',
    '--sign-key', keys.privatePath, '--did-json', keys.didPath,
  ]);

  const aarPath = path.join(out, 'aar.json');
  const aar = readJson(aarPath);
  aar.verifier.model = '@frontier-infra/audit@0.0.0-wrong';
  aar.verifier.policy_sha256 = '0'.repeat(64);
  fs.writeFileSync(aarPath, `${JSON.stringify(aar, null, 2)}\n`);
  run(process.execPath, [aarTool, 'sign', aarPath, '--priv', keys.privatePath]);

  const verify = run(process.execPath, [
    cli, 'verify', '--evidence', path.join(out, 'evidence.json'),
    '--aar', aarPath, '--did-json', keys.didPath,
  ], { allowFailure: true });
  assert.notEqual(verify.status, 0);
  assert.match(verify.stderr, /AAR verifier model mismatch/);

  aar.verifier.model = `@frontier-infra/audit@${AUDIT_PACKAGE_VERSION}`;
  fs.writeFileSync(aarPath, `${JSON.stringify(aar, null, 2)}\n`);
  run(process.execPath, [aarTool, 'sign', aarPath, '--priv', keys.privatePath]);
  const verifyPolicy = run(process.execPath, [
    cli, 'verify', '--evidence', path.join(out, 'evidence.json'),
    '--aar', aarPath, '--did-json', keys.didPath,
  ], { allowFailure: true });
  assert.notEqual(verifyPolicy.status, 0);
  assert.match(verifyPolicy.stderr, /policy SHA-256 does not match/);
});

test('frontier-audit verify rejects an offline DID document not bound to sig.by', () => {
  const repo = makeRepo();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-audit-did-mismatch-'));
  const keysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-audit-keys-'));
  const keys = makeDidKeyPair(keysDir);
  run(process.execPath, [
    cli, 'run', repo, '--out', out, '--shape', 'machine',
    '--sign-key', keys.privatePath, '--did-json', keys.didPath,
  ]);

  const did = readJson(keys.didPath);
  did.id = 'did:web:wrong.example.test';
  const mismatchedDid = path.join(keysDir, 'wrong-did.json');
  fs.writeFileSync(mismatchedDid, `${JSON.stringify(did, null, 2)}\n`);
  const verify = run(process.execPath, [
    cli, 'verify', '--evidence', path.join(out, 'evidence.json'),
    '--aar', path.join(out, 'aar.json'), '--did-json', mismatchedDid,
  ], { allowFailure: true });
  assert.notEqual(verify.status, 0);
  assert.match(verify.stderr, /does not match sig\.by/);
});

test('frontier-audit verify rejects tampered evidence even when AAR is unchanged', () => {
  const repo = makeRepo();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-audit-tamper-'));
  const keys = makeDidKeyPair(fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-audit-keys-')));
  run(process.execPath, [
    cli,
    'run',
    repo,
    '--out',
    out,
    '--shape',
    'machine',
    '--sign-key',
    keys.privatePath,
    '--did-json',
    keys.didPath,
  ]);

  const evidencePath = path.join(out, 'evidence.json');
  const evidence = readJson(evidencePath);
  evidence.audit.network_actions = 'PASS';
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

  const verify = run(process.execPath, [
    cli,
    'verify',
    '--evidence',
    evidencePath,
    '--aar',
    path.join(out, 'aar.json'),
    '--did-json',
    keys.didPath,
  ], { allowFailure: true });
  assert.notEqual(verify.status, 0);
  assert.match(verify.stderr, /evidence\.json hash mismatch/);
});

test('frontier-audit verifies generated snapshot hashes before execution', () => {
  const snapshot = path.join(packageRoot, 'assets/generated/the-machine/kit/__init__.py');
  const original = fs.readFileSync(snapshot);
  try {
    fs.appendFileSync(snapshot, '\n# tamper\n');
    const repo = makeRepo();
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-audit-snapshot-tamper-'));
    const result = run(process.execPath, [cli, 'run', repo, '--out', out, '--shape', 'machine'], { allowFailure: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /snapshot lock verification failed/);
  } finally {
    fs.writeFileSync(snapshot, original);
  }
});

test('audit snapshots stay in sync with canonical sources', () => {
  run(process.execPath, ['scripts/sync-audit-snapshots.mjs', '--check'], { cwd: sdkRoot });
});

test('audit snapshot check rejects extras and sync removes stale generated files', () => {
  const extra = path.join(packageRoot, 'assets/generated/stale-extra.txt');
  write(extra, 'stale\n');
  try {
    const check = run(process.execPath, ['scripts/sync-audit-snapshots.mjs', '--check'], { cwd: sdkRoot, allowFailure: true });
    assert.notEqual(check.status, 0);
    assert.match(check.stderr, /stale-extra\.txt: unexpected/);

    run(process.execPath, ['scripts/sync-audit-snapshots.mjs'], { cwd: sdkRoot });
    assert.equal(fs.existsSync(extra), false);
    run(process.execPath, ['scripts/sync-audit-snapshots.mjs', '--check'], { cwd: sdkRoot });
  } finally {
    if (fs.existsSync(extra)) fs.unlinkSync(extra);
  }
});
