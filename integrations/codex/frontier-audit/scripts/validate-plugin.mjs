#!/usr/bin/env node

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

function fail(message) {
  errors.push(message);
}

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

function requireFile(relative) {
  if (!fs.existsSync(path.join(root, relative))) fail(`missing ${relative}`);
}

for (const relative of [
  '.codex-plugin/plugin.json',
  'LICENSE',
  'README.md',
  'assets/frontier-audit.svg',
  'assets/sdk-lock.json',
  'evals/README.md',
  'evals/reviewer-cases.jsonl',
  'evals/results/reviewer-results.json',
  'evals/run-evals.mjs',
  'scripts/bootstrap-sdk.mjs',
  'skills/audit-and-attest/SKILL.md',
  'skills/audit-and-attest/agents/openai.yaml',
  'tests/bootstrap-sdk.test.mjs',
]) requireFile(relative);

const manifest = readJson('.codex-plugin/plugin.json');
if (manifest.name !== 'frontier-audit') fail('manifest name must be frontier-audit');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
  fail('manifest version must be strict semver');
}
if (manifest.skills !== './skills/') fail('manifest skills must be ./skills/');
if (manifest.interface?.composerIcon !== './assets/frontier-audit.svg') fail('manifest composerIcon must use bundled brand asset');
if (manifest.interface?.logo !== './assets/frontier-audit.svg') fail('manifest logo must use bundled brand asset');
if ((manifest.interface?.shortDescription?.length ?? 0) > 30) fail('manifest shortDescription must be 30 characters or fewer');
const logoHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'assets/frontier-audit.svg'))).digest('hex');
if (logoHash !== '757880c103954dac78a65d600d5b07d3ca0e8ca948fb21b95a6170f218c04041') {
  fail('plugin icon must use the canonical Frontier Infra bridge mark');
}

const lock = readJson('assets/sdk-lock.json');
if (lock.schema_version !== 'frontier.audit.sdk-lock.v1') fail('sdk lock schema version mismatch');
if (lock.state !== 'release-candidate') fail('sdk lock must record release-candidate state');
if (lock.package?.name !== '@frontier-infra/audit') fail('sdk lock package name mismatch');
if (lock.package?.version !== '0.1.0-rc.1') fail('sdk lock package version mismatch');
if (lock.package?.integrity !== null) fail('release-candidate lock must not fake published integrity');
if (lock.install?.default_source !== 'bundle') fail('sdk install default source must be bundled artifact');
if (!Array.isArray(lock.install?.allowed_sources) || !lock.install.allowed_sources.includes('registry')) {
  fail('sdk lock must preserve explicit registry source lane');
}
if (lock.install?.bundled_artifact?.relative_path !== 'assets/frontier-infra-audit-0.1.0-rc.1.tgz') {
  fail('sdk lock must pin bundled artifact relative path');
}
if (lock.install?.bundled_artifact?.sha256 !== '646ed1e7dfa9c5e74336a30f7989fc9b866dc84606aece2c98299909436effca') {
  fail('sdk lock must pin bundled artifact sha256');
}
if (lock.install?.bundled_artifact?.relative_path) {
  const artifactPath = path.join(root, lock.install.bundled_artifact.relative_path);
  if (!fs.existsSync(artifactPath)) fail(`missing bundled SDK artifact ${lock.install.bundled_artifact.relative_path}`);
  else {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');
    if (actual !== lock.install.bundled_artifact.sha256) fail(`bundled SDK artifact hash mismatch: ${actual}`);
  }
}
if (lock.install?.requires_explicit_authorization !== true) fail('sdk install must require explicit authorization');
if (lock.install?.network_requires_allow_network !== true) fail('sdk install must require explicit network authorization');
if (lock.signing?.key_input !== 'local-path-only') fail('signing key input must be local-path-only');

const skill = fs.readFileSync(path.join(root, 'skills/audit-and-attest/SKILL.md'), 'utf8');
if (skill.includes('[TODO')) fail('skill must not contain TODO placeholders');
if (!skill.includes('PLUGIN_ROOT="$(cd "$(dirname "$SKILL_MD")/../.." && pwd)"')) {
  fail('skill must resolve plugin root from installed SKILL.md location');
}
if (!skill.includes('TARGET_REPO="$(pwd)"')) fail('skill must keep target repository separate from plugin root');
if (!skill.includes('node "$PLUGIN_ROOT/scripts/bootstrap-sdk.mjs" inspect')) fail('skill must require absolute bootstrap inspection first');
if (!skill.includes('ensure-run')) fail('skill must use install+resume command after approved install');
if (!skill.includes('bundled artifact by default')) fail('skill must document bundled artifact default install');
if (!skill.includes('Pass it to the SDK as `--sign-key <path>`')) fail('skill must align signing key flag with SDK --sign-key');

const evalCases = fs.readFileSync(path.join(root, 'evals/reviewer-cases.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.trim() && !line.trim().startsWith('#'))
  .map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      fail(`eval case line ${index + 1} is invalid JSON: ${error.message}`);
      return {};
    }
  });
if (evalCases.length < 8) fail('marketplace reviewer evals must include at least 8 cases');
const evalResults = readJson('evals/results/reviewer-results.json');
if (evalResults.summary?.total !== evalCases.length) fail('recorded eval total must match reviewer case count');
if (evalResults.summary?.failed !== 0 || evalResults.summary?.passed !== evalCases.length) {
  fail('all recorded marketplace reviewer evals must pass');
}
if (evalResults.release_artifact?.sha256 !== lock.install?.bundled_artifact?.sha256) {
  fail('recorded eval artifact hash must match the bundled SDK lock');
}
for (const testCase of evalCases) {
  if (!evalResults.cases?.some((entry) => entry.id === testCase.id && entry.status === 'PASS')) {
    fail(`recorded eval result missing PASS for ${testCase.id}`);
  }
}
for (const required of [
  'skill activation',
  'arbitrary cwd',
  'missing SDK bootstrap',
  'explicit install authorization',
  'tarball hash mismatch',
  'registry blocked when integrity null',
  'inline key rejection',
  'successful signed audit/verification',
  'no Machine-L3/full-conformance claim while live rows are NOT_RUN',
]) {
  if (!evalCases.some((entry) => Array.isArray(entry.covers) && entry.covers.includes(required))) {
    fail(`marketplace reviewer evals must cover ${required}`);
  }
}

for (const relative of ['scripts/bootstrap-sdk.mjs', 'scripts/validate-plugin.mjs', 'tests/bootstrap-sdk.test.mjs', 'evals/run-evals.mjs']) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, relative)], { encoding: 'utf8' });
  if (result.status !== 0) fail(`${relative} failed node --check: ${result.stderr || result.stdout}`);
}

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`- ${error}\n`);
  process.exit(1);
}

process.stdout.write('frontier-audit plugin validation passed\n');
