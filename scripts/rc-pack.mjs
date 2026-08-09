#!/usr/bin/env node

import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseConfigPath = path.join(sdkRoot, 'config/release-packages.json');
const releaseConfig = JSON.parse(fs.readFileSync(releaseConfigPath, 'utf8'));
const outputArg = process.argv.indexOf('--output');
if (outputArg !== -1 && !process.argv[outputArg + 1]) {
  console.error('Usage: node scripts/rc-pack.mjs [--output <directory>]');
  process.exit(2);
}
const outputRoot = path.resolve(
  sdkRoot,
  outputArg === -1
    ? path.join('dist', releaseConfig.release)
    : process.argv[outputArg + 1],
);

const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function git(args) {
  const result = spawnSync('git', ['-C', sdkRoot, ...args], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function gitPathspec(filePath) {
  const relative = path.relative(sdkRoot, filePath).split(path.sep).join('/');
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative;
}

function sourceStatusIgnoringOutput() {
  const outputPathspec = gitPathspec(outputRoot);
  const args = ['status', '--porcelain=v1', '--untracked-files=all'];
  if (outputPathspec) {
    args.push('--', '.', `:(exclude)${outputPathspec}`, `:(exclude)${outputPathspec}/**`);
  }
  return git(args);
}

const sourceStatus = sourceStatusIgnoringOutput();
if (sourceStatus !== '') {
  fail([
    'Refusing to assemble RC packages from a dirty source tree.',
    'Commit or stash source changes before running rc:pack.',
    sourceStatus ? `Dirty entries:\n${sourceStatus}` : 'Git status was unavailable.',
  ].join('\n'));
}

function discoverPackagePaths() {
  const root = path.join(sdkRoot, 'packages/typescript');
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, 'package.json')))
    .map((entry) => `packages/typescript/${entry.name}`)
    .sort();
}

const configuredPaths = releaseConfig.packages.map((entry) => entry.path).sort();
const discoveredPaths = discoverPackagePaths();
if (JSON.stringify(configuredPaths) !== JSON.stringify(discoveredPaths)) {
  fail(`Release package manifest mismatch.\nConfigured: ${configuredPaths.join(', ')}\nDiscovered: ${discoveredPaths.join(', ')}`);
}

function packPackage(entry, destination) {
  const packageRoot = path.join(sdkRoot, entry.path);
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (packageJson.name !== entry.name) {
    fail(`${entry.path}: expected package ${entry.name}, found ${packageJson.name}`);
  }
  const result = spawnSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', destination], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env, npm_config_update_notifier: 'false' },
  });
  if (result.status !== 0) {
    fail(`${entry.name}: npm pack failed\n${result.stdout}${result.stderr}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    fail(`${entry.name}: npm pack returned invalid JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0].filename) {
    fail(`${entry.name}: npm pack returned an unexpected result`);
  }
  const artifactPath = path.join(destination, parsed[0].filename);
  return {
    name: entry.name,
    version: packageJson.version,
    path: entry.path,
    filename: parsed[0].filename,
    bytes: fs.statSync(artifactPath).size,
    sha256: sha256File(artifactPath),
    publish_enabled: entry.publish_enabled === true,
  };
}

const assemblyOne = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-rc-pack-a.'));
const assemblyTwo = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-rc-pack-b.'));
try {
  const first = releaseConfig.packages.map((entry) => packPackage(entry, assemblyOne));
  const second = releaseConfig.packages.map((entry) => packPackage(entry, assemblyTwo));
  for (let index = 0; index < first.length; index += 1) {
    if (first[index].filename !== second[index].filename || first[index].sha256 !== second[index].sha256) {
      fail(`${first[index].name}: repeated package assembly was not reproducible`);
    }
  }

  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(outputRoot, { recursive: true });
  for (const artifact of first) {
    fs.copyFileSync(path.join(assemblyOne, artifact.filename), path.join(outputRoot, artifact.filename));
  }

  const manifest = {
    schema: 'frontier.foundation.rc-artifacts.v1',
    release: releaseConfig.release,
    source: {
      repository: 'https://github.com/frontier-infra/frontier-sdk',
      commit: git(['rev-parse', 'HEAD']),
      clean: true,
      status_sha256: crypto.createHash('sha256').update(sourceStatus).digest('hex'),
    },
    toolchain: {
      node: process.version,
      npm: spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim(),
    },
    publication_performed: false,
    packages: first,
  };
  fs.writeFileSync(path.join(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(
    path.join(outputRoot, 'SHA256SUMS'),
    `${first.map((artifact) => `${artifact.sha256}  ${artifact.filename}`).join('\n')}\n`,
  );
  console.log(`Assembled ${first.length} reproducible package artifacts in ${path.relative(sdkRoot, outputRoot)}.`);
  console.log('No package was published.');
} finally {
  fs.rmSync(assemblyOne, { recursive: true, force: true });
  fs.rmSync(assemblyTwo, { recursive: true, force: true });
}
