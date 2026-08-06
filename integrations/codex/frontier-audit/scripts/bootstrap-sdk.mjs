#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = path.join(pluginRoot, 'assets/sdk-lock.json');
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const sdk = lock.package;
const provenanceSchemaVersion = 'frontier.audit.sdk-provenance.v3';
const packageTreeSchemaVersion = 'frontier.audit.package-tree.v1';

const exitCodes = {
  ok: 0,
  notReady: 2,
  approvalRequired: 3,
  networkNotAuthorized: 4,
  offline: 5,
  hashMismatch: 6,
  sourceBlocked: 7,
  usage: 64,
  installFailed: 70,
};

function defaultCacheRoot() {
  if (process.env.FRONTIER_AUDIT_CACHE) return path.resolve(process.env.FRONTIER_AUDIT_CACHE);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', lock.install.cache_directory_name);
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), lock.install.cache_directory_name);
  }
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), lock.install.cache_directory_name);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {
    command,
    json: false,
    approveInstall: false,
    allowNetwork: false,
    offline: false,
    projectRoot: process.cwd(),
    location: lock.install.default_location,
    cacheRoot: defaultCacheRoot(),
    source: lock.install.default_source,
    expectedSha256: null,
    tarball: null,
    signingKey: null,
    extraSigningKey: null,
    extra: [],
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--') {
      options.extra = rest.slice(index + 1);
      break;
    }
    if (arg === '--json') options.json = true;
    else if (arg === '--approve-install') options.approveInstall = true;
    else if (arg === '--allow-network') options.allowNetwork = true;
    else if (arg === '--offline') options.offline = true;
    else if (arg === '--project-root') options.projectRoot = rest[++index];
    else if (arg === '--location') options.location = rest[++index];
    else if (arg === '--cache-root') options.cacheRoot = rest[++index];
    else if (arg === '--source') options.source = rest[++index];
    else if (arg === '--tarball') options.tarball = rest[++index];
    else if (arg === '--expected-sha256') options.expectedSha256 = rest[++index];
    else if (arg === '--sign-key') options.signingKey = rest[++index];
    else if (arg === '--signing-key') options.signingKey = rest[++index];
    else throw usage(`unknown argument: ${arg}`);
  }

  if (!['inspect', 'install', 'resolve', 'run', 'ensure-run'].includes(options.command ?? '')) {
    throw usage('expected command: inspect, install, resolve, run, or ensure-run');
  }
  if (!lock.install.allowed_locations.includes(options.location)) {
    throw usage(`unsupported location: ${options.location}`);
  }
  if (!lock.install.allowed_sources.includes(options.source)) {
    throw usage(`unsupported source: ${options.source}`);
  }
  options.projectRoot = path.resolve(options.projectRoot);
  options.cacheRoot = path.resolve(options.cacheRoot);
  if (options.tarball) {
    options.tarball = path.resolve(options.tarball);
    options.source = 'tarball';
  }
  if (options.signingKey) options.signingKey = validateSignKeyValue(options.signingKey, options.projectRoot);
  const normalized = normalizeSdkArgs(options.extra, options.projectRoot);
  options.extra = normalized.args;
  options.extraSigningKey = normalized.signingKey;
  return options;
}

function usage(message) {
  const error = new Error(message);
  error.exitCode = exitCodes.usage;
  return error;
}

function installRoot(options) {
  if (options.installRootOverride) return options.installRootOverride;
  return options.location === 'project'
    ? path.join(options.projectRoot, '.frontier-audit', 'sdk-install')
    : path.join(options.cacheRoot, 'install');
}

function provenancePath(options) {
  return path.join(installRoot(options), '.frontier-audit', 'sdk-provenance.json');
}

function packageRoot(options) {
  return path.join(installRoot(options), 'node_modules', ...sdk.name.split('/'));
}

function packageJsonPath(options) {
  return path.join(packageRoot(options), 'package.json');
}

function binPath(options) {
  const extension = process.platform === 'win32' ? '.cmd' : '';
  return path.join(installRoot(options), 'node_modules', '.bin', `${lock.binary}${extension}`);
}

