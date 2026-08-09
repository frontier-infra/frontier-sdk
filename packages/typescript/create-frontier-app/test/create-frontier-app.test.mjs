import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  TEMPLATE_MANIFEST,
  formatNextSteps,
  sanitizePackageName,
  scaffoldProject,
  validateTargetDir,
} from '../src/index.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromiumEnvVars = ['FRONTIER_CHROMIUM_BIN', 'CHROMIUM_BIN', 'CHROME_BIN'];
const chromiumPathCandidates = [
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
  'chrome',
];
const chromiumMacCandidates = [
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const avlEnvVars = ['FRONTIER_AVL_CLI', 'AVL_CLI'];
const avlPackageName = '@frontier-infra/avl';
const avlBinName = 'avl';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'create-frontier-app-'));
}

test('sanitizes generated package names', () => {
  assert.equal(sanitizePackageName('My Frontier App'), 'my-frontier-app');
  assert.equal(sanitizePackageName('../'), 'frontier-governed-worker');
});

test('rejects unsafe and non-empty target directories', () => {
  const root = tmpRoot();
  assert.throws(() => validateTargetDir('../escape', { cwd: root }), /parent-directory/);
  assert.throws(() => validateTargetDir('inside/../escape', { cwd: root }), /parent-directory/);
  assert.throws(() => validateTargetDir('-', { cwd: root }), /option/);

  const occupied = path.join(root, 'occupied');
  fs.mkdirSync(occupied);
  fs.writeFileSync(path.join(occupied, 'keep.txt'), 'mine');
  assert.throws(() => validateTargetDir('occupied', { cwd: root }), /must be empty/);

  const fileTarget = path.join(root, 'file-target');
  fs.writeFileSync(fileTarget, 'nope');
  assert.throws(() => validateTargetDir('file-target', { cwd: root }), /is a file/);
});

test('scaffolds every manifest file without overwriting', () => {
  const root = tmpRoot();
  const result = scaffoldProject('Demo App', { cwd: root });

  assert.equal(result.projectName, 'demo-app');
  assert.deepEqual(result.files, [...TEMPLATE_MANIFEST]);
  for (const file of TEMPLATE_MANIFEST) {
    assert.equal(fs.existsSync(path.join(result.targetDir, file)), true, `${file} should exist`);
  }

  const generatedPackage = JSON.parse(fs.readFileSync(path.join(result.targetDir, 'package.json'), 'utf8'));
  assert.equal(generatedPackage.name, 'demo-app');
  assert.equal(generatedPackage.dependencies['@frontier-infra/harness-kit'], '^0.1.0');
  assert.equal(generatedPackage.dependencies['@frontier-infra/governance-react'], '^0.1.0');

  const server = fs.readFileSync(path.join(result.targetDir, 'server/index.mjs'), 'utf8');
  assert.match(server, /@frontier-infra\/harness-kit/);

  assert.throws(() => scaffoldProject('Demo App', { cwd: root }), /must be empty/);
});

