import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bootstrap = path.join(root, 'scripts/bootstrap-sdk.mjs');
const bundledArtifactRelative = 'assets/frontier-infra-audit-0.1.0-rc.1.tgz';
const bundledArtifactHash = '646ed1e7dfa9c5e74336a30f7989fc9b866dc84606aece2c98299909436effca';

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `frontier-audit-${label}-`));
}

function run(args, options = {}) {
  const result = spawnSync(process.execPath, [options.bootstrap ?? bootstrap, ...args], {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
  });
  return {
    ...result,
    json: result.stdout.trim().startsWith('{') ? JSON.parse(result.stdout) : null,
  };
}

function writeSdkFixture(directory, version = '0.1.0-rc.1') {
  fs.mkdirSync(path.join(directory, 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify(
      {
        name: '@frontier-infra/audit',
        version,
        type: 'module',
        bin: {
          'frontier-audit': './bin/frontier-audit.mjs',
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(directory, 'bin/frontier-audit.mjs'),
    '#!/usr/bin/env node\nconsole.log(JSON.stringify({fixture:"frontier audit",cwd:process.cwd(),argv:process.argv.slice(2)}));\n',
    { mode: 0o755 },
  );
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function makeTarball() {
  const fixture = tempDir('pkg');
  writeSdkFixture(fixture);
  const packDestination = tempDir('pack');
  const packed = spawnSync('npm', ['pack', fixture, '--pack-destination', packDestination], {
    encoding: 'utf8',
  });
  assert.equal(packed.status, 0, packed.stderr);
  const filename = packed.stdout.trim().split('\n').at(-1);
  const tarball = path.join(packDestination, filename);
  assert.equal(fs.existsSync(tarball), true);
  return { tarball, hash: sha256(tarball) };
}

function makeGitTarget() {
  const target = tempDir('git-target');
  fs.writeFileSync(path.join(target, 'README.md'), 'frontier audit target\n');
  let result = spawnSync('git', ['init'], { cwd: target, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  result = spawnSync('git', ['add', 'README.md'], { cwd: target, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  result = spawnSync(
    'git',
    ['-c', 'user.name=Frontier Test', '-c', 'user.email=frontier@example.invalid', 'commit', '-m', 'init'],
    { cwd: target, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return target;
}

function copyBootstrapPlugin(label) {
  const copiedRoot = tempDir(label);
  fs.mkdirSync(path.join(copiedRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(copiedRoot, 'assets'), { recursive: true });
  fs.copyFileSync(bootstrap, path.join(copiedRoot, 'scripts/bootstrap-sdk.mjs'));
  fs.copyFileSync(path.join(root, 'assets/sdk-lock.json'), path.join(copiedRoot, 'assets/sdk-lock.json'));
  fs.copyFileSync(path.join(root, bundledArtifactRelative), path.join(copiedRoot, bundledArtifactRelative));
  return { root: copiedRoot, bootstrap: path.join(copiedRoot, 'scripts/bootstrap-sdk.mjs') };
}

function cacheInstallRoot(cacheRoot) {
  return path.join(cacheRoot, 'install');
}

function packageRootForInstall(installRoot) {
  return path.join(installRoot, 'node_modules/@frontier-infra/audit');
}

function projectInstallRoot(projectRoot) {
  return path.join(projectRoot, '.frontier-audit', 'sdk-install');
}

function computePackageTreeManifest(packageDirectory) {
  const files = [];
  const pending = ['.'];
  while (pending.length > 0) {
    const relativeDirectory = pending.pop();
    const absoluteDirectory = path.join(packageDirectory, relativeDirectory);
    const entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = path.posix.join(relativeDirectory === '.' ? '' : relativeDirectory.split(path.sep).join('/'), entry.name);
      const absolutePath = path.join(packageDirectory, relativePath);
      const stat = fs.lstatSync(absolutePath);
      if (stat.isDirectory()) {
        pending.push(relativePath);
      } else if (stat.isFile()) {
        files.push({
          path: relativePath,
          mode: stat.mode & 0o777,
          sha256: sha256(absolutePath),
        });
      }
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const manifest = {
    schema_version: 'frontier.audit.package-tree.v1',
    files,
  };
  return {
    ...manifest,
    root: packageDirectory,
    hash: crypto.createHash('sha256').update(stableJson(manifest)).digest('hex'),
  };
}

function provenancePath(installRoot) {
  return path.join(installRoot, '.frontier-audit/sdk-provenance.json');
}

function readProvenance(installRoot) {
  return JSON.parse(fs.readFileSync(provenancePath(installRoot), 'utf8'));
}

function writeProvenance(installRoot, provenance) {
  fs.writeFileSync(provenancePath(installRoot), `${JSON.stringify(provenance, null, 2)}\n`);
}

function mutateProvenance(installRoot, mutate) {
  const provenance = readProvenance(installRoot);
  mutate(provenance);
  writeProvenance(installRoot, provenance);
}

function seedReadyInstall(installRoot) {
  const cacheRoot = path.dirname(installRoot);
  const project = tempDir('seed-ready-project');
  const { tarball, hash } = makeTarball();
  const result = run([
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
  assert.equal(result.json.status, 'ready');
}

function invalidTarball() {
  const file = path.join(tempDir('invalid-tarball'), 'not-a-package.tgz');
  fs.writeFileSync(file, 'not a tarball');
  return { tarball: file, hash: sha256(file) };
}

function seedRegistryInstall(installRoot) {
  const packageDir = packageRootForInstall(installRoot);
  writeSdkFixture(packageDir);
  fs.mkdirSync(path.join(installRoot, '.frontier-audit'), { recursive: true });
  const lockHash = sha256(path.join(root, 'assets/sdk-lock.json'));
  fs.writeFileSync(
    provenancePath(installRoot),
    JSON.stringify(
      {
        schema_version: 'frontier.audit.sdk-provenance.v2',
        package: { name: '@frontier-infra/audit', version: '0.1.0-rc.1' },
        source: { type: 'npm', registry: 'https://registry.npmjs.org/', spec: '@frontier-infra/audit@0.1.0-rc.1', integrity: null },
        approval: {
          approved: true,
          source_type: 'npm',
          package: '@frontier-infra/audit',
          version: '0.1.0-rc.1',
          integrity: null,
          approved_at: '2026-08-06T00:00:00.000Z',
        },
        package_tree: computePackageTreeManifest(packageDir),
        lock_sha256: lockHash,
        installed_at: '2026-08-06T00:00:00.000Z',
        install_root: installRoot,
        bootstrap: 'scripts/bootstrap-sdk.mjs',
      },
      null,
      2,
    ),
  );
}

describe('bootstrap-sdk', () => {
  test('bundled SDK artifact exists and matches the pinned hash', () => {
    const artifact = path.join(root, bundledArtifactRelative);
    assert.equal(fs.existsSync(artifact), true);
    assert.equal(sha256(artifact), bundledArtifactHash);
  });

  test('inspect reports a present verified SDK as ready', () => {
    const project = tempDir('target-present');
    const cache = tempDir('cache-present');
    seedReadyInstall(cacheInstallRoot(cache));
    const result = run(['inspect', '--project-root', project, '--cache-root', cache, '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.status, 'ready');
    assert.equal(result.json.installed.version, '0.1.0-rc.1');
    assert.equal(result.json.signing.status, 'NOT_RUN');
    assert.equal(result.json.install_root, cacheInstallRoot(cache));
    assert.notEqual(result.json.install_root, project);
  });

  test('inspect reports missing SDK without installing or using network', () => {
    const project = tempDir('missing');
    const cache = tempDir('cache-missing');
    const result = run(['inspect', '--project-root', project, '--cache-root', cache, '--json']);
    assert.equal(result.status, 2);
    assert.equal(result.json.status, 'missing');
    assert.match(result.json.action.required, /Request explicit install authorization/);
    assert.equal(result.json.action.source_type, 'bundle');
    assert.equal(result.json.action.bundled_artifact.relative_path, bundledArtifactRelative);
    assert.equal(result.json.action.bundled_artifact.sha256, bundledArtifactHash);
    assert.equal(fs.existsSync(path.join(project, 'node_modules')), false);
    assert.equal(result.json.action.location, cacheInstallRoot(cache));
  });

  test('default install root is a durable external cache, not the target repo or temp default', () => {
    const project = tempDir('default-cache-target');
    const result = run(['inspect', '--project-root', project, '--json']);
    assert.equal(result.status, 2);
    assert.equal(result.json.location, 'cache');
    assert.notEqual(result.json.action.location, project);
    assert.equal(result.json.action.location.startsWith(os.tmpdir()), false);
  });

  test('absolute bootstrap path works from arbitrary cwd with target repo separate', () => {
    const project = tempDir('target-arbitrary');
    const cache = tempDir('cache-arbitrary');
    const cwd = tempDir('cwd-arbitrary');
    const result = run(['inspect', '--project-root', project, '--cache-root', cache, '--json'], { cwd });
    assert.equal(result.status, 2);
    assert.equal(result.json.status, 'missing');
    assert.equal(result.json.action.target_repo, project);
    assert.equal(result.json.action.location, cacheInstallRoot(cache));
    assert.equal(fs.existsSync(path.join(cwd, 'node_modules')), false);
  });

  test('install declines without explicit approval', () => {
    const project = tempDir('declined');
    const cache = tempDir('cache-declined');
    const { tarball, hash } = makeTarball();
    const result = run([
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
    assert.equal(result.status, 3);
    assert.equal(result.json.status, 'approval_required');
    assert.equal(fs.existsSync(path.join(project, 'node_modules')), false);
    assert.equal(fs.existsSync(path.join(cacheInstallRoot(cache), 'node_modules')), false);
  });

  test('approved local tarball install records provenance and resolves', () => {
    const project = tempDir('approved');
    const cache = tempDir('cache-approved');
    const { tarball, hash } = makeTarball();
    const install = run([
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
    assert.equal(install.json.status, 'ready');
    assert.equal(fs.existsSync(path.join(cacheInstallRoot(cache), '.frontier-audit/sdk-provenance.json')), true);
    assert.equal(fs.existsSync(path.join(project, 'node_modules')), false);

    const resolve = run(['resolve', '--project-root', project, '--cache-root', cache, '--json']);
    assert.equal(resolve.status, 0, resolve.stderr);
    assert.equal(resolve.json.status, 'ready');
    assert.equal(resolve.json.provenance.source.sha256, hash);
    assert.equal(resolve.json.provenance.schema_version, 'frontier.audit.sdk-provenance.v2');
    assert.equal(resolve.json.provenance.approval.approved, true);
    assert.equal(resolve.json.provenance.approval.sha256, hash);
    assert.equal(resolve.json.provenance.package_tree.schema_version, 'frontier.audit.package-tree.v1');
    assert.match(resolve.json.provenance.package_tree.hash, /^[0-9a-f]{64}$/);
  });

  test('registry provenance is not ready while lock integrity is unpublished', () => {
    const project = tempDir('registry-provenance');
    const cache = tempDir('cache-registry-provenance');
    seedRegistryInstall(cacheInstallRoot(cache));
    const result = run(['inspect', '--project-root', project, '--cache-root', cache, '--json']);
    assert.equal(result.status, 2);
    assert.equal(result.json.status, 'provenance_mismatch');
    assert.match(result.json.provenance_errors.join('\n'), /integrity is unpublished/);
  });

  test('old handwritten provenance schema fails closed', () => {
    const project = tempDir('old-schema');
    const cache = tempDir('cache-old-schema');
    const installRoot = cacheInstallRoot(cache);
    seedReadyInstall(installRoot);
    mutateProvenance(installRoot, (provenance) => {
      provenance.schema_version = 'frontier.audit.sdk-provenance.v1';
    });
    const result = run(['inspect', '--project-root', project, '--cache-root', cache, '--json']);
    assert.equal(result.status, 2);
    assert.equal(result.json.status, 'provenance_mismatch');
    assert.match(result.json.provenance_errors.join('\n'), /schema mismatch/);
  });

  test('malformed provenance JSON reports structured provenance mismatch', () => {
    const project = tempDir('bad-provenance-json');
    const cache = tempDir('cache-bad-provenance-json');
    const installRoot = cacheInstallRoot(cache);
    seedReadyInstall(installRoot);
    fs.writeFileSync(provenancePath(installRoot), '{not json');
    const result = run(['inspect', '--project-root', project, '--cache-root', cache, '--json']);
    assert.equal(result.status, 2);
    assert.equal(result.json.status, 'provenance_mismatch');
    assert.match(result.json.provenance_errors.join('\n'), /provenance JSON parse error/);
  });

  test('malformed package.json reports structured cache corruption', () => {
    const project = tempDir('bad-package-json');
    const cache = tempDir('cache-bad-package-json');
    const installRoot = cacheInstallRoot(cache);
    seedReadyInstall(installRoot);
    fs.writeFileSync(path.join(packageRootForInstall(installRoot), 'package.json'), '{not json');
    const result = run(['inspect', '--project-root', project, '--cache-root', cache, '--json']);
    assert.equal(result.status, 2);
    assert.equal(result.json.status, 'cache_corrupt');
    assert.match(result.json.cache_errors.join('\n'), /package\.json parse error/);
  });

  test('approved ensure-run repairs malformed package JSON from bundled artifact', () => {
    const project = makeGitTarget();
    const cache = tempDir('cache-repair-bad-package');
    const out = tempDir('repair-bad-package-out');
    const installRoot = cacheInstallRoot(cache);
    seedReadyInstall(installRoot);
    fs.writeFileSync(path.join(packageRootForInstall(installRoot), 'package.json'), '{not json');
    const result = run([
      'ensure-run',
      '--project-root',
      project,
      '--cache-root',
      cache,
      '--approve-install',
      '--',
      'run',
      project,
      '--out',
      out,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(out, 'evidence.json')), true);
    const resolve = run(['resolve', '--project-root', project, '--cache-root', cache, '--json']);
    assert.equal(resolve.status, 0, resolve.stderr);
    assert.equal(resolve.json.status, 'ready');
    assert.equal(resolve.json.provenance.source.type, 'bundle');
  });

  test('tarball provenance missing expected_sha256 fails closed', () => {
    const project = tempDir('missing-expected');
    const cache = tempDir('cache-missing-expected');
    const installRoot = cacheInstallRoot(cache);
    seedReadyInstall(installRoot);
    mutateProvenance(installRoot, (provenance) => {
      delete provenance.source.expected_sha256;
    });
    const result = run(['inspect', '--project-root', project, '--cache-root', cache, '--json']);
    assert.equal(result.status, 2);
    assert.equal(result.json.status, 'provenance_mismatch');
    assert.match(result.json.provenance_errors.join('\n'), /missing expected_sha256/);
  });

  test('tarball provenance expected_sha256 mismatch fails closed', () => {
    const project = tempDir('expected-mismatch');
    const cache = tempDir('cache-expected-mismatch');
    const installRoot = cacheInstallRoot(cache);
    seedReadyInstall(installRoot);
    mutateProvenance(installRoot, (provenance) => {
      provenance.source.expected_sha256 = 'different';
    });
    const result = run(['inspect', '--project-root', project, '--cache-root', cache, '--json']);
    assert.equal(result.status, 2);
    assert.equal(result.json.status, 'provenance_mismatch');
    assert.match(result.json.provenance_errors.join('\n'), /expected sha256 mismatch/);
  });

  test('tarball provenance missing explicit approval metadata fails closed', () => {
    const project = tempDir('approval-missing');
    const cache = tempDir('cache-approval-missing');
    const installRoot = cacheInstallRoot(cache);
    seedReadyInstall(installRoot);
    mutateProvenance(installRoot, (provenance) => {
      delete provenance.approval;
    });
    const result = run(['inspect', '--project-root', project, '--cache-root', cache, '--json']);
    assert.equal(result.status, 2);
    assert.equal(result.json.status, 'provenance_mismatch');
    assert.match(result.json.provenance_errors.join('\n'), /approval metadata/);
  });

  test('recorded tarball path does not need to continue existing after install', () => {
    const project = tempDir('path-gone');
    const cache = tempDir('cache-path-gone');
    const { tarball, hash } = makeTarball();
    const install = run([
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
    fs.rmSync(tarball, { force: true });
    const resolve = run(['resolve', '--project-root', project, '--cache-root', cache, '--json']);
    assert.equal(resolve.status, 0, resolve.stderr);
    assert.equal(resolve.json.status, 'ready');
    assert.equal(resolve.json.provenance.source.sha256, hash);
  });

  test('partial cache reports provenance mismatch and approved ensure-run repairs it', () => {
    const project = makeGitTarget();
    const cache = tempDir('cache-partial');
    const installRoot = cacheInstallRoot(cache);
    const packageRoot = packageRootForInstall(installRoot);
    const out = tempDir('partial-out');
    writeSdkFixture(packageRoot);
    const inspect = run(['inspect', '--project-root', project, '--cache-root', cache, '--json']);
    assert.equal(inspect.status, 2);
    assert.equal(inspect.json.status, 'provenance_mismatch');
    assert.match(inspect.json.provenance_errors.join('\n'), /missing bootstrap provenance record/);
    const result = run([
      'ensure-run',
      '--project-root',
      project,
      '--cache-root',
      cache,
      '--approve-install',
      '--',
      'run',
      project,
      '--out',
      out,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(out, 'evidence.json')), true);
  });

  test('modified package file is detected before run', () => {
    const project = tempDir('tamper-file');
    const cache = tempDir('cache-tamper-file');
    const installRoot = cacheInstallRoot(cache);
    seedReadyInstall(installRoot);
    fs.appendFileSync(path.join(packageRootForInstall(installRoot), 'package.json'), '\n');
    const result = run(['run', '--project-root', project, '--cache-root', cache, '--json', '--', 'audit']);
    assert.equal(result.status, 2);
    assert.match(result.json.provenance_errors.join('\n'), /package tree/);
  });

  test('modified package binary is detected before run', () => {
    const project = tempDir('tamper-binary');
    const cache = tempDir('cache-tamper-binary');
    const installRoot = cacheInstallRoot(cache);
    seedReadyInstall(installRoot);
    fs.appendFileSync(path.join(packageRootForInstall(installRoot), 'bin/frontier-audit.mjs'), '\nconsole.error("tampered");\n');
    const result = run(['run', '--project-root', project, '--cache-root', cache, '--json', '--', 'audit']);
    assert.equal(result.status, 2);
    assert.match(result.json.provenance_errors.join('\n'), /package tree/);
  });

  test('added package file is detected before run', () => {
    const project = tempDir('tamper-added');
    const cache = tempDir('cache-tamper-added');
    const installRoot = cacheInstallRoot(cache);
    seedReadyInstall(installRoot);
    fs.writeFileSync(path.join(packageRootForInstall(installRoot), 'extra.js'), 'unexpected');
    const result = run(['run', '--project-root', project, '--cache-root', cache, '--json', '--', 'audit']);
    assert.equal(result.status, 2);
    assert.match(result.json.provenance_errors.join('\n'), /package tree/);
  });

  test('malicious extra cache file is removed by approved bundled repair', () => {
    const project = makeGitTarget();
    const cache = tempDir('cache-repair-extra');
    const installRoot = cacheInstallRoot(cache);
    const extra = path.join(packageRootForInstall(installRoot), 'extra.js');
    const out = tempDir('repair-extra-out');
    seedReadyInstall(installRoot);
    fs.writeFileSync(extra, 'unexpected');
    const inspect = run(['inspect', '--project-root', project, '--cache-root', cache, '--json']);
    assert.equal(inspect.status, 2);
    assert.match(inspect.json.provenance_errors.join('\n'), /package tree/);
    const result = run([
      'ensure-run',
      '--project-root',
      project,
      '--cache-root',
      cache,
      '--approve-install',
      '--',
      'run',
      project,
      '--out',
      out,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(extra), false);
    assert.equal(fs.existsSync(path.join(out, 'evidence.json')), true);
  });

  test('removed package file is detected before run', () => {
    const project = tempDir('tamper-removed');
    const cache = tempDir('cache-tamper-removed');
    const installRoot = cacheInstallRoot(cache);
    seedReadyInstall(installRoot);
    fs.rmSync(path.join(packageRootForInstall(installRoot), 'bin/frontier-audit.mjs'));
    const result = run(['run', '--project-root', project, '--cache-root', cache, '--json', '--', 'audit']);
    assert.equal(result.status, 2);
    assert.match(result.json.provenance_errors.join('\n'), /package tree/);
  });

  test('package symlink escape is detected before run', { skip: process.platform === 'win32' }, () => {
    const project = tempDir('tamper-symlink');
    const cache = tempDir('cache-tamper-symlink');
    const installRoot = cacheInstallRoot(cache);
    seedReadyInstall(installRoot);
    fs.symlinkSync('/etc/passwd', path.join(packageRootForInstall(installRoot), 'escaped-link'));
    const result = run(['run', '--project-root', project, '--cache-root', cache, '--json', '--', 'audit']);
    assert.equal(result.status, 2);
    assert.match(result.json.provenance_errors.join('\n'), /symlink escapes/);
  });

  test('binary shim symlink escape is detected before run', { skip: process.platform === 'win32' }, () => {
    const project = tempDir('tamper-bin-shim');
    const cache = tempDir('cache-tamper-bin-shim');
    const installRoot = cacheInstallRoot(cache);
    seedReadyInstall(installRoot);
    const binShim = path.join(installRoot, 'node_modules/.bin/frontier-audit');
    fs.rmSync(binShim);
    fs.symlinkSync('/etc/passwd', binShim);
    const result = run(['run', '--project-root', project, '--cache-root', cache, '--json', '--', 'audit']);
    assert.equal(result.status, 2);
    assert.match(result.json.provenance_errors.join('\n'), /binary shim escapes/);
  });

  test('local tarball hash mismatch blocks install', () => {
    const project = tempDir('hash');
    const cache = tempDir('cache-hash');
    const { tarball } = makeTarball();
    const result = run([
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
    assert.equal(result.status, 6);
    assert.equal(result.json.status, 'hash_mismatch');
    assert.equal(fs.existsSync(path.join(project, 'node_modules')), false);
  });

  test('local tarball install requires an approved SHA', () => {
    const project = tempDir('sha-required');
    const cache = tempDir('cache-sha-required');
    const { tarball } = makeTarball();
    const result = run([
      'install',
      '--project-root',
      project,
      '--cache-root',
      cache,
      '--approve-install',
      '--tarball',
      tarball,
      '--json',
    ]);
    assert.equal(result.status, 7);
    assert.equal(result.json.status, 'tarball_sha_required');
    assert.equal(fs.existsSync(path.join(cacheInstallRoot(cache), 'node_modules')), false);
  });

  test('offline registry install is blocked explicitly', () => {
    const project = tempDir('offline');
    const cache = tempDir('cache-offline');
    const result = run([
      'install',
      '--project-root',
      project,
      '--cache-root',
      cache,
      '--source',
      'registry',
      '--approve-install',
      '--offline',
      '--json',
    ]);
    assert.equal(result.status, 7);
    assert.equal(result.json.status, 'registry_integrity_unavailable');
    assert.equal(fs.existsSync(path.join(project, 'node_modules')), false);
  });

  test('release-candidate registry install is blocked while integrity is null', () => {
    const project = tempDir('network');
    const cache = tempDir('cache-network');
    const result = run([
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
    assert.equal(result.status, 7);
    assert.equal(result.json.status, 'registry_integrity_unavailable');
    assert.match(result.json.reason, /published package integrity/);
    assert.equal(fs.existsSync(path.join(cacheInstallRoot(cache), 'node_modules')), false);
  });

  test('missing SDK installs from bundled artifact after approval and resumes audit', () => {
    const project = makeGitTarget();
    const cache = tempDir('bundle-cache');
    const out = tempDir('bundle-out');
    const result = run([
      'ensure-run',
      '--project-root',
      project,
      '--cache-root',
      cache,
      '--approve-install',
      '--',
      'run',
      project,
      '--out',
      out,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /frontier-audit: wrote/);
    assert.equal(fs.existsSync(path.join(out, 'evidence.json')), true);
    assert.equal(fs.existsSync(path.join(out, 'evidence.md')), true);
    const resolve = run(['resolve', '--project-root', project, '--cache-root', cache, '--json']);
    assert.equal(resolve.status, 0, resolve.stderr);
    assert.equal(resolve.json.status, 'ready');
    assert.equal(resolve.json.provenance.source.type, 'bundle');
    assert.equal(resolve.json.provenance.source.relative_path, bundledArtifactRelative);
    assert.equal(resolve.json.provenance.source.sha256, bundledArtifactHash);
    assert.equal(resolve.json.provenance.approval.source_type, 'bundle');
  });

  test('failed staging install leaves previous verified install untouched', () => {
    const project = tempDir('failed-staging-target');
    const cache = tempDir('failed-staging-cache');
    const installRoot = cacheInstallRoot(cache);
    seedReadyInstall(installRoot);
    const before = run(['resolve', '--project-root', project, '--cache-root', cache, '--json']);
    assert.equal(before.status, 0, before.stderr);
    const beforeHash = before.json.provenance.package_tree.hash;
    const { tarball, hash } = invalidTarball();
    const failed = run([
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
    assert.equal(failed.status, 70);
    assert.equal(failed.json.status, 'install_failed');
    const after = run(['resolve', '--project-root', project, '--cache-root', cache, '--json']);
    assert.equal(after.status, 0, after.stderr);
    assert.equal(after.json.provenance.package_tree.hash, beforeHash);
    assert.equal(after.json.status, 'ready');
  });

  test('project-local repair never deletes target repository contents', () => {
    const project = makeGitTarget();
    const keep = path.join(project, 'keep.txt');
    fs.writeFileSync(keep, 'keep me');
    const cache = tempDir('project-local-cache');
    const out = tempDir('project-local-out');
    const result = run([
      'ensure-run',
      '--project-root',
      project,
      '--cache-root',
      cache,
      '--location',
      'project',
      '--approve-install',
      '--',
      'run',
      project,
      '--out',
      out,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(keep, 'utf8'), 'keep me');
    assert.equal(fs.existsSync(path.join(project, 'README.md')), true);
    assert.equal(fs.existsSync(path.join(projectInstallRoot(project), 'node_modules/@frontier-infra/audit/package.json')), true);
    assert.equal(fs.existsSync(path.join(out, 'evidence.json')), true);
  });

  test('missing bundled artifact fails closed after approval', () => {
    const copied = copyBootstrapPlugin('missing-bundle-plugin');
    fs.unlinkSync(path.join(copied.root, bundledArtifactRelative));
    const project = tempDir('missing-bundle-target');
    const cache = tempDir('missing-bundle-cache');
    const result = run([
      'install',
      '--project-root',
      project,
      '--cache-root',
      cache,
      '--approve-install',
      '--json',
    ], { bootstrap: copied.bootstrap });
    assert.equal(result.status, 7);
    assert.equal(result.json.status, 'bundled_artifact_missing');
    assert.equal(fs.existsSync(path.join(cacheInstallRoot(cache), 'node_modules')), false);
  });

  test('tampered bundled artifact fails closed after approval', () => {
    const copied = copyBootstrapPlugin('tampered-bundle-plugin');
    fs.appendFileSync(path.join(copied.root, bundledArtifactRelative), 'tamper');
    const project = tempDir('tampered-bundle-target');
    const cache = tempDir('tampered-bundle-cache');
    const result = run([
      'install',
      '--project-root',
      project,
      '--cache-root',
      cache,
      '--approve-install',
      '--json',
    ], { bootstrap: copied.bootstrap });
    assert.equal(result.status, 6);
    assert.equal(result.json.status, 'bundled_artifact_hash_mismatch');
    assert.equal(result.json.expected_sha256, bundledArtifactHash);
    assert.equal(fs.existsSync(path.join(cacheInstallRoot(cache), 'node_modules')), false);
  });

  test('ensure-run installs approved tarball, verifies, and executes SDK args', () => {
    const project = tempDir('ensure-target');
    const cache = tempDir('ensure-cache');
    const { tarball, hash } = makeTarball();
    const result = run([
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
    assert.equal(executed.fixture, 'frontier audit');
    assert.equal(executed.cwd, fs.realpathSync(project));
    assert.deepEqual(executed.argv, ['audit', '--format', 'json']);
    assert.equal(fs.existsSync(path.join(cacheInstallRoot(cache), '.frontier-audit/sdk-provenance.json')), true);
  });

  test('SDK sign key args after separator are validated and normalized', () => {
    const project = tempDir('sign-target');
    const cache = tempDir('sign-cache');
    const key = path.join(project, 'signing.key');
    fs.writeFileSync(key, 'local-key-placeholder');
    seedReadyInstall(cacheInstallRoot(cache));
    const result = run([
      'run',
      '--project-root',
      project,
      '--cache-root',
      cache,
      '--',
      'audit',
      '--signing-key',
      'signing.key',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const executed = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.deepEqual(executed.argv, ['audit', '--sign-key', key]);
  });

  test('inline sign key material after separator is rejected', () => {
    const project = tempDir('sign-inline');
    const cache = tempDir('sign-cache-inline');
    seedReadyInstall(cacheInstallRoot(cache));
    const result = run([
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
  });
});
