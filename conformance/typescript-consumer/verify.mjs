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
const packagePaths = [
  'packages/typescript/protocol',
  'packages/typescript/harness-kit',
  'packages/typescript/adapters',
  'packages/typescript/governance-react',
  'packages/typescript/create-frontier-app',
  'packages/typescript/audit',
];
const expectedImports = [
  '@frontier-infra/protocol',
  '@frontier-infra/harness-kit',
  '@frontier-infra/harness-kit/chaos-fixtures',
  '@frontier-infra/adapters',
  '@frontier-infra/governance-react',
  '@frontier-infra/create-frontier-app',
  '@frontier-infra/audit',
];

const consumerSource = fs.readFileSync(path.join(fixtureRoot, 'consumer.tsx'), 'utf8');
for (const specifier of expectedImports) {
  assert.match(consumerSource, new RegExp(`from ['"]${specifier.replaceAll('/', '\\/')}['"]`));
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-typescript-consumer.'));
const tarballRoot = path.join(sandbox, 'tarballs');
const consumerRoot = path.join(sandbox, 'consumer');
const npmCache = path.join(sandbox, 'npm-cache');
fs.mkdirSync(tarballRoot);
fs.mkdirSync(consumerRoot);

const env = {
  ...process.env,
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  npm_config_update_notifier: 'false',
  npm_config_cache: npmCache,
};

async function pack(relativePath) {
  const { stdout } = await exec('npm', [
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination', tarballRoot,
  ], { cwd: path.join(sdkRoot, relativePath), env });
  const result = JSON.parse(stdout);
  assert.equal(result.length, 1);
  return path.join(tarballRoot, result[0].filename);
}

try {
  const tarballs = [];
  for (const packagePath of packagePaths) tarballs.push(await pack(packagePath));
  for (const name of ['consumer.tsx', 'react.d.ts', 'tsconfig.json']) {
    fs.copyFileSync(path.join(fixtureRoot, name), path.join(consumerRoot, name));
  }
  fs.writeFileSync(path.join(consumerRoot, 'package.json'), `${JSON.stringify({
    name: 'frontier-packed-typescript-consumer',
    private: true,
    type: 'module',
  }, null, 2)}\n`);

  await exec('npm', [
    'install',
    '--offline',
    '--legacy-peer-deps',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    ...tarballs,
  ], { cwd: consumerRoot, env });
  const { stdout, stderr } = await exec('npm', [
    'exec',
    '--yes',
    '--package=typescript@5.9.3',
    '--',
    'tsc',
    '-p',
    'tsconfig.json',
    '--noEmit',
  ], { cwd: consumerRoot, env });
  assert.equal(stderr, '');
  process.stdout.write(stdout);
  console.log(`Packed strict TypeScript consumer passed for ${packagePaths.length} packages and ${expectedImports.length} public imports.`);
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
