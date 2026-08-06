#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const evalRoot = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(evalRoot, '..');
const bootstrap = path.join(pluginRoot, 'scripts/bootstrap-sdk.mjs');
const casesPath = path.join(evalRoot, 'reviewer-cases.jsonl');
const bundledArtifactRelative = 'assets/frontier-infra-audit-0.1.0-rc.1.tgz';
const bundledArtifactHash = '646ed1e7dfa9c5e74336a30f7989fc9b866dc84606aece2c98299909436effca';

const outputRoot = path.resolve(process.env.FRONTIER_AUDIT_EVAL_OUT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-audit-evals-')));
fs.mkdirSync(outputRoot, { recursive: true });

function readCases() {
  return fs.readFileSync(casesPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('#'))
    .map((line) => JSON.parse(line));
}

function tempDir(label) {
  return fs.mkdtempSync(path.join(outputRoot, `${label}-`));
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? pluginRoot,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  return result;
}

function runBootstrap(args, options = {}) {
  return run(process.execPath, [bootstrap, ...args], options);
}

function parseJsonStdout(result) {
  const text = result.stdout.trim();
  assert.notEqual(text, '', 'expected JSON stdout');
  return JSON.parse(text);
}

function writeSdkFixture(directory, version = '0.1.0-rc.1') {
  fs.mkdirSync(path.join(directory, 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    `${JSON.stringify({
      name: '@frontier-infra/audit',
      version,
      type: 'module',
      bin: { 'frontier-audit': './bin/frontier-audit.mjs' },
    }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(directory, 'bin/frontier-audit.mjs'),
    '#!/usr/bin/env node\nconsole.log(JSON.stringify({fixture:"frontier audit",cwd:process.cwd(),argv:process.argv.slice(2)}));\n',
    { mode: 0o755 },
  );
}

function makeFixtureTarball() {
  const fixture = tempDir('fixture-sdk');
  writeSdkFixture(fixture);
  const packDestination = tempDir('fixture-pack');
  const packed = run('npm', ['pack', fixture, '--pack-destination', packDestination]);
  assert.equal(packed.status, 0, packed.stderr);
  const filename = packed.stdout.trim().split('\n').at(-1);
  const tarball = path.join(packDestination, filename);
  assert.equal(fs.existsSync(tarball), true);
  return { tarball, hash: sha256(tarball) };
}

function cacheInstallRoot(cacheRoot) {
  return path.join(cacheRoot, 'install');
}

function makeAuditedTarget() {
  const root = tempDir('real-target');
  assert.equal(run('git', ['init'], { cwd: root }).status, 0);
  assert.equal(run('git', ['config', 'user.email', 'audit@example.test'], { cwd: root }).status, 0);
  assert.equal(run('git', ['config', 'user.name', 'Frontier Audit Eval'], { cwd: root }).status, 0);
  write(path.join(root, 'driver.py'), `
import os
proposed_by = "planner"
ratified_by = "reviewer"
acceptance_tests = ["fixture completes"]
worker_cmd = "python worker.py"
os.replace("goal.tmp", "goal.json")
while True:
    break
`);
  assert.equal(run('git', ['add', 'driver.py'], { cwd: root }).status, 0);
  const committed = run('git', ['commit', '-m', 'Create portable Machine-L2 audit fixture'], { cwd: root });
  assert.equal(committed.status, 0, committed.stderr);
  return root;
}

function makeDidKeyPair(directory) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privateKeyPath = path.join(directory, 'signing.jwk.json');
  const didJsonPath = path.join(directory, 'did.json');
  const did = 'did:web:frontier-audit.eval';
  write(privateKeyPath, `${JSON.stringify(privateKey.export({ format: 'jwk' }), null, 2)}\n`);
  write(didJsonPath, `${JSON.stringify({
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/jws-2020/v1'],
    id: did,
    verificationMethod: [{
      id: `${did}#key-1`,
      type: 'JsonWebKey2020',
      controller: did,
      publicKeyJwk: publicKey.export({ format: 'jwk' }),
    }],
    assertionMethod: [`${did}#key-1`],
  }, null, 2)}\n`);
  return { privateKeyPath, didJsonPath };
}

function seedReadyFixtureInstall(installRoot) {
  const cacheRoot = path.dirname(installRoot);
  const project = tempDir('seed-ready-project');
  const { tarball, hash } = makeFixtureTarball();
  const result = runBootstrap([
    'install',
    '--project-root',
    project,
    '--cache-root',
    cacheRoot,
    '--approve-install',
    '--tarball',
    tarball,
    '--expected-sha256',
    hash,
    '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(parseJsonStdout(result).status, 'ready');
}

function packRealSdk() {
  const explicitTarball = process.env.FRONTIER_AUDIT_SDK_TARBALL;
  if (explicitTarball) {
    const tarball = path.resolve(explicitTarball);
    assert.equal(fs.existsSync(tarball), true, `FRONTIER_AUDIT_SDK_TARBALL not found: ${tarball}`);
    return { tarball, hash: process.env.FRONTIER_AUDIT_SDK_SHA256 ?? sha256(tarball), source: 'env', useDefaultBundle: false };
  }

  if (process.env.FRONTIER_AUDIT_SDK_REPO) {
    const sdkRepo = path.resolve(process.env.FRONTIER_AUDIT_SDK_REPO);
    assert.equal(fs.existsSync(path.join(sdkRepo, 'package.json')), true, `SDK repo not found: ${sdkRepo}`);
    const packDestination = tempDir('real-sdk-pack');
    const packed = run('npm', ['pack', '--workspace', '@frontier-infra/audit', '--pack-destination', packDestination], { cwd: sdkRepo });
    assert.equal(packed.status, 0, packed.stderr);
    const filename = packed.stdout.trim().split('\n').at(-1);
    const tarball = path.join(packDestination, filename);
    assert.equal(fs.existsSync(tarball), true);
    return { tarball, hash: sha256(tarball), source: sdkRepo, useDefaultBundle: false };
  }

  const tarball = path.join(pluginRoot, bundledArtifactRelative);
  assert.equal(fs.existsSync(tarball), true, `bundled SDK artifact not found: ${tarball}`);
  assert.equal(sha256(tarball), bundledArtifactHash, 'bundled SDK artifact hash must match sdk-lock.json');
  return { tarball, hash: bundledArtifactHash, source: 'bundled artifact', useDefaultBundle: true };
}

function ensureRealSignedAudit(context) {
  if (context.realAudit) return context.realAudit;

  const targetRepo = process.env.FRONTIER_AUDIT_TARGET_REPO
    ? path.resolve(process.env.FRONTIER_AUDIT_TARGET_REPO)
    : makeAuditedTarget();
  assert.equal(fs.existsSync(path.join(targetRepo, '.git')), true, `target repo must be a git repo: ${targetRepo}`);

  const { tarball, hash, source, useDefaultBundle } = packRealSdk();
  const cache = tempDir('real-cache');
  const out = tempDir('real-evidence');
  const keys = tempDir('real-keys');
  const { privateKeyPath: privateKey, didJsonPath: didJson } = makeDidKeyPair(keys);

  const audit = runBootstrap([
    'ensure-run',
    '--project-root',
    targetRepo,
    '--cache-root',
    cache,
    '--approve-install',
    ...(useDefaultBundle ? [] : ['--tarball', tarball, '--expected-sha256', hash]),
    '--',
    'run',
    targetRepo,
    '--out',
    out,
    '--shape',
    'machine',
    '--sign-key',
    privateKey,
    '--did-json',
    didJson,
  ]);
  assert.equal(audit.status, 0, audit.stderr);

  const evidenceJson = path.join(out, 'evidence.json');
  const aarJson = path.join(out, 'aar.json');
  assert.equal(fs.existsSync(evidenceJson), true, 'signed audit should write evidence.json');
  assert.equal(fs.existsSync(aarJson), true, 'signed audit should write aar.json');

  const verify = runBootstrap([
    'run',
    '--project-root',
    targetRepo,
    '--cache-root',
    cache,
    '--',
    'verify',
    '--evidence',
    evidenceJson,
    '--aar',
    aarJson,
    '--did-json',
    didJson,
  ]);
  assert.equal(verify.status, 0, verify.stderr);
  assert.match(verify.stdout, /frontier-audit: verified/);

  context.realAudit = {
    source,
    tarball,
    hash,
    cache,
    out,
    targetRepo,
    evidenceJson,
    aarJson,
    didJson,
    audit_stdout: audit.stdout,
    verify_stdout: verify.stdout,
  };
  return context.realAudit;
}

const evaluators = {
  skill_activation_contract() {
    const skill = fs.readFileSync(path.join(pluginRoot, 'skills/audit-and-attest/SKILL.md'), 'utf8');
    assert.match(skill, /^name: audit-and-attest/m);
    assert.match(skill, /node "\$PLUGIN_ROOT\/scripts\/bootstrap-sdk\.mjs" inspect/);
    assert.match(skill, /ensure-run/);
    return { proof: 'SKILL.md routes audits through inspect, then run or ensure-run.' };
  },

  arbitrary_cwd_keeps_target_repo_separate() {
    const project = tempDir('target-arbitrary');
    const cache = tempDir('cache-arbitrary');
    const cwd = tempDir('cwd-arbitrary');
    const result = runBootstrap(['inspect', '--project-root', project, '--cache-root', cache, '--json'], { cwd });
    const report = parseJsonStdout(result);
    assert.equal(result.status, 2);
    assert.equal(report.action.target_repo, project);
    assert.equal(report.action.location, cacheInstallRoot(cache));
    assert.equal(fs.existsSync(path.join(cwd, 'node_modules')), false);
    return { proof: { target_repo: report.action.target_repo, install_location: report.action.location } };
  },

  missing_sdk_reports_install_action() {
    const project = tempDir('missing-target');
    const cache = tempDir('missing-cache');
    const result = runBootstrap(['inspect', '--project-root', project, '--cache-root', cache, '--json']);
    const report = parseJsonStdout(result);
    assert.equal(result.status, 2);
    assert.equal(report.status, 'missing');
    assert.equal(report.action.package, '@frontier-infra/audit');
    assert.equal(report.action.version, '0.1.0-rc.1');
    assert.equal(report.action.source_type, 'bundle');
    assert.equal(report.action.bundled_artifact.relative_path, bundledArtifactRelative);
    assert.equal(report.action.bundled_artifact.sha256, bundledArtifactHash);
    return { proof: report.action };
  },

  install_requires_explicit_authorization() {
    const project = tempDir('auth-target');
    const cache = tempDir('auth-cache');
    const { tarball, hash } = makeFixtureTarball();
    const result = runBootstrap([
      'install',
      '--project-root',
      project,
      '--cache-root',
      cache,
      '--tarball',
      tarball,
      '--expected-sha256',
      hash,
      '--json',
    ]);
    const report = parseJsonStdout(result);
    assert.equal(result.status, 3);
    assert.equal(report.status, 'approval_required');
    assert.equal(fs.existsSync(path.join(cacheInstallRoot(cache), 'node_modules')), false);
    return { proof: { status: report.status, install_tree_exists: false } };
  },

  approved_local_tarball_installs_and_records_provenance() {
    const project = tempDir('approved-target');
    const cache = tempDir('approved-cache');
    const { tarball, hash } = makeFixtureTarball();
    const install = runBootstrap([
      'install',
      '--project-root',
      project,
      '--cache-root',
      cache,
      '--approve-install',
      '--tarball',
      tarball,
      '--expected-sha256',
      hash,
      '--json',
    ]);
    assert.equal(install.status, 0, install.stderr);
    const resolve = runBootstrap(['resolve', '--project-root', project, '--cache-root', cache, '--json']);
    const report = parseJsonStdout(resolve);
    assert.equal(resolve.status, 0);
    assert.equal(report.status, 'ready');
    assert.equal(report.provenance.source.sha256, hash);
    return { proof: { status: report.status, provenance_sha256: report.provenance.source.sha256 } };
  },

  ensure_run_installs_and_executes_sdk() {
    const project = tempDir('ensure-target');
    const cache = tempDir('ensure-cache');
    const { tarball, hash } = makeFixtureTarball();
    const result = runBootstrap([
      'ensure-run',
      '--project-root',
      project,
      '--cache-root',
      cache,
      '--approve-install',
      '--tarball',
      tarball,
      '--expected-sha256',
      hash,
      '--',
      'audit',
      '--format',
      'json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const executed = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(executed.cwd, fs.realpathSync(project));
    assert.deepEqual(executed.argv, ['audit', '--format', 'json']);
    return { proof: executed };
  },

  tarball_hash_mismatch_blocks_install() {
    const project = tempDir('hash-target');
    const cache = tempDir('hash-cache');
    const { tarball } = makeFixtureTarball();
    const result = runBootstrap([
      'install',
      '--project-root',
      project,
      '--cache-root',
      cache,
      '--approve-install',
      '--tarball',
      tarball,
      '--expected-sha256',
      '0'.repeat(64),
      '--json',
    ]);
    const report = parseJsonStdout(result);
    assert.equal(result.status, 6);
    assert.equal(report.status, 'hash_mismatch');
    assert.equal(fs.existsSync(path.join(cacheInstallRoot(cache), 'node_modules')), false);
    return { proof: { status: report.status, install_tree_exists: false } };
  },

  registry_blocked_when_integrity_null() {
    const project = tempDir('registry-target');
    const cache = tempDir('registry-cache');
    const result = runBootstrap([
      'install',
      '--project-root',
      project,
      '--cache-root',
      cache,
      '--source',
      'registry',
      '--approve-install',
      '--allow-network',
      '--json',
    ]);
    const report = parseJsonStdout(result);
    assert.equal(result.status, 7);
    assert.equal(report.status, 'registry_integrity_unavailable');
    assert.match(report.reason, /published package integrity/);
    assert.equal(fs.existsSync(path.join(cacheInstallRoot(cache), 'node_modules')), false);
    return { proof: { status: report.status, reason: report.reason } };
  },

  inline_signing_key_rejected() {
    const project = tempDir('inline-key-target');
    const cache = tempDir('inline-key-cache');
    seedReadyFixtureInstall(cacheInstallRoot(cache));
    const result = runBootstrap([
      'run',
      '--project-root',
      project,
      '--cache-root',
      cache,
      '--',
      'audit',
      '--sign-key',
      '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
    ]);
    assert.equal(result.status, 64);
    assert.match(result.stderr, /local file path/);
    return { proof: { status: result.status, stderr: result.stderr.trim() } };
  },

  successful_signed_audit_verifies(context) {
    const audit = ensureRealSignedAudit(context);
    return {
      proof: {
        sdk_source: audit.source,
        evidence_json: audit.evidenceJson,
        aar_json: audit.aarJson,
        verify: audit.verify_stdout.trim().split('\n').at(0),
      },
    };
  },

  static_audit_does_not_claim_machine_l3(context) {
    const audit = ensureRealSignedAudit(context);
    const evidence = JSON.parse(fs.readFileSync(audit.evidenceJson, 'utf8'));
    assert.equal(evidence.static_score.full_conformance_claimed, false);
    assert.equal(evidence.static_score.live_checks_executed, false);
    assert.ok(Array.isArray(evidence.live_checks));
    assert.ok(evidence.live_checks.some((check) => check.status === 'NOT_RUN'));
    assert.ok(evidence.static_score.static_candidate_level < 3);
    assert.doesNotMatch(evidence.static_score.static_candidate_level_name, /^Machine-L3\b/);
    return {
      proof: {
        static_candidate_level_name: evidence.static_score.static_candidate_level_name,
        full_conformance_claimed: evidence.static_score.full_conformance_claimed,
        live_checks_executed: evidence.static_score.live_checks_executed,
        not_run_live_checks: evidence.live_checks.filter((check) => check.status === 'NOT_RUN').length,
      },
    };
  },
};

const context = {};
const results = [];

for (const testCase of readCases()) {
  const started = Date.now();
  try {
    const evaluator = evaluators[testCase.id];
    assert.equal(typeof evaluator, 'function', `no evaluator for ${testCase.id}`);
    const detail = evaluator(context);
    results.push({
      id: testCase.id,
      kind: testCase.kind,
      status: 'PASS',
      duration_ms: Date.now() - started,
      proof: detail.proof,
    });
    process.stdout.write(`PASS ${testCase.id}\n`);
  } catch (error) {
    results.push({
      id: testCase.id,
      kind: testCase.kind,
      status: 'FAIL',
      duration_ms: Date.now() - started,
      error: error.stack ?? error.message,
    });
    process.stdout.write(`FAIL ${testCase.id}: ${error.message}\n`);
  }
}

const report = {
  schema_version: 'frontier.audit.plugin-eval-report.v1',
  plugin: 'frontier-audit',
  generated_at: new Date().toISOString(),
  output_root: outputRoot,
  cases: results,
  summary: {
    total: results.length,
    passed: results.filter((entry) => entry.status === 'PASS').length,
    failed: results.filter((entry) => entry.status === 'FAIL').length,
  },
};

const reportPath = path.join(outputRoot, 'frontier-audit-eval-report.json');
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`report ${reportPath}\n`);

if (report.summary.failed > 0) process.exit(1);
