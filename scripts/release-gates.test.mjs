import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-release-gates-'));
}

function copyScript(name, repo) {
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(sdkRoot, 'scripts', name), path.join(repo, 'scripts', name));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writePackage(repo, packagePath, name, version = '0.1.0') {
  writeJson(path.join(repo, packagePath, 'package.json'), {
    name,
    version,
    type: 'module',
    files: ['index.mjs'],
  });
  fs.writeFileSync(path.join(repo, packagePath, 'index.mjs'), 'export {};\n');
}

function initGit(repo) {
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'frontier-tests@example.invalid'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Frontier Tests'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repo, stdio: 'ignore' });
}

test('rc-pack refuses dirty source before writing output', () => {
  const repo = tmpRoot();
  copyScript('rc-pack.mjs', repo);
  writeJson(path.join(repo, 'config/release-packages.json'), {
    release: 'fixture-rc',
    packages: [],
  });
  initGit(repo);

  fs.writeFileSync(path.join(repo, 'dirty-source.txt'), 'uncommitted\n');
  const output = path.join(repo, 'dist/fixture-rc');
  const result = spawnSync(process.execPath, ['scripts/rc-pack.mjs', '--output', output], {
    cwd: repo,
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to assemble RC packages from a dirty source tree/);
  assert.match(result.stderr, /dirty-source\.txt/);
  assert.equal(fs.existsSync(output), false);
});

test('release publish list is derived from the release manifest', () => {
  const repo = tmpRoot();
  copyScript('release-publish-list.mjs', repo);
  writePackage(repo, 'packages/typescript/protocol', '@frontier-infra/protocol', '0.1.0');
  writePackage(repo, 'packages/typescript/audit', '@frontier-infra/audit', '0.1.2');
  writePackage(repo, 'packages/typescript/harness-kit', '@frontier-infra/harness-kit', '0.1.0');
  writeJson(path.join(repo, 'config/release-packages.json'), {
    release: 'fixture-rc',
    packages: [
      { name: '@frontier-infra/protocol', path: 'packages/typescript/protocol', publish_enabled: true },
      { name: '@frontier-infra/harness-kit', path: 'packages/typescript/harness-kit', publish_enabled: false },
      { name: '@frontier-infra/audit', path: 'packages/typescript/audit', publish_enabled: true },
    ],
  });

  const stdout = execFileSync(process.execPath, ['scripts/release-publish-list.mjs'], {
    cwd: repo,
    encoding: 'utf8',
  });

  assert.equal(stdout, [
    'packages/typescript/protocol\t@frontier-infra/protocol\t0.1.0',
    'packages/typescript/audit\t@frontier-infra/audit\t0.1.2',
    '',
  ].join('\n'));
});
