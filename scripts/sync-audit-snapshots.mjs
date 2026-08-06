#!/usr/bin/env node

import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const sourceArg = args.find((arg) => arg !== '--check');
if (args.filter((arg) => arg !== '--check').length > 1) {
  console.error('Usage: node scripts/sync-audit-snapshots.mjs [--check] [frontier-infra-root]');
  process.exit(1);
}

const frontierRoot = path.resolve(sdkRoot, sourceArg ?? '..');
const machineRoot = path.join(frontierRoot, 'the-machine');
const aarTool = path.join(frontierRoot, 'agentcontrolplane/tools/aar.mjs');
const generatedRoot = path.join(sdkRoot, 'packages/typescript/audit/assets/generated');
const auditPackage = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'packages/typescript/audit/package.json'), 'utf8'));

for (const required of [path.join(machineRoot, 'kit'), aarTool]) {
  if (!fs.existsSync(required)) {
    console.error(`Missing canonical audit source: ${required}`);
    process.exit(1);
  }
}

const sha256 = (content) => crypto.createHash('sha256').update(content).digest('hex');
const rel = (absolute) => path.relative(sdkRoot, absolute).split(path.sep).join('/');
const generatedFiles = new Map();
const sourceByGenerated = new Map();

function gitProvenance(root, pathScope) {
  const run = (gitArgs) => {
    const result = spawnSync('git', ['-C', root, ...gitArgs], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const commit = run(['rev-parse', 'HEAD']);
  const status = run(['status', '--porcelain=v1', '--', ...pathScope]);
  return {
    commit: commit || null,
    path_scope: pathScope,
    dirty: status === null ? null : status.length > 0,
    status_sha256: status === null ? null : sha256(Buffer.from(status)),
  };
}

function addFile(generatedRelative, sourceAbsolute, transform = (content) => content) {
  const source = fs.readFileSync(sourceAbsolute);
  const generated = transform(source, sha256(source));
  generatedFiles.set(generatedRelative, generated);
  sourceByGenerated.set(generatedRelative, {
    source: path.relative(frontierRoot, sourceAbsolute).split(path.sep).join('/'),
    source_sha256: sha256(source),
  });
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__pycache__') continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(absolute));
    else out.push(absolute);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(absolute));
    else out.push(absolute);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function removeEmptyDirs(root) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirs(path.join(root, entry.name));
  }
  if (root !== generatedRoot && fs.readdirSync(root).length === 0) fs.rmdirSync(root);
}

function assertGeneratedRootIsSafe() {
  const expected = path.join(sdkRoot, 'packages/typescript/audit/assets/generated');
  if (generatedRoot !== expected) {
    throw new Error(`refusing to clean unexpected generated root: ${generatedRoot}`);
  }
}

for (const source of walk(path.join(machineRoot, 'kit'))) {
  const generatedRelative = `the-machine/${path.relative(machineRoot, source).split(path.sep).join('/')}`;
  addFile(generatedRelative, source);
}

addFile('agentcontrolplane/tools/aar.mjs', aarTool);

const adapter = Buffer.from(`#!/usr/bin/env python3
"""Generated adapter for Frontier SDK audit snapshots.

This file contains no scoring semantics. It imports the canonical copied kit and
renders both its current Markdown packet and SDK-friendly JSON representation.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from kit.packet import render_packet, render_score_json
from kit.score import score_repo


def main() -> int:
    parser = argparse.ArgumentParser(prog="frontier-audit-kit-json-adapter")
    parser.add_argument("repo")
    parser.add_argument("--name", default=None)
    parser.add_argument("--shape", choices=["auto", "machine", "orchestrator"], default="auto")
    parser.add_argument("--json-out", required=True)
    parser.add_argument("--markdown-out", required=True)
    args = parser.parse_args()

    score = score_repo(args.repo, args.name, args.shape)
    Path(args.json_out).write_text(render_score_json(score) + "\\n", encoding="utf-8")
    Path(args.markdown_out).write_text(render_packet(score) + "\\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`, 'utf8');
generatedFiles.set('the-machine/kit_json_adapter.py', adapter);
sourceByGenerated.set('the-machine/kit_json_adapter.py', {
  source: 'frontier-sdk:scripts/sync-audit-snapshots.mjs',
  source_sha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))),
});

const files = {};
for (const [generatedRelative, generated] of [...generatedFiles.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const source = sourceByGenerated.get(generatedRelative);
  files[generatedRelative] = {
    generated_sha256: sha256(generated),
    source: source.source,
    source_sha256: source.source_sha256,
  };
}

const lock = Buffer.from(`${JSON.stringify({
  canonical_sources: {
    agentcontrolplane: {
      repository: 'https://github.com/frontier-infra/agentcontrolplane',
      local_path: rel(path.join(frontierRoot, 'agentcontrolplane')),
      ...gitProvenance(path.join(frontierRoot, 'agentcontrolplane'), ['tools/aar.mjs']),
    },
    the_machine: {
      repository: 'https://github.com/frontier-infra/the-machine',
      local_path: rel(machineRoot),
      ...gitProvenance(machineRoot, ['kit']),
    },
  },
  generated_by: 'frontier-sdk/scripts/sync-audit-snapshots.mjs',
  package: '@frontier-infra/audit',
  package_version: auditPackage.version,
  files,
}, null, 2)}\n`, 'utf8');
generatedFiles.set('audit-snapshot-lock.json', lock);

const mismatches = [];
const expectedRelatives = new Set(generatedFiles.keys());
const existingFiles = listFiles(generatedRoot);
const extraFiles = existingFiles
  .map((absolute) => path.relative(generatedRoot, absolute).split(path.sep).join('/'))
  .filter((relative) => !expectedRelatives.has(relative));
if (checkOnly) {
  for (const relative of extraFiles) mismatches.push(`${relative}: unexpected`);
} else if (extraFiles.length) {
  assertGeneratedRootIsSafe();
  for (const relative of extraFiles) fs.unlinkSync(path.join(generatedRoot, relative));
  removeEmptyDirs(generatedRoot);
}

for (const [relative, expected] of generatedFiles) {
  const target = path.join(generatedRoot, relative);
  if (checkOnly) {
    if (!fs.existsSync(target)) {
      mismatches.push(`${relative}: missing`);
    } else if (!fs.readFileSync(target).equals(expected)) {
      mismatches.push(`${relative}: differs from canonical snapshot`);
    }
    continue;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, expected);
}

if (checkOnly && mismatches.length) {
  console.error(`Audit snapshot check failed:\n- ${mismatches.join('\n- ')}`);
  process.exit(1);
}

console.log(checkOnly
  ? `Audit snapshots match ${generatedFiles.size - 1} canonical/generated files.`
  : `Synced ${generatedFiles.size - 1} audit snapshot files into ${generatedRoot}.`);