function validateSignKeyValue(value, baseRoot) {
  if (!value || value.startsWith('--')) throw usage('--sign-key requires a local file path value');
  if (value.includes('\n') || /BEGIN [A-Z ]+KEY/.test(value)) {
    throw usage('signing keys must be supplied as a local file path, never inline key content');
  }
  const resolved = path.isAbsolute(value) ? value : path.resolve(baseRoot, value);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw usage(`signing key path does not exist: ${resolved}`);
  }
  return resolved;
}

function normalizeSdkArgs(args, projectRoot) {
  const normalized = [];
  let signingKey = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const equalsMatch = arg.match(/^(--sign-key|--signing-key|sign-key)=(.*)$/);
    if (equalsMatch) {
      signingKey = validateSignKeyValue(equalsMatch[2], projectRoot);
      normalized.push('--sign-key', signingKey);
      continue;
    }
    if (arg === '--sign-key' || arg === '--signing-key' || arg === 'sign-key') {
      signingKey = validateSignKeyValue(args[index + 1], projectRoot);
      normalized.push('--sign-key', signingKey);
      index += 1;
      continue;
    }
    normalized.push(arg);
  }
  return { args: normalized, signingKey };
}

function signingStatus(options) {
  const signingKey = options.signingKey ?? options.extraSigningKey;
  if (!signingKey) {
    return {
      status: lock.signing.no_key_status,
      reason: 'no signing key path supplied; unsigned attestation is not a bootstrap failure',
    };
  }
  return { status: 'READY', path: signingKey };
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, value: null, error: null };
  try {
    return { exists: true, value: JSON.parse(fs.readFileSync(filePath, 'utf8')), error: null };
  } catch (error) {
    return { exists: true, value: null, error };
  }
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function bundledArtifact() {
  const relativePath = lock.install.bundled_artifact?.relative_path;
  const expectedSha256 = lock.install.bundled_artifact?.sha256;
  if (!relativePath || !expectedSha256) {
    throw new Error('sdk lock missing bundled artifact path or sha256');
  }
  const absolutePath = path.resolve(pluginRoot, relativePath);
  assertInside(pluginRoot, absolutePath, 'bundled artifact path escapes plugin root');
  return { relativePath, absolutePath, expectedSha256 };
}

function trustAnchor(sourceType) {
  const key = sourceType === sdk.source ? 'registry' : sourceType;
  const anchor = lock.trust_anchors?.[key];
  if (!anchor) throw new Error(`sdk lock missing ${key} trust anchor`);
  return anchor;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertInside(root, candidate, message) {
  const relative = path.relative(root, candidate);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return;
  throw new Error(message);
}

function computePackageTreeManifest(packageDirectory) {
  const realRoot = fs.realpathSync(packageDirectory);
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

      if (stat.isSymbolicLink()) {
        const resolved = fs.realpathSync(absolutePath);
        assertInside(realRoot, resolved, `package tree symlink escapes install root: ${relativePath}`);
        throw new Error(`package tree contains unsupported symlink: ${relativePath}`);
      }
      if (stat.isDirectory()) {
        pending.push(relativePath);
        continue;
      }
      if (!stat.isFile()) throw new Error(`package tree contains unsupported non-regular file: ${relativePath}`);
      files.push({
        path: relativePath,
        mode: stat.mode & 0o777,
        sha256: sha256(absolutePath),
      });
    }
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  const manifest = {
    schema_version: packageTreeSchemaVersion,
    files,
  };
  return {
    ...manifest,
    root: packageDirectory,
    hash: crypto.createHash('sha256').update(stableJson(manifest)).digest('hex'),
  };
}

function validateBinaryShim(options, provenanceErrors) {
  const binary = binPath(options);
  if (!fs.existsSync(binary)) {
    provenanceErrors.push('SDK binary shim is missing');
    return;
  }
  try {
    const resolvedBinary = fs.realpathSync(binary);
    const resolvedPackageRoot = fs.realpathSync(packageRoot(options));
    assertInside(resolvedPackageRoot, resolvedBinary, 'SDK binary shim escapes verified package tree');
  } catch (error) {
    provenanceErrors.push(error.message);
  }
}