test('cli prints package-manager neutral next steps', () => {
  const root = tmpRoot();
  const stdout = execFileSync(process.execPath, [path.join(packageRoot, 'src/cli.mjs'), 'cli-demo'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.match(stdout, /created/);
  assert.match(stdout, /npm install/);
  assert.match(stdout, /pnpm install/);
  assert.match(stdout, /yarn install/);
  assert.equal(fs.existsSync(path.join(root, 'cli-demo', 'public/.well-known/avl.json')), true);
});

test('next steps disclose illustrative production references', () => {
  const root = tmpRoot();
  const result = scaffoldProject('notes', { cwd: root });
  assert.match(formatNextSteps(result), /illustrative starting points/);
});

test('generated app UI-origin smoke serves live AVL and enforces exact local write guard', async () => {
  const root = tmpRoot();
  const result = scaffoldProject('smoke-app', { cwd: root });
  const scopeDir = path.join(result.targetDir, 'node_modules', '@frontier-infra');
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.symlinkSync(path.resolve(packageRoot, '..', 'harness-kit'), path.join(scopeDir, 'harness-kit'), 'dir');
  fs.symlinkSync(path.resolve(packageRoot, '..', 'protocol'), path.join(scopeDir, 'protocol'), 'dir');

  const port = 19000 + Math.floor(Math.random() * 1000);
  const uiPort = port + 1000;
  const uiOrigin = `http://127.0.0.1:${uiPort}`;
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: result.targetDir,
    env: { ...process.env, PORT: String(port), FRONTIER_ALLOWED_ORIGINS: `${uiOrigin},http://localhost:${uiPort}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const uiServer = createUiOriginProxy(result.targetDir, port);

  let serverOutput = '';
  child.stdout.on('data', (chunk) => { serverOutput += chunk; });
  child.stderr.on('data', (chunk) => { serverOutput += chunk; });

  try {
    await new Promise((resolve) => uiServer.listen(uiPort, '127.0.0.1', resolve));
    await waitForServer(port, () => serverOutput);
    await waitForHttp(`${uiOrigin}/`);

    const agent = await fetch(`${uiOrigin}/.agent`, { headers: { accept: 'text/agent-view' } });
    assert.equal(agent.status, 200);
    assert.match(agent.headers.get('content-type'), /text\/agent-view/);
    assert.match(await agent.text(), /@meta/);

    const pageAgent = await fetch(`${uiOrigin}/agent-view.agent`, { headers: { accept: 'text/agent-view' } });
    assert.equal(pageAgent.status, 200);
    assert.match(pageAgent.headers.get('content-type'), /text\/agent-view/);

    const avlOutput = await runAvlValidate(uiOrigin);
    assert.match(avlOutput, /AVL L3 Ready/);

    const status = await fetch(`${uiOrigin}/api/frontier/status`);
    const statusJson = await status.json();
    assert.equal(statusJson.health.status, 'propose_only');
    assert.equal(statusJson.health.can_mutate, false);
    assert.deepEqual(statusJson.effects, {});

    const rejected = await fetch(`http://127.0.0.1:${port}/api/frontier/run-once`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: `http://127.0.0.1:${uiPort + 100}`,
        'sec-fetch-site': 'same-site',
      },
      body: JSON.stringify({ intent: 'run_once' }),
    });
    assert.equal(rejected.status, 403);

    const accepted = await fetch(`${uiOrigin}/api/frontier/run-once`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: uiOrigin,
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify({ intent: 'run_once' }),
    });
    const acceptedJson = await accepted.json();
    assert.equal(accepted.status, 200);
    assert.equal(acceptedJson.result.status, 'propose_only');
    assert.equal(acceptedJson.result.report.status, 'propose_only');
    assert.deepEqual(acceptedJson.status.effects, {});
  } finally {
    uiServer.closeAllConnections?.();
    await new Promise((resolve) => uiServer.close(resolve));
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
});

