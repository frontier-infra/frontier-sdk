#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const sdkRoot = path.resolve(fixtureRoot, '../..');
const sourcePath = path.join(fixtureRoot, 'consumer.mjs');
const source = fs.readFileSync(sourcePath, 'utf8');

const importSpecifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
assert.ok(importSpecifiers.includes('@frontier-infra/harness-kit'));
assert.equal(importSpecifiers.some((specifier) => specifier.startsWith('.') || specifier.includes('/src/')), false);
assert.equal(importSpecifiers.some((specifier) => specifier.startsWith('@frontier-infra/') && specifier !== '@frontier-infra/harness-kit'), false);
assert.doesNotMatch(source, /packages\/typescript|frontier-sdk|conductor|shelvie|atera|quickbooks|titanium/i);

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-second-consumer-install.'));
const tarballs = path.join(sandbox, 'tarballs');
const consumer = path.join(sandbox, 'consumer');
const npmCache = path.join(sandbox, 'npm-cache');
fs.mkdirSync(tarballs);
fs.mkdirSync(consumer);

const env = {
  ...process.env,
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  npm_config_update_notifier: 'false',
  npm_config_cache: npmCache,
};

async function pack(packagePath) {
  const { stdout } = await exec('npm', [
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination', tarballs,
  ], { cwd: packagePath, env });
  const result = JSON.parse(stdout);
  assert.equal(result.length, 1);
  return path.join(tarballs, result[0].filename);
}

try {
  const protocolTarball = await pack(path.join(sdkRoot, 'packages/typescript/protocol'));
  const harnessTarball = await pack(path.join(sdkRoot, 'packages/typescript/harness-kit'));
  fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({
    name: 'frontier-second-consumer-black-box',
    private: true,
    type: 'module',
  }, null, 2));
  fs.copyFileSync(sourcePath, path.join(consumer, 'consumer.mjs'));

  await exec('npm', [
    'install',
    '--offline',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    protocolTarball,
    harnessTarball,
  ], { cwd: consumer, env });

  const installedHarness = JSON.parse(fs.readFileSync(
    path.join(consumer, 'node_modules/@frontier-infra/harness-kit/package.json'),
    'utf8',
  ));
  assert.equal(installedHarness.name, '@frontier-infra/harness-kit');
  assert.equal(installedHarness.version, '0.1.0');
  assert.equal(fs.existsSync(path.join(consumer, 'node_modules/@frontier-infra/harness-kit/test')), false);

  const { stdout, stderr } = await exec(process.execPath, ['consumer.mjs'], {
    cwd: consumer,
    env: { ...env, NO_PROXY: '*', no_proxy: '*' },
  });
  assert.equal(stderr, '');
  const proof = JSON.parse(stdout);
  assert.equal(proof.schema_version, 'frontier.harness.second-consumer-proof.v1');
  assert.equal(proof.evidence_class, 'local_offline_synthetic');
  assert.equal(proof.public_import, '@frontier-infra/harness-kit');
  assert.equal(proof.positive.replay_status, 'duplicate');
  assert.deepEqual(proof.adversarial, {
    policy_mismatch: 'rejected',
    proposal_tamper: 'rejected',
    replay: 'duplicate',
    expiry: 'rejected',
    operator_halt: 'rejected',
  });
  assert.equal(proof.external_effects, false);
  assert.equal(proof.publication_performed, false);
  console.log(JSON.stringify({
    verdict: 'PASS',
    installed_package: `${installedHarness.name}@${installedHarness.version}`,
    consumer_imports: importSpecifiers,
    proof,
  }, null, 2));
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
