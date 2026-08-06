#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const paths = args.filter((arg) => arg !== '--check');
if (paths.length > 1) {
  console.error('Usage: node scripts/sync-consumers.mjs [--check] [plugin-root]');
  process.exit(1);
}

const pluginRoot = path.resolve(sdkRoot, paths[0] ?? '../plugins/frontier-infra');
if (!fs.existsSync(path.join(pluginRoot, '.codex-plugin/plugin.json'))) {
  console.error(`Not a Frontier Codex plugin root: ${pluginRoot}`);
  process.exit(1);
}

const sha256 = (content) => crypto.createHash('sha256').update(content).digest('hex');
const readSource = (relative) => fs.readFileSync(path.join(sdkRoot, relative));
const generatedFiles = new Map();
const sourceByGenerated = new Map();

function addSnapshot(generatedRelative, sourceRelative, transform = (content) => content) {
  const source = readSource(sourceRelative);
  const generated = transform(source, sha256(source));
  generatedFiles.set(generatedRelative, generated);
  sourceByGenerated.set(generatedRelative, { sourceRelative, sourceSha256: sha256(source) });
}

addSnapshot(
  'assets/generated/runtime-health.mjs',
  'packages/typescript/protocol/src/index.mjs',
  (content, sourceHash) => Buffer.from(
    `// GENERATED SNAPSHOT — do not edit.\n// Canonical source: https://github.com/frontier-infra/frontier-sdk\n// Source SHA-256: ${sourceHash}\n\n${content.toString('utf8')}`,
  ),
);
addSnapshot('assets/runtime-health-contract.schema.json', 'schemas/frontier.machine.health.v1.schema.json');

const fixtureDirectory = path.join(sdkRoot, 'conformance/runtime-health');
for (const fixtureName of fs.readdirSync(fixtureDirectory).filter((name) => name.endsWith('.json')).sort()) {
  addSnapshot(
    `evals/fixtures/runtime-health/${fixtureName}`,
    `conformance/runtime-health/${fixtureName}`,
  );
}

const files = {};
for (const [generatedRelative, generated] of [...generatedFiles.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const source = sourceByGenerated.get(generatedRelative);
  files[generatedRelative] = {
    generated_sha256: sha256(generated),
    source: source.sourceRelative,
    source_sha256: source.sourceSha256,
  };
}
const lock = Buffer.from(`${JSON.stringify({
  canonical_repository: 'https://github.com/frontier-infra/frontier-sdk',
  protocol_package_version: '0.1.0',
  schema_version: 'frontier.machine.health.v1',
  files,
}, null, 2)}\n`);
generatedFiles.set('assets/protocol-lock.json', lock);

const mismatches = [];
for (const [relative, expected] of generatedFiles) {
  const target = path.join(pluginRoot, relative);
  if (checkOnly) {
    if (!fs.existsSync(target)) {
      mismatches.push(`${relative}: missing`);
    } else if (!fs.readFileSync(target).equals(expected)) {
      mismatches.push(`${relative}: differs from canonical SDK snapshot`);
    }
    continue;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, expected);
}

if (checkOnly && mismatches.length) {
  console.error(`Consumer snapshot check failed:\n- ${mismatches.join('\n- ')}`);
  process.exit(1);
}

console.log(checkOnly
  ? `Consumer snapshots match ${generatedFiles.size - 1} canonical files.`
  : `Synced ${generatedFiles.size - 1} canonical files into ${pluginRoot}.`);