test('generated app builds and renders from production preview', async () => {
  const root = tmpRoot();
  const tarballs = packStarterChain();
  const result = scaffoldProjectFromPackedCli('render-app', { cwd: root, tarballs });
  prepareGeneratedAppForLocalInstall(result.targetDir, tarballs);
  assertFrontierPackagesUseFileDeps(result.targetDir);

  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: result.targetDir,
    stdio: 'pipe',
    timeout: 120000,
  });
  execFileSync('npm', ['run', 'build'], {
    cwd: result.targetDir,
    stdio: 'pipe',
    timeout: 120000,
  });

  const port = 21000 + Math.floor(Math.random() * 1000);
  const uiPort = port + 1000;
  const uiOrigin = `http://127.0.0.1:${uiPort}`;
  const api = spawn(process.execPath, ['server/index.mjs'], {
    cwd: result.targetDir,
    env: { ...process.env, PORT: String(port), FRONTIER_ALLOWED_ORIGINS: `${uiOrigin},http://localhost:${uiPort}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const preview = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--port', String(uiPort)], {
    cwd: result.targetDir,
    env: { ...process.env, PORT: String(port), VITE_PORT: String(uiPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let apiOutput = '';
  let previewOutput = '';
  api.stdout.on('data', (chunk) => { apiOutput += chunk; });
  api.stderr.on('data', (chunk) => { apiOutput += chunk; });
  preview.stdout.on('data', (chunk) => { previewOutput += chunk; });
  preview.stderr.on('data', (chunk) => { previewOutput += chunk; });

  try {
    await waitForServer(port, () => apiOutput);
    await waitForHttp(uiOrigin);
    const dom = await renderWithChromium(uiOrigin, 'Proposal-only starter');

    assert.match(dom, /render-app/);
    assert.match(dom, /Proposal-only starter/);
    assert.match(dom, /Run worker once/);
    assert.doesNotMatch(dom, /React is not defined/);
  } finally {
    preview.kill('SIGTERM');
    api.kill('SIGTERM');
    await Promise.allSettled([
      new Promise((resolve) => preview.once('exit', resolve)),
      new Promise((resolve) => api.once('exit', resolve)),
    ]);
  }
});

function packStarterChain() {
  const tarballRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-starter-tarballs-'));
  return {
    createFrontierApp: packPackage(packageRoot, tarballRoot),
    governanceReact: packPackage(path.resolve(packageRoot, '..', 'governance-react'), tarballRoot),
    harnessKit: packPackage(path.resolve(packageRoot, '..', 'harness-kit'), tarballRoot),
    protocol: packPackage(path.resolve(packageRoot, '..', 'protocol'), tarballRoot),
  };
}

function packPackage(packageDir, tarballRoot) {
  const stdout = execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', tarballRoot], {
    cwd: packageDir,
    encoding: 'utf8',
    env: { ...process.env, npm_config_update_notifier: 'false' },
  });
  const result = JSON.parse(stdout);
  assert.equal(result.length, 1);
  return path.join(tarballRoot, result[0].filename);
}

function scaffoldProjectFromPackedCli(projectName, { cwd, tarballs }) {
  const cliRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-packed-cli-'));
  fs.writeFileSync(path.join(cliRoot, 'package.json'), `${JSON.stringify({
    name: 'frontier-packed-cli-smoke',
    private: true,
    type: 'module',
  }, null, 2)}\n`);
  execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', tarballs.createFrontierApp], {
    cwd: cliRoot,
    stdio: 'pipe',
    timeout: 120000,
    env: {
      ...process.env,
      npm_config_cache: path.join(cliRoot, 'npm-cache'),
      npm_config_update_notifier: 'false',
    },
  });
  execFileSync(process.execPath, [
    path.join(cliRoot, 'node_modules/@frontier-infra/create-frontier-app/src/cli.mjs'),
    projectName,
  ], {
    cwd,
    stdio: 'pipe',
    timeout: 120000,
  });
  return {
    projectName,
    targetDir: path.join(cwd, projectName),
  };
}

function prepareGeneratedAppForLocalInstall(appDir, tarballs) {
  const packageJsonPath = path.join(appDir, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  packageJson.dependencies['@frontier-infra/governance-react'] = `file:${tarballs.governanceReact}`;
  packageJson.dependencies['@frontier-infra/harness-kit'] = `file:${tarballs.harnessKit}`;
  packageJson.dependencies['@frontier-infra/protocol'] = `file:${tarballs.protocol}`;
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
  fs.writeFileSync(path.join(appDir, '.npmrc'), [
    '@frontier-infra:registry=http://127.0.0.1:9/',
    'fetch-retries=0',
    'fund=false',
    'audit=false',
    '',
  ].join('\n'));
}

function assertFrontierPackagesUseFileDeps(appDir) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  for (const name of [
    '@frontier-infra/governance-react',
    '@frontier-infra/harness-kit',
    '@frontier-infra/protocol',
  ]) {
    assert.match(packageJson.dependencies[name], /^file:/, `${name} must install from a local packed artifact`);
  }
}

async function renderWithChromium(url, expectedText) {
  const chromiumBin = resolveChromiumExecutable();
  const debugPort = 24000 + Math.floor(Math.random() * 1000);
  const browser = spawn(chromiumBin, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--disable-component-update',
    `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-chromium-'))}`,
    `--remote-debugging-port=${debugPort}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let ws;
  const browserEvents = [];
  try {
    const targets = await waitForJson(`http://127.0.0.1:${debugPort}/json`);
    const pageTarget = targets.find((target) => target.type === 'page') ?? targets[0];
    ws = await openCdp(pageTarget.webSocketDebuggerUrl);
    ws.onEvent = (message) => {
      if (message.method === 'Runtime.exceptionThrown') {
        browserEvents.push(JSON.stringify(message.params.exceptionDetails));
      }
      if (message.method === 'Runtime.consoleAPICalled') {
        browserEvents.push(message.params.args?.map((arg) => arg.value ?? arg.description).join(' '));
      }
    };
    await ws.command('Page.enable');
    await ws.command('Runtime.enable');
    await ws.command('Page.navigate', { url });

    const started = Date.now();
    let html = '';
    while (Date.now() - started < 10000) {
      const result = await ws.command('Runtime.evaluate', {
        expression: 'document.documentElement.outerHTML',
        returnByValue: true,
      });
      html = result.result?.value ?? '';
      if (html.includes(expectedText)) return html;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Chromium render did not include ${expectedText}\n${browserEvents.join('\n')}\n${html}`);
  } finally {
    ws?.close();
    browser.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => browser.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
  }
}

function resolveChromiumExecutable() {
  for (const envVar of chromiumEnvVars) {
    const value = process.env[envVar];
    if (!value) continue;
    if (isExecutableFile(value)) return value;
    throw new Error(`${envVar} points to a non-executable Chromium binary: ${value}`);
  }

  for (const candidate of chromiumPathCandidates) {
    const resolved = findOnPath(candidate);
    if (resolved) return resolved;
  }

  for (const candidate of chromiumMacCandidates) {
    if (isExecutableFile(candidate)) return candidate;
  }

  throw new Error([
    'Chromium is required for the generated app render smoke test.',
    `Set ${chromiumEnvVars.join(' or ')} to an executable Chromium/Chrome binary, or install one of these PATH commands: ${chromiumPathCandidates.join(', ')}.`,
  ].join(' '));
}

function findOnPath(command) {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function isExecutableFile(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

async function waitForJson(url) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < 5000) {
    try {
      const response = await fetch(url);
      return await response.json();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`could not fetch ${url}: ${lastError?.message ?? 'unknown'}`);
}

async function openCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  const api = {
    onEvent: null,
    command(method, params = {}) {
      const id = nextId;
      nextId += 1;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() {
      socket.close();
    },
  };
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    api.onEvent?.(message);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result ?? {});
  });
  return api;
}

function createUiOriginProxy(appDir, apiPort) {
  const proxyPaths = [
    '/.agent',
    '/agent-view.agent',
    '/agent.txt',
    '/llms.txt',
    '/.well-known',
    '/api',
  ];
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/') {
        const body = fs.readFileSync(path.join(appDir, 'index.html'));
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': String(body.length),
          connection: 'close',
        });
        res.end(body);
        return;
      }
      const shouldProxy = proxyPaths.some((entry) => url.pathname === entry || url.pathname.startsWith(`${entry}/`)) || url.pathname.endsWith('.agent');
      if (!shouldProxy) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      const body = await readRequestBody(req);
      const upstream = await fetch(`http://127.0.0.1:${apiPort}${url.pathname}${url.search}`, {
        method: req.method,
        headers: req.headers,
        body,
      });
      const upstreamBody = Buffer.from(await upstream.arrayBuffer());
      const headers = Object.fromEntries(upstream.headers.entries());
      delete headers['transfer-encoding'];
      headers['content-length'] = String(upstreamBody.length);
      headers.connection = 'close';
      res.writeHead(upstream.status, headers);
      res.end(upstreamBody);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'ui_proxy_error', message: error.message }));
    }
  });
}

