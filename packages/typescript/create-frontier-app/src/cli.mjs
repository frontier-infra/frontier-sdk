#!/usr/bin/env node

import process from 'node:process';

import { formatNextSteps, scaffoldProject } from './index.mjs';

function usage() {
  return `Usage:
  create-frontier-app <target-dir>

Scaffolds a governed-worker React/Vite app with a Node harness server.
The target directory must be inside the current working directory and empty
when it already exists. Existing files are never overwritten.`;
}

function parse(argv) {
  const [targetDir, ...rest] = argv;
  if (!targetDir || targetDir === '--help' || targetDir === '-h') throw new Error(usage());
  if (rest.length > 0) throw new Error(`unexpected argument: ${rest[0]}`);
  return { targetDir };
}

try {
  const options = parse(process.argv.slice(2));
  const result = scaffoldProject(options.targetDir);
  console.log(`create-frontier-app: created ${result.targetDir}`);
  console.log(formatNextSteps(result));
} catch (error) {
  console.error(`create-frontier-app: ${error.message}`);
  process.exit(1);
}
