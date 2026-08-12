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
      { name: '@frontier-infra/protocol', path: 'packages/typescript/protocol', publish_enabled: true, dist_tag: 'latest' },
      { name: '@frontier-infra/harness-kit', path: 'packages/typescript/harness-kit', publish_enabled: false },
      { name: '@frontier-infra/audit', path: 'packages/typescript/audit', publish_enabled: true, dist_tag: 'next' },
    ],
  });

  const stdout = execFileSync(process.execPath, ['scripts/release-publish-list.mjs'], {
    cwd: repo,
    encoding: 'utf8',
  });

  assert.equal(stdout, [
    'packages/typescript/protocol\t@frontier-infra/protocol\t0.1.0\tlatest',
    'packages/typescript/audit\t@frontier-infra/audit\t0.1.2\tnext',
    '',
  ].join('\n'));
});

test('release publish list rejects enabled packages without an explicit dist tag', () => {
  const repo = tmpRoot();
  copyScript('release-publish-list.mjs', repo);
  writePackage(repo, 'packages/typescript/harness-kit', '@frontier-infra/harness-kit', '0.1.0');
  writeJson(path.join(repo, 'config/release-packages.json'), {
    release: 'fixture-rc',
    packages: [
      { name: '@frontier-infra/harness-kit', path: 'packages/typescript/harness-kit', publish_enabled: true },
    ],
  });

  const result = spawnSync(process.execPath, ['scripts/release-publish-list.mjs'], {
    cwd: repo,
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /require a valid dist_tag/);
});

test('Foundation RC launch manifest keeps new packages on next', () => {
  const release = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'config/release-packages.json'), 'utf8'));
  assert.equal(release.release_tag, 'foundation-v0.1.0-rc.1');

  const byName = new Map(release.packages.map((entry) => [entry.name, entry]));
  const newPackages = [
    '@frontier-infra/harness-kit',
    '@frontier-infra/adapters',
    '@frontier-infra/governance-react',
    '@frontier-infra/create-frontier-app',
  ];
  assert.deepEqual(
    release.packages.filter((entry) => entry.publish_enabled).map((entry) => entry.name),
    newPackages,
  );
  for (const name of newPackages) {
    assert.equal(byName.get(name)?.publish_enabled, true, name);
    assert.equal(byName.get(name)?.dist_tag, 'next', name);
  }

  assert.equal(byName.get('@frontier-infra/protocol')?.publish_enabled, false);
  assert.equal(byName.get('@frontier-infra/audit')?.publish_enabled, false);
});

test('every enabled package declares the public Frontier registry custody', () => {
  const release = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'config/release-packages.json'), 'utf8'));
  const expectedRepository = 'git+https://github.com/frontier-infra/frontier-sdk.git';

  for (const entry of release.packages.filter((candidate) => candidate.publish_enabled)) {
    const manifestPath = path.join(sdkRoot, entry.path, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    assert.equal(manifest.name, entry.name, manifestPath);
    assert.notEqual(manifest.private, true, manifest.name);
    assert.equal(manifest.repository?.type, 'git', manifest.name);
    assert.equal(manifest.repository?.url, expectedRepository, manifest.name);
    assert.equal(manifest.repository?.directory, entry.path, manifest.name);
    assert.equal(manifest.publishConfig?.access, 'public', manifest.name);
    assert.equal(manifest.publishConfig?.registry, 'https://registry.npmjs.org/', manifest.name);
  }
});

test('release waits for npm scanning before its registry smoke test', () => {
  const workflow = fs.readFileSync(path.join(sdkRoot, '.github/workflows/release.yml'), 'utf8');
  const waitStep = workflow.indexOf('Wait for npm publish-time scanning and record registry evidence');
  const evidenceStep = workflow.indexOf('Preserve the npm publication evidence');
  const smokeStep = workflow.indexOf('Smoke-test the npm-hosted starter');

  assert.notEqual(waitStep, -1);
  assert.match(workflow, /for attempt in \$\(seq 1 80\)/);
  assert.match(workflow, /sleep 15/);
  assert.ok(waitStep < evidenceStep);
  assert.ok(evidenceStep < smokeStep);
});
