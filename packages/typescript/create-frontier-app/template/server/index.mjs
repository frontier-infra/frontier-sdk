import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { JsonlEventStore, createHarnessFromGoal } from '@frontier-infra/harness-kit';

import { readConfig } from './config.mjs';

class WriteGuardError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const config = readConfig();
const goal = JSON.parse(fs.readFileSync(path.join(__dirname, 'goal.example.json'), 'utf8'));
goal.deployment_id = config.frontier.deploymentId;
goal.proposed_by = config.frontier.workerId;
goal.worker_id = config.frontier.workerId;
goal.verifier_id = config.frontier.verifierId;
goal.contract.proposed_by = config.frontier.workerId;
goal.contract.verifier_id = config.frontier.verifierId;

const eventPath = path.join(rootDir, '.frontier-harness', 'events.jsonl');
const harness = createHarnessFromGoal(goal, {
  store: new JsonlEventStore(eventPath),
  now: () => new Date().toISOString(),
});

function json(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function publicFile(res, relativePath, contentType) {
  const filePath = path.join(rootDir, 'public', relativePath);
  if (!filePath.startsWith(path.join(rootDir, 'public'))) {
    json(res, 404, { error: 'not_found' });
    return;
  }
  res.writeHead(200, { 'content-type': contentType });
  res.end(fs.readFileSync(filePath));
}

function textAgentView(res) {
  const body = fs.readFileSync(path.join(rootDir, 'public', '.agent'), 'utf8');
  res.writeHead(200, {
    'content-type': 'text/agent-view; version=1; charset=utf-8',
    'x-agent-view-version': '1',
    link: '</agent.txt>; rel="agent-manifest"; type="text/plain"',
  });
  res.end(body);
}

function hostFromAuthority(value) {
  if (!value) return null;
  try {
    return new URL(`http://${value}`).hostname;
  } catch {
    return null;
  }
}

function isLoopbackHost(value) {
  const host = hostFromAuthority(value) ?? value;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function normalizeOrigin(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const normalized = normalizeOrigin(origin);
  return Boolean(normalized && config.frontier.allowedOrigins.includes(normalized));
}

async function readJsonBody(req) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new WriteGuardError(415, 'POST requests must use application/json');
  }
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 8192) throw new WriteGuardError(413, 'request body is too large');
  }
  let parsed;
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch {
    throw new WriteGuardError(400, 'request body must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WriteGuardError(400, 'request body must be a JSON object');
  }
  return parsed;
}

async function assertLocalWrite(req) {
  if (!isLoopbackHost(req.headers.host)) {
    throw new WriteGuardError(403, 'local write guard only allows loopback hosts');
  }
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) {
    throw new WriteGuardError(403, 'cross-site writes are blocked');
  }
  if (!isAllowedOrigin(req)) {
    throw new WriteGuardError(403, 'origin is not in FRONTIER_ALLOWED_ORIGINS');
  }
  const body = await readJsonBody(req);
  if (body.intent !== 'run_once') {
    throw new WriteGuardError(400, 'intent must be run_once');
  }
  return body;
}

function statusPayload() {
  const { report } = harness.runtimeHealth();
  const state = harness.state();
  return {
    config: {
      deploymentId: config.frontier.deploymentId,
      openai: config.openai,
      backingServices: {
        postgresConfigured: Boolean(config.backingServices.postgresUrl),
        redisConfigured: Boolean(config.backingServices.redisUrl),
        s3Configured: Boolean(config.backingServices.s3Endpoint && config.backingServices.s3Bucket),
      },
    },
    contract: state.contracts[goal.contract.id] ?? goal.contract,
    health: report,
    receipts: state.receipts,
    effects: state.effects,
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && (url.pathname === '/.agent' || url.pathname.endsWith('.agent'))) {
      textAgentView(res);
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/agent.txt' || url.pathname === '/llms.txt')) {
      publicFile(res, url.pathname.slice(1), 'text/plain; charset=utf-8');
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/.well-known/agent-view' || url.pathname === '/.well-known/avl')) {
      textAgentView(res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/.well-known/avl.json') {
      publicFile(res, '.well-known/avl.json', 'application/json; charset=utf-8');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/frontier/config') {
      json(res, 200, {
        frontier: config.frontier,
        openai: config.openai,
        backingServices: config.backingServices,
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/frontier/receipts') {
      json(res, 200, harness.state().receipts);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/frontier/status') {
      json(res, 200, statusPayload());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/frontier/run-once') {
      await assertLocalWrite(req);
      const result = await harness.runOnce();
      json(res, result.report.status === 'invalid' ? 422 : 200, {
        result,
        status: statusPayload(),
      });
      return;
    }
    json(res, 404, { error: 'not_found' });
  } catch (error) {
    json(res, error.status ?? 500, { error: error.status ? 'write_guard' : 'server_error', message: error.message });
  }
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`frontier worker server listening on http://127.0.0.1:${config.port}`);
});
