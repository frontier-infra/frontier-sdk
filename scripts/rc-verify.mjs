#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gates = [
  ['Node package tests', ['run', 'test:node']],
  ['Python protocol tests', ['run', 'test:python']],
  ['Packed TypeScript public consumers', ['run', 'test:types']],
  ['Harness Kit second consumer', ['run', 'test:second-consumer']],
  ['Deterministic chaos corpus', ['run', 'test:chaos']],
  ['Canonical audit snapshots', ['run', 'check:audit']],
  ['Plugin consumer snapshots', ['run', 'check:consumers']],
  ['Reproducible package assembly', ['run', 'rc:pack']],
];

for (const [label, args] of gates) {
  console.log(`\n## ${label}`);
  const result = spawnSync('npm', args, {
    cwd: sdkRoot,
    stdio: 'inherit',
    env: { ...process.env, npm_config_update_notifier: 'false' },
  });
  if (result.status !== 0) {
    console.error(`RC gate failed: ${label}`);
    process.exit(result.status ?? 1);
  }
}

console.log('\nFrontier Foundation RC verification passed. Package publication was not performed.');
