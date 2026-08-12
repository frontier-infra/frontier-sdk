#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseConfigPath = path.join(sdkRoot, 'config/release-packages.json');
const releaseConfig = JSON.parse(fs.readFileSync(releaseConfigPath, 'utf8'));

function fail(message) {
  console.error(message);
  process.exit(1);
}

const formatArg = process.argv.find((arg) => arg.startsWith('--format='));
const format = formatArg ? formatArg.slice('--format='.length) : 'tsv';
if (!['json', 'tsv'].includes(format)) {
  fail('Usage: node scripts/release-publish-list.mjs [--format=json|tsv]');
}

const seenNames = new Set();
const seenPaths = new Set();
const publishable = [];
for (const entry of releaseConfig.packages) {
  if (!entry?.name || !entry?.path) fail('Release package entries must include name and path.');
  if (seenNames.has(entry.name)) fail(`Duplicate release package name: ${entry.name}`);
  if (seenPaths.has(entry.path)) fail(`Duplicate release package path: ${entry.path}`);
  seenNames.add(entry.name);
  seenPaths.add(entry.path);

  const packageJsonPath = path.join(sdkRoot, entry.path, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  if (packageJson.name !== entry.name) {
    fail(`${entry.path}: expected package ${entry.name}, found ${packageJson.name}`);
  }
  if (entry.publish_enabled === true) {
    if (typeof entry.dist_tag !== 'string' || !/^[a-z][a-z0-9._-]*$/.test(entry.dist_tag)) {
      fail(`${entry.name}: publish-enabled packages require a valid dist_tag.`);
    }
    publishable.push({
      name: entry.name,
      path: entry.path,
      version: packageJson.version,
      dist_tag: entry.dist_tag,
    });
  }
}

if (format === 'json') {
  process.stdout.write(`${JSON.stringify(publishable, null, 2)}\n`);
} else {
  process.stdout.write(`${publishable.map((entry) => `${entry.path}\t${entry.name}\t${entry.version}\t${entry.dist_tag}`).join('\n')}\n`);
}