function validatePackageTree(provenance, options, provenanceErrors) {
  if (!provenance.package_tree) {
    provenanceErrors.push('missing package tree manifest');
    return;
  }
  if (provenance.package_tree.schema_version !== packageTreeSchemaVersion) {
    provenanceErrors.push('package tree manifest schema mismatch');
    return;
  }
  try {
    const current = computePackageTreeManifest(packageRoot(options));
    if (current.hash !== provenance.package_tree.hash) {
      provenanceErrors.push('package tree hash mismatch');
    }
    if (stableJson(current.files) !== stableJson(provenance.package_tree.files)) {
      provenanceErrors.push('package tree file manifest mismatch');
    }
  } catch (error) {
    provenanceErrors.push(error.message);
  }
}

function stagingRoot(options) {
  const parent = path.join(options.cacheRoot, 'staging');
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, 'install-'));
}

function quarantineRoot(options) {
  const parent = path.join(options.cacheRoot, 'quarantine');
  fs.mkdirSync(parent, { recursive: true });
  return path.join(parent, `install-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`);
}

function moveDirectory(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.renameSync(source, destination);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    fs.cpSync(source, destination, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
}

function promoteStagedInstall(stagedRoot, options) {
  const destination = installRoot(options);
  if (path.resolve(destination) === path.resolve(options.projectRoot)) {
    throw new Error('refusing to replace target repository root');
  }
  const quarantine = quarantineRoot(options);
  let quarantined = false;
  if (fs.existsSync(destination)) {
    moveDirectory(destination, quarantine);
    quarantined = true;
  }
  try {
    moveDirectory(stagedRoot, destination);
  } catch (error) {
    if (quarantined && !fs.existsSync(destination) && fs.existsSync(quarantine)) {
      moveDirectory(quarantine, destination);
    }
    throw error;
  }
  return { destination, quarantined: quarantined ? quarantine : null };
}

function inspect(options) {
  const signing = signingStatus(options);
  const packageJsonResult = readJsonIfExists(packageJsonPath(options));
  const provenanceResult = readJsonIfExists(provenancePath(options));
  const base = {
    sdk: {
      name: sdk.name,
      version: sdk.version,
      source: sdk.source,
      registry: sdk.registry,
      integrity: sdk.integrity,
      state: lock.state,
      trust_anchor: trustAnchor(options.source),
    },
    location: options.location,
    install_root: installRoot(options),
    package_json: packageJsonPath(options),
    provenance_path: provenancePath(options),
    signing,
  };

  if (packageJsonResult.error) {
    return {
      ...base,
      ready: false,
      status: 'cache_corrupt',
      cache_errors: [`package.json parse error: ${packageJsonResult.error.message}`],
      action: installAction(options),
    };
  }

  if (!packageJsonResult.exists) {
    return {
      ...base,
      ready: false,
      status: 'missing',
      action: installAction(options),
    };
  }

  const packageJson = packageJsonResult.value;
  const mismatches = [];
  if (packageJson.name !== sdk.name) mismatches.push(`name ${packageJson.name} != ${sdk.name}`);
  if (packageJson.version !== sdk.version) mismatches.push(`version ${packageJson.version} != ${sdk.version}`);
  if (mismatches.length > 0) {
    return {
      ...base,
      ready: false,
      status: 'version_mismatch',
      installed: { name: packageJson.name, version: packageJson.version },
      mismatches,
      action: installAction(options),
    };
  }

  const provenanceErrors = [];
  const provenance = provenanceResult.value;
  if (provenanceResult.error) provenanceErrors.push(`provenance JSON parse error: ${provenanceResult.error.message}`);
  else if (!provenanceResult.exists) provenanceErrors.push('missing bootstrap provenance record');
  else {
    if (provenance.schema_version !== provenanceSchemaVersion) provenanceErrors.push('provenance schema mismatch');
    if (provenance.package?.name !== sdk.name) provenanceErrors.push('provenance package name mismatch');
    if (provenance.package?.version !== sdk.version) provenanceErrors.push('provenance package version mismatch');
    if (provenance.lock_sha256 !== sha256(lockPath)) provenanceErrors.push('sdk lock hash mismatch');
    try {
      if (stableJson(provenance.trust_anchor) !== stableJson(trustAnchor(provenance.source?.type))) {
        provenanceErrors.push('trust anchor mismatch');
      }
    } catch (error) {
      provenanceErrors.push(error.message);
    }
    if (provenance.install_root !== installRoot(options)) provenanceErrors.push('provenance install root mismatch');
    if (provenance.source?.type === 'tarball' || provenance.source?.type === 'bundle') {
      if (!provenance.source.sha256) provenanceErrors.push('tarball provenance missing sha256');
      if (!provenance.source.expected_sha256) provenanceErrors.push('tarball provenance missing expected_sha256');
      if (provenance.source.expected_sha256 !== provenance.source.sha256) {
        provenanceErrors.push('tarball provenance expected sha256 mismatch');
      }
      if (provenance.source.package !== sdk.name) provenanceErrors.push('tarball provenance package mismatch');
      if (provenance.source.version !== sdk.version) provenanceErrors.push('tarball provenance version mismatch');
      if (provenance.approval?.approved !== true) provenanceErrors.push('missing explicit install approval metadata');
      if (provenance.approval?.source_type !== provenance.source?.type) provenanceErrors.push('install approval source type mismatch');
      if (provenance.approval?.sha256 !== provenance.source.sha256) provenanceErrors.push('install approval sha256 mismatch');
      if (provenance.source?.type === 'bundle') {
        const artifact = bundledArtifact();
        if (provenance.source.relative_path !== artifact.relativePath) provenanceErrors.push('bundle provenance path mismatch');
        if (provenance.source.sha256 !== artifact.expectedSha256) provenanceErrors.push('bundle provenance sha256 mismatch');
      }
    } else if (provenance.source?.type === sdk.source) {
      if (!sdk.integrity) provenanceErrors.push('registry provenance blocked while lock integrity is unpublished');
      if (provenance.source.registry !== sdk.registry) provenanceErrors.push('registry provenance mismatch');
      if (provenance.source.integrity !== sdk.integrity) provenanceErrors.push('registry integrity provenance mismatch');
    } else {
      provenanceErrors.push('unknown SDK source provenance');
    }
    validatePackageTree(provenance, options, provenanceErrors);
    validateBinaryShim(options, provenanceErrors);
  }

  if (provenanceErrors.length > 0) {
    return {
      ...base,
      ready: false,
      status: 'provenance_mismatch',
      installed: { name: packageJson.name, version: packageJson.version },
      provenance,
      provenance_errors: provenanceErrors,
      action: installAction(options),
    };
  }

  return {
    ...base,
    ready: signing.status !== 'INVALID',
    status: signing.status === 'INVALID' ? 'signing_key_invalid' : 'ready',
    installed: { name: packageJson.name, version: packageJson.version },
    provenance,
    binary: binPath(options),
  };
}

function installAction(options) {
  const artifact = options.source === 'bundle' ? bundledArtifact() : null;
  const source = options.source === 'bundle'
    ? `bundled artifact ${artifact.relativePath} (${artifact.expectedSha256})`
    : options.tarball
      ? `local tarball ${options.tarball}`
      : `${sdk.source}:${sdk.name}@${sdk.version} from ${sdk.registry}`;
  return {
    required: 'Request explicit install authorization, then rerun this bootstrap with --approve-install.',
    package: sdk.name,
    version: sdk.version,
    source,
    source_type: options.source,
    bundled_artifact: artifact ? { relative_path: artifact.relativePath, path: artifact.absolutePath, sha256: artifact.expectedSha256 } : undefined,
    location: installRoot(options),
    target_repo: options.projectRoot,
    network: options.source === 'registry' ? 'requires --allow-network, published integrity, pinned registry, and user approval' : 'not required',
    trust_anchor: trustAnchor(options.source),
  };
}

function installReport(options) {
  if (!options.approveInstall) {
    return {
      report: {
        ready: false,
        status: 'approval_required',
        action: installAction(options),
      },
      code: exitCodes.approvalRequired,
    };
  }

  if (options.source === 'registry') {
    if (!sdk.integrity) {
      return {
        report: {
          ready: false,
          status: 'registry_integrity_unavailable',
          action: installAction(options),
          reason: 'registry install is blocked until assets/sdk-lock.json pins published package integrity',
        },
        code: exitCodes.sourceBlocked,
      };
    }
    if (options.offline) {
      return {
        report: {
          ready: false,
          status: 'offline',
          action: installAction(options),
          reason: 'offline mode prevents registry install',
        },
        code: exitCodes.offline,
      };
    }
    if (!options.allowNetwork) {
      return {
        report: {
          ready: false,
          status: 'network_not_authorized',
          action: installAction(options),
          reason: 'registry installs require explicit --allow-network in addition to --approve-install',
        },
        code: exitCodes.networkNotAuthorized,
      };
    }
  }

  let sourceSpec;
  let sourceRecord;
  if (options.source === 'registry') {
    sourceSpec = `${sdk.name}@${sdk.version}`;
    sourceRecord = { type: sdk.source, registry: sdk.registry, spec: sourceSpec, integrity: sdk.integrity };
  } else if (options.source === 'bundle') {
    let artifact;
    try {
      artifact = bundledArtifact();
    } catch (error) {
      return {
        report: {
          ready: false,
          status: 'bundled_artifact_invalid',
          reason: error.message,
        },
        code: exitCodes.sourceBlocked,
      };
    }
    if (!fs.existsSync(artifact.absolutePath)) {
      return {
        report: {
          ready: false,
          status: 'bundled_artifact_missing',
          action: installAction(options),
          reason: `bundled SDK artifact is missing: ${artifact.absolutePath}`,
        },
        code: exitCodes.sourceBlocked,
      };
    }
    const actualSha = sha256(artifact.absolutePath);
    if (actualSha !== artifact.expectedSha256) {
      return {
        report: {
          ready: false,
          status: 'bundled_artifact_hash_mismatch',
          expected_sha256: artifact.expectedSha256,
          actual_sha256: actualSha,
          path: artifact.absolutePath,
        },
        code: exitCodes.hashMismatch,
      };
    }
    sourceSpec = artifact.absolutePath;
    sourceRecord = {
      type: 'bundle',
      package: sdk.name,
      version: sdk.version,
      relative_path: artifact.relativePath,
      path: artifact.absolutePath,
      sha256: actualSha,
      expected_sha256: artifact.expectedSha256,
    };
  } else if (options.source === 'tarball') {
    if (!options.expectedSha256) {
      return {
        report: {
          ready: false,
          status: 'tarball_sha_required',
          action: installAction(options),
          reason: 'release-candidate installs require --expected-sha256 with the approved local tarball',
        },
        code: exitCodes.sourceBlocked,
      };
    }
    if (!fs.existsSync(options.tarball)) throw usage(`tarball does not exist: ${options.tarball}`);
    const actualSha = sha256(options.tarball);
    if (actualSha !== options.expectedSha256) {
      return {
        report: {
          ready: false,
          status: 'hash_mismatch',
          expected_sha256: options.expectedSha256,
          actual_sha256: actualSha,
          tarball: options.tarball,
        },
        code: exitCodes.hashMismatch,
      };
    }
    sourceSpec = options.tarball;
    sourceRecord = {
      type: 'tarball',
      package: sdk.name,
      version: sdk.version,
      path: options.tarball,
      sha256: actualSha,
      expected_sha256: options.expectedSha256,
    };
  } else {
    throw usage(`unsupported source: ${options.source}`);
  }

  fs.mkdirSync(options.cacheRoot, { recursive: true });
  const stagedRoot = stagingRoot(options);
  const stagedOptions = { ...options, installRootOverride: stagedRoot };
  const result = spawnSync(
    'npm',
    [
      'install',
      '--prefix',
      stagedRoot,
      '--no-save',
      '--omit=dev',
      '--ignore-scripts',
      '--cache',
      path.join(options.cacheRoot, 'npm-cache'),
      ...(options.source === 'registry' ? ['--registry', sdk.registry] : []),
      ...(options.offline ? ['--offline'] : []),
      sourceSpec,
    ],
    { encoding: 'utf8' },
  );

  if (result.status !== 0) {
    fs.rmSync(stagedRoot, { recursive: true, force: true });
    return {
      report: {
        ready: false,
        status: 'install_failed',
        stderr: result.stderr.trim(),
        stdout: result.stdout.trim(),
      },
      code: exitCodes.installFailed,
    };
  }

  const installedResult = readJsonIfExists(packageJsonPath(stagedOptions));
  const installed = installedResult.value;
  if (installedResult.error || !installed || installed.name !== sdk.name || installed.version !== sdk.version) {
    fs.rmSync(stagedRoot, { recursive: true, force: true });
    return {
      report: {
        ready: false,
        status: 'install_verification_failed',
        installed: installed ? { name: installed.name, version: installed.version } : null,
        expected: { name: sdk.name, version: sdk.version },
        reason: installedResult.error ? `package.json parse error: ${installedResult.error.message}` : undefined,
      },
      code: exitCodes.installFailed,
    };
  }

  let packageTree;
  try {
    packageTree = computePackageTreeManifest(packageRoot(stagedOptions));
    const binaryErrors = [];
    validateBinaryShim(stagedOptions, binaryErrors);
    if (binaryErrors.length > 0) throw new Error(binaryErrors.join('; '));
  } catch (error) {
    fs.rmSync(stagedRoot, { recursive: true, force: true });
    return {
      report: {
        ready: false,
        status: 'install_verification_failed',
        reason: error.message,
      },
      code: exitCodes.installFailed,
    };
  }

  const record = {
    schema_version: provenanceSchemaVersion,
    package: { name: sdk.name, version: sdk.version },
    source: sourceRecord,
    approval: options.source === 'tarball' || options.source === 'bundle'
      ? {
          approved: true,
          source_type: sourceRecord.type,
          package: sdk.name,
          version: sdk.version,
          sha256: sourceRecord.sha256,
          approved_at: new Date().toISOString(),
        }
      : {
          approved: true,
          source_type: sdk.source,
          package: sdk.name,
          version: sdk.version,
          integrity: sdk.integrity,
          approved_at: new Date().toISOString(),
        },
    package_tree: packageTree,
    trust_anchor: trustAnchor(sourceRecord.type),
    lock_sha256: sha256(lockPath),
    installed_at: new Date().toISOString(),
    install_root: installRoot(options),
    bootstrap: path.relative(pluginRoot, fileURLToPath(import.meta.url)),
  };
  fs.mkdirSync(path.dirname(provenancePath(stagedOptions)), { recursive: true });
  fs.writeFileSync(provenancePath(stagedOptions), `${JSON.stringify(record, null, 2)}\n`);

  try {
    promoteStagedInstall(stagedRoot, options);
  } catch (error) {
    fs.rmSync(stagedRoot, { recursive: true, force: true });
    return {
      report: {
        ready: false,
        status: 'install_promotion_failed',
        reason: error.message,
      },
      code: exitCodes.installFailed,
    };
  }

  return { report: inspect(options), code: exitCodes.ok };
}

function install(options) {
  const { report, code } = installReport(options);
  return finish(report, code, options);
}

function resolve(options) {
  const report = inspect(options);
  return finish(report, report.ready ? exitCodes.ok : exitCodes.notReady, options);
}

function runSdk(options) {
  const report = inspect(options);
  if (!report.ready) return finish(report, exitCodes.notReady, options);
  executeSdk(report, options);
}

function ensureRunSdk(options) {
  const initial = inspect(options);
  if (!initial.ready) {
    const { report, code } = installReport(options);
    if (code !== exitCodes.ok) return finish(report, code, options);
  }
  const report = inspect(options);
  if (!report.ready) return finish(report, exitCodes.notReady, options);
  executeSdk(report, options);
}

function executeSdk(report, options) {
  const binary = report.binary;
  if (!fs.existsSync(binary)) {
    return finish(
      {
        ...report,
        ready: false,
        status: 'binary_missing',
        binary,
      },
      exitCodes.notReady,
      options,
    );
  }
  const result = spawnSync(binary, options.extra, {
    cwd: options.projectRoot,
    stdio: 'inherit',
  });
  process.exit(result.status ?? exitCodes.installFailed);
}

function finish(report, code, options) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${report.status}: ${report.ready ? 'ready' : 'not ready'}\n`);
    if (report.action) {
      process.stdout.write(`package: ${report.action.package}@${report.action.version}\n`);
      process.stdout.write(`source: ${report.action.source}\n`);
      process.stdout.write(`location: ${report.action.location}\n`);
      process.stdout.write(`${report.action.required}\n`);
    }
    if (report.reason) process.stdout.write(`${report.reason}\n`);
  }
  process.exit(code);
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'inspect') {
    const report = inspect(options);
    finish(report, report.ready ? exitCodes.ok : exitCodes.notReady, options);
  } else if (options.command === 'install') install(options);
  else if (options.command === 'resolve') resolve(options);
  else if (options.command === 'run') runSdk(options);
  else if (options.command === 'ensure-run') ensureRunSdk(options);
} catch (error) {
  const code = error.exitCode ?? exitCodes.installFailed;
  process.stderr.write(`${error.message}\n`);
  process.exit(code);
}