async function readRequestBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function runAvlValidate(origin) {
  const avlCli = resolveAvlCli();
  const child = spawn(avlCli.command, [...avlCli.args, 'validate', origin, '--level', 'L3'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let settled = false;

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`AVL validator timed out\n${output}`));
    }, 10000);

    function observe(chunk) {
      output += chunk;
      if (!settled && /AVL L3 Ready/.test(output)) {
        settled = true;
        clearTimeout(timeout);
        child.kill('SIGTERM');
        resolve(output);
      }
    }

    child.stdout.on('data', observe);
    child.stderr.on('data', observe);
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0 && /AVL L3 Ready/.test(output)) resolve(output);
      else reject(new Error(`AVL validator exited ${code}\n${output}`));
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function resolveAvlCli() {
  for (const envVar of avlEnvVars) {
    const value = process.env[envVar];
    if (!value) continue;
    return resolveCliOverride(value, envVar);
  }

  const packageCli = resolvePackageBin(avlPackageName, avlBinName);
  if (packageCli) return packageCli;

  const pathCli = findOnPath(avlBinName);
  if (pathCli) return { command: pathCli, args: [] };

  throw new Error([
    `${avlPackageName} CLI is required for AVL L3 validation.`,
    `Install the release dependency so its "${avlBinName}" bin is available, or set ${avlEnvVars.join(' or ')} to the CLI executable/dist/cli.js.`,
  ].join(' '));
}

function resolveCliOverride(value, envVar) {
  if (isExecutableFile(value)) return { command: value, args: [] };
  if (fs.existsSync(value) && fs.statSync(value).isFile() && path.extname(value) === '.js') {
    return { command: process.execPath, args: [value] };
  }

  const pathCli = findOnPath(value);
  if (pathCli) return { command: pathCli, args: [] };

  throw new Error(`${envVar} does not point to an executable CLI or JavaScript CLI file: ${value}`);
}

function resolvePackageBin(packageName, binName) {
  const packagePathParts = packageName.split('/');
  for (const root of packageSearchRoots()) {
    const packageJsonPath = path.join(root, 'node_modules', ...packagePathParts, 'package.json');
    if (!fs.existsSync(packageJsonPath)) continue;

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const binEntry = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.[binName];
    if (!binEntry) continue;

    const binPath = path.resolve(path.dirname(packageJsonPath), binEntry);
    if (isExecutableFile(binPath)) return { command: binPath, args: [] };
    if (fs.existsSync(binPath) && fs.statSync(binPath).isFile()) {
      return { command: process.execPath, args: [binPath] };
    }
  }
  return null;
}

function packageSearchRoots() {
  return [
    packageRoot,
    path.resolve(packageRoot, '..', '..', '..'),
    process.cwd(),
  ];
}

async function waitForServer(port, output) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < 4000) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/frontier/status`);
      await response.arrayBuffer();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`server did not start: ${lastError?.message ?? 'unknown'}\n${output()}`);
}

async function waitForHttp(url) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < 4000) {
    try {
      const response = await fetch(url);
      await response.arrayBuffer();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`server did not respond at ${url}: ${lastError?.message ?? 'unknown'}`);
}
