import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.FRONTIER_GOVERNANCE_REACT_TEST_PEER_FALLBACK = '1';

const {
  ApprovalPanel,
  ContractCard,
  OverrideControl,
  ReceiptTimeline,
  RuntimeHealthPanel,
} = await import('../src/index.mjs');

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

function render(element) {
  if (!element || typeof element !== 'object') return element;
  if (typeof element.type === 'function') return render(element.type(element.props ?? {}));
  const children = Array.isArray(element.props?.children)
    ? element.props.children.flat(Infinity).map(render)
    : render(element.props?.children);
  return { ...element, props: { ...(element.props ?? {}), children } };
}

function textContent(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  return textContent(node.props?.children);
}

function collect(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (predicate(node)) found.push(node);
  const children = Array.isArray(node.props?.children) ? node.props.children : [node.props?.children];
  for (const child of children.flat(Infinity)) collect(child, predicate, found);
  return found;
}

test('exports all governance components', () => {
  assert.equal(typeof ContractCard, 'function');
  assert.equal(typeof ApprovalPanel, 'function');
  assert.equal(typeof ReceiptTimeline, 'function');
  assert.equal(typeof RuntimeHealthPanel, 'function');
  assert.equal(typeof OverrideControl, 'function');
});

test('ContractCard renders core contract fields and allowed effects', () => {
  const tree = render(ContractCard({
    contract: {
      id: 'contract-1',
      goal_id: 'goal-1',
      status: 'approved',
      proposed_by: 'worker-a',
      verifier_id: 'verifier-b',
      scope: 'workspace:alpha',
      effect_allowlist: [{ effect: 'memory.write', scope: 'workspace:alpha' }],
    },
  }));

  assert.equal(tree.type, 'article');
  assert.match(tree.props['aria-labelledby'], /^fi-contract-card-/);
  const text = textContent(tree);
  assert.match(text, /contract-1/);
  assert.match(text, /worker-a/);
  assert.match(text, /memory.write/);
});

test('ApprovalPanel renders accessible approval records and action buttons', () => {
  const tree = render(ApprovalPanel({
    proposal: { id: 'proposal-1', effect: 'memory.write', scope: 'workspace:alpha' },
    approvals: [{ actor: 'verifier-b', status: 'approved' }],
    onApprove() {},
    onReject() {},
  }));

  const buttons = collect(tree, (node) => node.type === 'button');
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].props.type, 'button');
  assert.match(textContent(tree), /verifier-b/);
  assert.match(textContent(tree), /proposal-1/);
});

test('ReceiptTimeline and RuntimeHealthPanel render empty and issue states', () => {
  const emptyTimeline = render(ReceiptTimeline({ receipts: [] }));
  assert.match(textContent(emptyTimeline), /No receipts yet/);

  const health = render(RuntimeHealthPanel({
    report: {
      status: 'proposal-only',
      can_mutate: false,
      deployment_id: 'local',
      layers: { governance: { status: 'fail' } },
      propose_only: ['governance: missing verifier'],
    },
  }));
  assert.match(textContent(health), /Proposal-only or blocked/);
  assert.match(textContent(health), /missing verifier/);
});

test('OverrideControl requires acknowledgement when controlled', () => {
  const tree = render(OverrideControl({
    acknowledgement: false,
    onAcknowledgementChange() {},
    onEnable() {},
  }));
  const checkbox = collect(tree, (node) => node.type === 'input' && node.props.type === 'checkbox')[0];
  const button = collect(tree, (node) => node.type === 'button')[0];

  assert.match(checkbox.props.id, /^fi-override-control-/);
  assert.equal(button.props.disabled, true);
});

test('multiple component instances use unique labelledby targets', () => {
  const first = render(ContractCard({ contract: { id: 'contract-1' } }));
  const second = render(ContractCard({ contract: { id: 'contract-2' } }));
  const firstLabel = first.props['aria-labelledby'];
  const secondLabel = second.props['aria-labelledby'];

  assert.notEqual(firstLabel, secondLabel);
  assert.equal(collect(first, (node) => node.props?.id === firstLabel).length, 1);
  assert.equal(collect(second, (node) => node.props?.id === secondLabel).length, 1);
});

test('explicit ids are respected for labelled regions and controls', () => {
  const contract = render(ContractCard({ id: 'contract-alpha', contract: { id: 'contract-1' } }));
  const override = render(OverrideControl({ id: 'override-alpha', acknowledgement: false, onAcknowledgementChange() {} }));
  const checkbox = collect(override, (node) => node.type === 'input')[0];

  assert.equal(contract.props['aria-labelledby'], 'contract-alpha-title');
  assert.equal(checkbox.props.id, 'override-alpha-acknowledgement');
});

test('test fallback is explicitly gated and documented', () => {
  const source = fs.readFileSync(path.join(packageRoot, 'src/index.mjs'), 'utf8');
  const readme = fs.readFileSync(path.join(packageRoot, 'README.md'), 'utf8');

  assert.match(source, /FRONTIER_GOVERNANCE_REACT_TEST_PEER_FALLBACK/);
  assert.match(source, /requires React as a peer dependency/);
  assert.match(readme, /test fallback is gated/);
});

test('browser-like import without process global does not crash', async () => {
  const port = 23000 + Math.floor(Math.random() * 1000);
  const server = createGovernanceImportServer();
  try {
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    const output = await renderWithChromium(`http://127.0.0.1:${port}/`, 'governance-import-ok');

    assert.match(output, /governance-import-ok/);
    assert.doesNotMatch(output, /process is not defined/);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

function createGovernanceImportServer() {
  const governanceSource = fs.readFileSync(path.join(packageRoot, 'src/index.mjs'), 'utf8');
  const reactSource = [
    'export function createElement(type, props, ...children) {',
    '  return { type, props: { ...(props || {}), children } };',
    '}',
    'export function useId() { return "browser-id"; }',
  ].join('\n');
  const html = [
    '<!doctype html>',
    '<html><head>',
    '<script type="importmap">{"imports":{"react":"/react.mjs"}}</script>',
    '</head><body>',
    '<script type="module">',
    'delete globalThis.process;',
    'const mod = await import("/governance.mjs");',
    'document.body.append(String(typeof mod.ContractCard === "function" ? "governance-import-ok" : "governance-import-bad"));',
    '</script>',
    '</body></html>',
  ].join('');

  return http.createServer((req, res) => {
    if (req.url === '/governance.mjs') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(governanceSource);
      return;
    }
    if (req.url === '/react.mjs') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(reactSource);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
}

async function renderWithChromium(url, expectedText) {
  const chromiumBin = resolveChromiumExecutable();
  const debugPort = 25000 + Math.floor(Math.random() * 1000);
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
  try {
    const targets = await waitForJson(`http://127.0.0.1:${debugPort}/json`);
    const pageTarget = targets.find((target) => target.type === 'page') ?? targets[0];
    ws = await openCdp(pageTarget.webSocketDebuggerUrl);
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
    throw new Error(`Chromium render did not include ${expectedText}\n${html}`);
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
    'Chromium is required for the browser import smoke test.',
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
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result ?? {});
  });
  return {
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
}

test('package exports plain css theme', () => {
  const css = fs.readFileSync(path.join(packageRoot, 'src/style.css'), 'utf8');
  assert.match(css, /--fi-surface/);
  assert.match(css, /\.fi-card/);
});
