import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const typescriptRoot = path.resolve(packageRoot, '..');

const {
  HarnessEngine,
  proposalOnlyWorker,
  AdapterError,
  createAnthropicMessagesAdapter,
  createBrowserWorkerProposalPort,
  createGatedBusinessConnector,
  createLocalOpenAICompatibleAdapter,
  createOpenAICompatibleAdapter,
  createOperationalAlertConnector,
  createPostgresStatePort,
  createRedisQueuePort,
  createS3EvidenceReceiptPort,
  createS3ReceiptEvidenceSink,
  identityClaimExamples,
  normalizeAuth0Claims,
  normalizeClerkClaims,
  normalizeWorkOSClaims,
  operationalAlertIdempotencyKey,
  redactSecrets,
} = await importLocalPackageExports();

async function importLocalPackageExports() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-adapters-local-'));
  const scopeDir = path.join(sandbox, 'node_modules', '@frontier-infra');
  fs.mkdirSync(scopeDir, { recursive: true });

  for (const packageName of ['protocol', 'harness-kit', 'adapters']) {
    copyPackageForImport(path.join(typescriptRoot, packageName), path.join(scopeDir, packageName));
  }

  const bridgePath = path.join(sandbox, 'bridge.mjs');
  fs.writeFileSync(bridgePath, `
export { HarnessEngine, proposalOnlyWorker } from '@frontier-infra/harness-kit';
export {
  AdapterError,
  createAnthropicMessagesAdapter,
  createBrowserWorkerProposalPort,
  createGatedBusinessConnector,
  createLocalOpenAICompatibleAdapter,
  createOpenAICompatibleAdapter,
  createOperationalAlertConnector,
  createPostgresStatePort,
  createRedisQueuePort,
  createS3EvidenceReceiptPort,
  createS3ReceiptEvidenceSink,
  identityClaimExamples,
  normalizeAuth0Claims,
  normalizeClerkClaims,
  normalizeWorkOSClaims,
  operationalAlertIdempotencyKey,
  redactSecrets,
} from '@frontier-infra/adapters';
`);
  return import(pathToFileURL(bridgePath));
}

function copyPackageForImport(sourceDir, targetDir) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf8'));
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  for (const entry of packageJson.files ?? []) {
    fs.cpSync(path.join(sourceDir, entry), path.join(targetDir, entry), { recursive: true });
  }
}

const proposalEnvelope = {
  proposals: [{
    id: 'p1',
    type: 'effect',
    effect: 'crm.update',
    scope: 'workspace:alpha',
    payload: { name: 'Ada' },
    idempotency_key: 'crm:update:1',
  }],
};

function responseJson(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.headers,
  });
}

function happyGoal(overrides = {}) {
  return {
    id: 'goal-1',
    deployment_id: 'adapter-test',
    proposed_by: 'worker-1',
    now: '2026-08-06T12:00:00.000Z',
    contract: {
      id: 'contract-1',
      goal_id: 'goal-1',
      proposed_by: 'worker-1',
      verifier_id: 'verifier-1',
      scope: 'workspace:alpha',
      expires_at: '2026-08-06T13:00:00.000Z',
      success_criteria: ['connector commits'],
      effect_allowlist: [{ effect: 'crm.update', scope: 'workspace:alpha' }],
      autonomy_ceiling: 1,
      ...(overrides.contract ?? {}),
    },
    verifiers: [{
      id: 'verifier-1',
      scopes: ['workspace:alpha'],
      trust_ceiling: 1,
      verify: async ({ proposal_hash, contract_hash }) => ({
        passed: true,
        trust: 1,
        evidence_hash: 'adapter-test-evidence',
        proposal_hash,
        contract_hash,
      }),
      ...(overrides.verifier ?? {}),
    }],
    proposal: {
      id: 'p1',
      type: 'effect',
      effect: 'crm.update',
      scope: 'workspace:alpha',
      payload: { name: 'Ada' },
      idempotency_key: 'crm:update:1',
      ...(overrides.proposal ?? {}),
    },
  };
}

async function harnessWithCapability(overrides = {}) {
  const goal = happyGoal(overrides);
  const harness = new HarnessEngine({
    deployment_id: goal.deployment_id,
    goal: { ...goal, proposals: [goal.proposal] },
    worker: proposalOnlyWorker({ id: goal.proposed_by, contract: goal.contract, proposals: [goal.proposal] }),
    verifiers: goal.verifiers,
    adapters: [],
    operator_dial: 1,
    ...(overrides.harnessOptions ?? {}),
    now: overrides.now ?? goal.now,
  });
  harness.proposeContract();
  assert.equal(harness.ratifyContract('contract-1').ok, true);
  harness.store.append({
    type: 'worker_proposed',
    at: goal.now,
    idempotency_key: `proposal:${goal.proposal.id}`,
    worker_id: goal.proposed_by,
    proposal: goal.proposal,
  });
  const verified = await harness.recordProposalVerification(goal.proposal);
  assert.equal(verified.ok, true);
  const issued = harness.issueCapability(goal.proposal, overrides.capabilityOptions ?? {});
  assert.equal(issued.ok, true);
  return { goal, harness, capability: issued.capability };
}

test('OpenAI-compatible adapter validates endpoints and calls responses endpoint', async () => {
  assert.throws(() => createOpenAICompatibleAdapter({
    baseUrl: 'http://api.example.com',
    model: 'model',
    fetch() {},
  }), /HTTPS/);

  const calls = [];
  const adapter = createOpenAICompatibleAdapter({
    baseUrl: 'https://api.example.com/custom',
    apiKey: 'sk-secret',
    model: 'model',
    fetch: async (url, init) => {
      calls.push({ url, init });
      return responseJson({ output_text: JSON.stringify(proposalEnvelope) });
    },
  });

  const proposals = await adapter.propose({ prompt: 'propose' });
  assert.equal(calls[0].url, 'https://api.example.com/custom/v1/responses');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-secret');
  assert.equal(JSON.parse(calls[0].init.body).model, 'model');
  assert.deepEqual(proposals, proposalEnvelope.proposals);
  assert.equal(typeof adapter.apply, 'undefined');

  const v1Calls = [];
  const v1 = createOpenAICompatibleAdapter({
    baseUrl: 'https://api.example.com/v1',
    model: 'model',
    fetch: async (url) => {
      v1Calls.push(url);
      return responseJson({ output_text: JSON.stringify(proposalEnvelope) });
    },
  });
  await v1.propose({ prompt: 'propose' });
  assert.equal(v1Calls[0], 'https://api.example.com/v1/responses');
});

test('chat, local OpenAI-compatible, and Anthropic adapters hit explicit proposal endpoints', async () => {
  const chatCalls = [];
  const chat = createOpenAICompatibleAdapter({
    baseUrl: 'https://chat.example.com',
    model: 'chat-model',
    mode: 'chat',
    fetch: async (url, init) => {
      chatCalls.push({ url, init });
      return responseJson({ choices: [{ message: { content: JSON.stringify(proposalEnvelope) } }] });
    },
  });
  await chat.propose({ messages: [{ role: 'user', content: 'proposal json' }] });
  assert.equal(chatCalls[0].url, 'https://chat.example.com/v1/chat/completions');

  const local = createLocalOpenAICompatibleAdapter({
    baseUrl: 'http://localhost:11434',
    model: 'local-model',
    fetch: async () => responseJson({ output_text: JSON.stringify(proposalEnvelope) }),
  });
  assert.equal(local.baseUrl, 'http://localhost:11434');
  assert.throws(() => createLocalOpenAICompatibleAdapter({
    baseUrl: 'https://remote.example.com',
    requireLocal: false,
    model: 'local-model',
    fetch() {},
  }), /localhost/);

  const anthropicCalls = [];
  const anthropic = createAnthropicMessagesAdapter({
    baseUrl: 'https://anthropic.example.com',
    apiKey: 'ant-secret',
    model: 'claude',
    fetch: async (url, init) => {
      anthropicCalls.push({ url, init });
      return responseJson({ content: [{ type: 'text', text: JSON.stringify(proposalEnvelope) }] });
    },
  });
  await anthropic.propose({ prompt: 'proposal json' });
  assert.equal(anthropicCalls[0].url, 'https://anthropic.example.com/v1/messages');
  assert.equal(anthropicCalls[0].init.headers['x-api-key'], 'ant-secret');
  assert.equal(anthropicCalls[0].init.headers['anthropic-version'], '2023-06-01');
});

test('provider errors redact secrets and malformed output fails closed', async () => {
  const adapter = createOpenAICompatibleAdapter({
    baseUrl: 'https://api.example.com',
    apiKey: 'sk-should-not-leak',
    model: 'model',
    fetch: async () => new Response('{"error":"bad"}', { status: 401 }),
  });

  await assert.rejects(
    () => adapter.propose({ prompt: 'x' }),
    (error) => {
      assert.equal(error.code, 'provider_error');
      assert.doesNotMatch(JSON.stringify(error), /sk-should-not-leak/);
      assert.doesNotMatch(JSON.stringify(error), /bad/);
      return true;
    },
  );

  const malformed = createOpenAICompatibleAdapter({
    baseUrl: 'https://api.example.com',
    model: 'model',
    fetch: async () => responseJson({ output_text: 'not json' }),
  });
  await assert.rejects(() => malformed.propose({ prompt: 'x' }), /model output was not valid JSON/);

  const invalidProviderJson = createOpenAICompatibleAdapter({
    baseUrl: 'https://api.example.com',
    model: 'model',
    fetch: async () => new Response('secret-bearing raw response', { status: 200 }),
  });
  await assert.rejects(
    () => invalidProviderJson.propose({ prompt: 'x' }),
    (error) => {
      assert.equal(error.code, 'invalid_provider_response');
      assert.doesNotMatch(JSON.stringify(error), /secret-bearing/);
      return true;
    },
  );

  const redacted = redactSecrets({ token: 'tok_abc123', nested: { client_secret: 'secret' } });
  assert.deepEqual(redacted, { token: '[REDACTED]', nested: { client_secret: '[REDACTED]' } });
});

test('fetch and browser worker proposal ports enforce timeouts and size caps', async () => {
  const timeout = createOpenAICompatibleAdapter({
    baseUrl: 'https://api.example.com',
    model: 'model',
    timeoutMs: 10,
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
  });
  await assert.rejects(() => timeout.propose({ prompt: 'x' }), (error) => error.code === 'timeout');

  const tooLarge = createOpenAICompatibleAdapter({
    baseUrl: 'https://api.example.com',
    model: 'model',
    maxResponseBytes: 5,
    fetch: async () => responseJson({ output_text: JSON.stringify(proposalEnvelope) }),
  });
  await assert.rejects(() => tooLarge.propose({ prompt: 'x' }), (error) => error.code === 'response_too_large');

  const worker = createBrowserWorkerProposalPort({
    request: async () => ({ proposals: proposalEnvelope.proposals }),
  });
  assert.deepEqual(await worker.propose({ goal: 'g' }), proposalEnvelope.proposals);
  assert.equal(typeof worker.apply, 'undefined');

  const malformedWorker = createBrowserWorkerProposalPort({ request: async () => ({ nope: [] }) });
  await assert.rejects(() => malformedWorker.propose({}), /browser worker output must contain proposals/);
});

test('identity claim normalizers cover Clerk, Auth0, and WorkOS shapes', () => {
  assert.deepEqual(normalizeClerkClaims({
    sub: 'user_1',
    email_address: 'a@example.com',
    email_verified: true,
    org_id: 'org_1',
    org_role: 'admin',
    roles: ['admin', 'member'],
  }), {
    provider: 'clerk',
    subject: 'user_1',
    email: 'a@example.com',
    email_verified: true,
    organization_id: 'org_1',
    roles: ['admin', 'member'],
  });

  assert.deepEqual(normalizeAuth0Claims({
    sub: 'auth0|1',
    email: 'a@example.com',
    email_verified: true,
    'https://example.com/roles': ['editor'],
  }), {
    provider: 'auth0',
    subject: 'auth0|1',
    email: 'a@example.com',
    email_verified: true,
    organization_id: undefined,
    roles: ['editor'],
  });

  assert.deepEqual(normalizeWorkOSClaims({
    user_id: 'user_1',
    email: 'a@example.com',
    organization_id: 'org_1',
    role: 'member',
  }), {
    provider: 'workos',
    subject: 'user_1',
    email: 'a@example.com',
    email_verified: false,
    organization_id: 'org_1',
    roles: ['member'],
  });

  assert.equal(identityClaimExamples.clerk.normalized.provider, 'clerk');
});

test('storage ports fail closed on client errors', async () => {
  assert.throws(() => createPostgresStatePort({ table: 'frontier_state; drop table users', client: { query: async () => ({ rows: [] }) } }), /identifier/);

  const pg = createPostgresStatePort({ client: { query: async () => { throw new Error('database unavailable'); } } });
  await assert.rejects(() => pg.loadState('goal-1'), (error) => {
    assert.equal(error.code, 'storage_failed_closed');
    assert.match(error.message, /postgres/);
    return true;
  });

  const redis = createRedisQueuePort({ client: { sendCommand: async () => { throw new Error('redis unavailable'); } } });
  await assert.rejects(() => redis.claimIdempotency('idem-1'), (error) => error.code === 'storage_failed_closed');

  const s3 = createS3EvidenceReceiptPort({ bucket: 'evidence', client: { putObject: async () => { throw new Error('s3 unavailable'); } } });
  await assert.rejects(() => s3.putReceipt('receipt.json', { receipt_hash: 'abc' }), (error) => error.code === 'storage_failed_closed');
});

test('storage ports pass through dependency-injected clients without SDK dependencies', async () => {
  const pgCalls = [];
  const pg = createPostgresStatePort({
    client: {
      query: async (query) => {
        pgCalls.push(query);
        return { rows: [{ state: { ok: true }, version: 2 }] };
      },
    },
  });
  assert.deepEqual(await pg.loadState('goal-1'), { state: { ok: true }, version: 2 });
  assert.equal(pgCalls[0].values[0], 'goal-1');
  assert.match(pgCalls[0].text, /from "frontier_state"/);

  await assert.rejects(
    () => createPostgresStatePort({ client: { query: async () => ({ rows: [] }) } }).saveState('goal-1', { ok: true }, { expectedVersion: 1 }),
    (error) => error.code === 'storage_conflict',
  );
  const optimisticCalls = [];
  await createPostgresStatePort({
    client: {
      query: async (query) => {
        optimisticCalls.push(query);
        return { rows: [{ version: 3 }] };
      },
    },
  }).saveState('goal-1', { ok: true }, { expectedVersion: 2 });
  assert.match(optimisticCalls[0].text, /where key = \$1 and version = \$3/);
  assert.deepEqual(optimisticCalls[0].values, ['goal-1', { ok: true }, 2]);

  const redisCalls = [];
  const redis = createRedisQueuePort({
    client: {
      sendCommand: async (command, args) => {
        redisCalls.push([command, args]);
        return command === 'SET' ? 'OK' : 1;
      },
    },
  });
  assert.deepEqual(await redis.enqueue('work', { id: 1 }, 'idem-1'), { ok: true, id: 'idem-1' });
  assert.equal(redisCalls.length, 1);
  assert.equal(redisCalls[0][0], 'EVAL');
  assert.match(redisCalls[0][1][0], /LPUSH/);

  const s3Calls = [];
  const s3 = createS3EvidenceReceiptPort({
    bucket: 'evidence',
    client: { putObject: async (input) => { s3Calls.push(input); } },
  });
  assert.equal((await s3.putReceipt('r.json', { ok: true, token_hash: 'safe-hash' })).ok, true);
  assert.equal(s3Calls[0].Bucket, 'evidence');
  assert.equal(JSON.parse(new TextDecoder().decode(s3Calls[0].Body)).token_hash, 'safe-hash');
});

test('S3 evidence preserves exact bytes, records checksum metadata, and rejects raw secrets', async () => {
  const calls = [];
  const receipt = '{"receipt_hash":"abc","token_hash":"safe","nested":{"ok":true}}';
  const s3 = createS3EvidenceReceiptPort({
    bucket: 'evidence',
    client: { putObject: async (input) => { calls.push(input); } },
  });
  const result = await s3.putReceipt('receipt.json', receipt);
  const expectedHash = crypto.createHash('sha256').update(receipt).digest('hex');
  assert.equal(result.sha256, expectedHash);
  assert.equal(calls[0].Metadata.sha256, expectedHash);
  assert.equal(calls[0].ChecksumSHA256, crypto.createHash('sha256').update(receipt).digest('base64'));
  assert.equal(new TextDecoder().decode(calls[0].Body), receipt);

  await assert.rejects(
    () => s3.putReceipt('bad.json', { receipt_hash: 'abc', token: 'raw-secret' }),
    (error) => error.code === 'forbidden_secret_field',
  );
  await assert.rejects(
    () => s3.putReceipt('bad-string.json', '{"receipt_hash":"abc","nested":{"password":"raw-secret"}}'),
    (error) => error.code === 'forbidden_secret_field',
  );
  await assert.rejects(
    () => s3.putReceipt('bad-bytes.json', new TextEncoder().encode('{"authorization":"Bearer raw-secret"}')),
    (error) => error.code === 'forbidden_secret_field',
  );
  await assert.rejects(
    () => s3.putReceipt('invalid-json.json', '{"receipt_hash":'),
    (error) => error.code === 'invalid_receipt',
  );
  await assert.rejects(
    () => s3.putReceipt('invalid-utf8.json', new Uint8Array([0xc3, 0x28])),
    (error) => error.code === 'invalid_receipt',
  );

  const capped = createS3EvidenceReceiptPort({
    bucket: 'evidence',
    maxReceiptBytes: 3,
    client: { putObject: async () => {} },
  });
  await assert.rejects(() => capped.putReceipt('large.json', '1234'), (error) => error.code === 'receipt_too_large');
});

test('explicit S3 receipt/evidence sink is the byte-preserving receipt port', async () => {
  const calls = [];
  const sink = createS3ReceiptEvidenceSink({
    bucket: 'receipts',
    client: { putObject: async (input) => { calls.push(input); } },
  });
  assert.equal(sink.kind, 'evidence-port');
  assert.equal(typeof sink.putReceipt, 'function');
  assert.equal(typeof sink.putEvidence, 'undefined');
  const receipt = { receipt_hash: 'abc', result: 'verified' };
  const stored = await sink.putReceipt('aar/abc.json', receipt);
  assert.equal(stored.ok, true);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(calls[0].Body)), receipt);
});

test('Redis queue ack atomically removes its envelope and is stable for missing or duplicate ids', async () => {
  const queues = new Map();
  const claimed = new Set();
  const client = {
    async sendCommand(command, args) {
      assert.equal(command, 'EVAL');
      const [script] = args;
      if (script.includes("redis.call('LPUSH'")) {
        const [, , queueKey, idemKey, payload] = args;
        if (claimed.has(idemKey)) return 0;
        claimed.add(idemKey);
        queues.set(queueKey, [payload, ...(queues.get(queueKey) ?? [])]);
        return 1;
      }
      if (script.includes("redis.call('LRANGE'")) {
        const [, , queueKey, id] = args;
        const entries = queues.get(queueKey) ?? [];
        const index = entries.findIndex((raw) => {
          const entry = JSON.parse(raw);
          return entry.id === id || entry.idempotency_key === id;
        });
        if (index < 0) return 0;
        entries.splice(index, 1);
        return 1;
      }
      throw new Error('unexpected script');
    },
  };
  const redis = createRedisQueuePort({ client });

  assert.deepEqual(await redis.enqueue('work', { task: 1 }, 'job-1'), { ok: true, id: 'job-1' });
  assert.deepEqual(await redis.enqueue('work', { task: 2 }, 'job-2'), { ok: true, id: 'job-2' });
  assert.deepEqual(await redis.enqueue('work', { task: 'replay' }, 'job-1'), { ok: false, duplicate: true, id: 'job-1' });
  assert.equal(queues.get('frontier:queue:work').length, 2);

  assert.deepEqual(await redis.ack('work', 'job-1'), { ok: true });
  assert.deepEqual(JSON.parse(queues.get('frontier:queue:work')[0]), {
    id: 'job-2',
    idempotency_key: 'job-2',
    item: { task: 2 },
  });
  assert.deepEqual(await redis.ack('work', 'job-1'), { ok: false });
  assert.deepEqual(await redis.ack('work', 'does-not-exist'), { ok: false });
  assert.equal(queues.get('frontier:queue:work').length, 1);
});

test('storage adapter failures never expose raw downstream error messages', async () => {
  const secret = 'downstream-secret-value-that-must-not-leak';
  const failure = Object.assign(new Error(secret), { name: `Custom${secret}`, code: secret });
  const adapters = [
    () => createPostgresStatePort({ client: { query: async () => { throw failure; } } }).loadState('goal-1'),
    () => createRedisQueuePort({ client: { sendCommand: async () => { throw failure; } } }).claimIdempotency('idem-1'),
    () => createS3EvidenceReceiptPort({ bucket: 'evidence', client: { putObject: async () => { throw failure; } } }).putReceipt('receipt.json', { receipt_hash: 'abc' }),
  ];
  for (const invoke of adapters) {
    await assert.rejects(invoke, (error) => {
      assert.equal(error.code, 'storage_failed_closed');
      assert.doesNotMatch(JSON.stringify(error), new RegExp(secret));
      assert.deepEqual(error.details.cause, { name: 'Error' });
      return true;
    });
  }
});

test('gated connector is opaque and executes only through the harness', async () => {
  let calls = 0;
  const connector = createGatedBusinessConnector({
    id: 'crm',
    effect: 'crm.update',
    scopes: ['*'],
    client: {},
    execute: async ({ proposal, capability }) => {
      calls += 1;
      assert.equal(capability.token, undefined);
      return { updated: proposal.payload.name };
    },
  });
  assert.equal(typeof connector.execute, 'undefined');
  assert.equal(typeof connector.mutate, 'undefined');
  assert.equal(typeof connector.apply, 'undefined');

  const { goal, harness, capability } = await harnessWithCapability({ harnessOptions: { adapters: [connector] } });
  const missing = await harness.executeCapability({ proposal: goal.proposal, adapter_id: 'crm' });
  assert.equal(missing.status, 'rejected');
  assert.match(missing.reason, /missing capability/);
  assert.equal(calls, 0);

  const wrongScope = await harness.executeCapability({
    proposal: { ...goal.proposal, scope: 'workspace:beta' },
    capability,
    adapter_id: 'crm',
  });
  assert.equal(wrongScope.status, 'rejected');
  assert.match(wrongScope.reason, /proposal hash/);
  assert.equal(calls, 0);

  const wrongToken = await harness.executeCapability({
    proposal: goal.proposal,
    capability: { ...capability, token: 'wrong' },
    adapter_id: 'crm',
  });
  assert.equal(wrongToken.status, 'rejected');
  assert.match(wrongToken.reason, /token/);
  assert.equal(calls, 0);

  const unknownCapability = await harness.executeCapability({
    proposal: goal.proposal,
    capability: { ...capability, id: 'not-issued' },
    adapter_id: 'crm',
  });
  assert.equal(unknownCapability.status, 'rejected');
  assert.match(unknownCapability.reason, /forged|unknown/);
  assert.equal(calls, 0);

  const expiredContext = await harnessWithCapability({
    capabilityOptions: { expires_at: '2026-08-06T12:00:01.000Z' },
    harnessOptions: { adapters: [connector] },
  });
  expiredContext.harness.now = '2026-08-06T12:00:02.000Z';
  const expired = await expiredContext.harness.executeCapability({
    proposal: expiredContext.goal.proposal,
    capability: expiredContext.capability,
    adapter_id: 'crm',
  });
  assert.equal(expired.status, 'rejected');
  assert.match(expired.reason, /expired/);
  assert.equal(calls, 0);

  const successContext = await harnessWithCapability({ harnessOptions: { adapters: [connector] } });
  const committed = await successContext.harness.executeCapability({
    proposal: successContext.goal.proposal,
    capability: successContext.capability,
    adapter_id: 'crm',
  });
  assert.equal(committed.status, 'committed');
  assert.deepEqual(committed.result, { updated: 'Ada' });
  assert.equal(calls, 1);
  assert.equal(successContext.harness.store.list().some((event) => event.event.type === 'effect_committed'), true);

  const replay = await successContext.harness.executeCapability({
    proposal: successContext.goal.proposal,
    capability: successContext.capability,
    adapter_id: 'crm',
  });
  assert.equal(replay.status, 'duplicate');
  assert.equal(calls, 1);

  const unregistered = await successContext.harness.executeCapability({
    proposal: successContext.goal.proposal,
    capability: successContext.capability,
    adapter_id: 'notes',
  });
  assert.equal(unregistered.status, 'rejected');
  assert.match(unregistered.reason, /not registered/);
});

test('operational alerts require an exact one-time gate and deliver only normalized redacted content', async () => {
  const delivered = [];
  const privateClient = Object.freeze({ channel: 'ops' });
  const connector = createOperationalAlertConnector({
    id: 'ops-alerts',
    scopes: ['workspace:alpha'],
    client: privateClient,
    deliver: async (input) => {
      delivered.push(input);
      return { accepted: true };
    },
  });
  assert.deepEqual(Object.keys(connector).sort(), ['effect', 'id', 'scopes']);
  assert.equal(typeof connector.send, 'undefined');
  assert.equal(typeof connector.deliver, 'undefined');
  assert.equal(typeof connector.execute, 'undefined');
  assert.equal(typeof connector.apply, 'undefined');

  const payload = {
    severity: ' WARNING ',
    message: 'Authorization=Bearer private-value queue delayed',
    context: {
      depth: 42,
      api_key: 'raw-key',
      note: 'token=tok_hidden and password=hunter2',
    },
  };
  const proposal = {
    id: 'alert-1',
    type: 'effect',
    effect: 'operations.alert.deliver',
    scope: 'workspace:alpha',
    payload,
    idempotency_key: operationalAlertIdempotencyKey({ scope: 'workspace:alpha', payload }),
  };
  const harnessForAlert = () => harnessWithCapability({
    contract: {
      effect_allowlist: [{ effect: proposal.effect, scope: proposal.scope }],
    },
    proposal,
    harnessOptions: { adapters: [connector] },
  });
  const context = await harnessForAlert();

  const missing = await context.harness.executeCapability({ proposal, adapter_id: connector.id });
  assert.equal(missing.status, 'rejected');
  const forged = await context.harness.executeCapability({
    proposal,
    capability: { ...context.capability, token: 'forged' },
    adapter_id: connector.id,
  });
  assert.equal(forged.status, 'rejected');
  const wrongScope = await context.harness.executeCapability({
    proposal: { ...proposal, scope: 'workspace:beta' },
    capability: context.capability,
    adapter_id: connector.id,
  });
  assert.equal(wrongScope.status, 'rejected');
  assert.equal(delivered.length, 0);

  const successContext = await harnessForAlert();
  const committed = await successContext.harness.executeCapability({
    proposal,
    capability: successContext.capability,
    adapter_id: connector.id,
  });
  assert.equal(committed.status, 'committed');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].client, privateClient);
  assert.equal(delivered[0].alert.severity, 'warning');
  assert.doesNotMatch(JSON.stringify(delivered[0].alert), /private-value|raw-key|tok_hidden|hunter2/);
  assert.match(delivered[0].alert.message, /\[REDACTED\]/);
  assert.equal(delivered[0].alert.context.api_key, '[REDACTED]');
  assert.equal(delivered[0].capability.token, undefined);

  const replay = await successContext.harness.executeCapability({
    proposal,
    capability: successContext.capability,
    adapter_id: connector.id,
  });
  assert.equal(replay.status, 'duplicate');
  assert.equal(delivered.length, 1);
});

test('operational alerts enforce canonical idempotency, severity allowlist, and byte caps before delivery', async () => {
  assert.throws(
    () => operationalAlertIdempotencyKey({ scope: 'workspace:alpha', payload: { severity: 'debug', message: 'x' } }),
    (error) => error.code === 'invalid_alert_severity',
  );
  assert.throws(
    () => operationalAlertIdempotencyKey({ scope: 'workspace:alpha', payload: { severity: 'info', message: 'éé' } }, { maxMessageBytes: 3 }),
    (error) => error.code === 'alert_message_too_large',
  );
  assert.throws(
    () => operationalAlertIdempotencyKey({ scope: 'workspace:alpha', payload: { severity: 'info', message: 'x', context: { value: '1234' } } }, { maxContextBytes: 3 }),
    (error) => error.code === 'alert_context_too_large',
  );

  let calls = 0;
  const payload = { severity: 'critical', message: 'service unavailable', context: {} };
  const proposal = {
    id: 'alert-bad-idempotency',
    type: 'effect',
    effect: 'operations.alert.deliver',
    scope: 'workspace:alpha',
    payload,
    idempotency_key: 'caller-controlled-key',
  };
  const connector = createOperationalAlertConnector({
    id: 'ops-alerts',
    scopes: ['workspace:alpha'],
    deliver: async () => { calls += 1; },
  });
  const context = await harnessWithCapability({
    contract: { effect_allowlist: [{ effect: proposal.effect, scope: proposal.scope }] },
    proposal,
    harnessOptions: { adapters: [connector] },
  });
  const result = await context.harness.executeCapability({ proposal, capability: context.capability, adapter_id: connector.id });
  assert.equal(result.status, 'ambiguous');
  assert.equal(calls, 0);
});

test('operational alert delivery failures stay ambiguous and do not expose downstream secrets', async () => {
  const secret = 'alert-provider-secret-that-must-not-leak';
  const payload = { severity: 'critical', message: 'provider unavailable', context: {} };
  const proposal = {
    id: 'alert-failure',
    type: 'effect',
    effect: 'operations.alert.deliver',
    scope: 'workspace:alpha',
    payload,
    idempotency_key: operationalAlertIdempotencyKey({ scope: 'workspace:alpha', payload }),
  };
  const connector = createOperationalAlertConnector({
    id: 'ops-alerts',
    scopes: ['workspace:alpha'],
    deliver: async () => { throw new Error(secret); },
  });
  const context = await harnessWithCapability({
    contract: { effect_allowlist: [{ effect: proposal.effect, scope: proposal.scope }] },
    proposal,
    harnessOptions: { adapters: [connector] },
  });
  const result = await context.harness.executeCapability({ proposal, capability: context.capability, adapter_id: connector.id });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.ambiguous, true);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  assert.equal(context.harness.store.list().some((entry) => entry.event.type === 'effect_committed'), false);
});

test('gated connector rejects non-one-time capabilities before client execution', async () => {
  let calls = 0;
  const connector = createGatedBusinessConnector({
    id: 'crm',
    effect: 'crm.update',
    execute: async () => { calls += 1; },
  });
  const { goal, harness, capability } = await harnessWithCapability({
    capabilityOptions: { one_time: false },
    harnessOptions: { adapters: [connector] },
  });
  const result = await harness.executeCapability({ proposal: goal.proposal, capability, adapter_id: 'crm' });
  assert.equal(result.status, 'rejected');
  assert.match(result.reason, /one-time/);
  assert.equal(calls, 0);
});

test('execute failure records failed reservation without committed effect', async () => {
  let calls = 0;
  const connector = createGatedBusinessConnector({
    id: 'crm',
    effect: 'crm.update',
    execute: async () => {
      calls += 1;
      throw new Error('upstream outcome unknown');
    },
  });
  const { goal, harness, capability } = await harnessWithCapability({ harnessOptions: { adapters: [connector] } });

  const result = await harness.executeCapability({ proposal: goal.proposal, capability, adapter_id: 'crm' });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.ambiguous, true);
  assert.equal(calls, 1);
  assert.equal(harness.store.list().some((event) => event.event.type === 'capability_reservation_failed'), true);
  assert.equal(harness.store.list().some((event) => event.event.type === 'effect_committed'), false);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(capability.token));
});

test('concurrent replay reservation is rejected while executor runs only once', async () => {
  let calls = 0;
  let release;
  const started = new Promise((resolve) => { release = resolve; });
  const connector = createGatedBusinessConnector({
    id: 'crm',
    effect: 'crm.update',
    execute: async () => {
      calls += 1;
      await started;
      return { ok: true };
    },
  });
  const { goal, harness, capability } = await harnessWithCapability({ harnessOptions: { adapters: [connector] } });

  const first = harness.executeCapability({ proposal: goal.proposal, capability, adapter_id: 'crm' });
  const second = harness.executeCapability({ proposal: goal.proposal, capability, adapter_id: 'crm' });
  release();
  const results = await Promise.all([first, second]);
  assert.equal(results.filter((result) => result.status === 'committed').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.match(rejected.reason, /already reserved/);
  assert.equal(calls, 1);
});

test('gated connector uses current harness-kit reservation lifecycle without false commits', async () => {
  let calls = 0;
  const connector = createGatedBusinessConnector({
    id: 'crm',
    effect: 'crm.update',
    scopes: ['workspace:alpha'],
    execute: async ({ proposal }) => {
      calls += 1;
      return { updated: proposal.payload.name };
    },
  });
  const { goal, harness, capability } = await harnessWithCapability({ harnessOptions: { adapters: [connector] } });

  const committed = await harness.executeCapability({ proposal: goal.proposal, capability, adapter_id: 'crm' });
  assert.equal(committed.status, 'committed');
  assert.deepEqual(committed.result, { updated: 'Ada' });
  assert.equal(calls, 1);
  assert.equal(harness.state().effects['crm:update:1'].updated, 'Ada');

  const replay = await harness.executeCapability({ proposal: goal.proposal, capability, adapter_id: 'crm' });
  assert.equal(replay.status, 'duplicate');
  assert.equal(calls, 1);
});

test('packed adapter package imports public harness-kit export with packed dependency chain', async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-adapters-packed-'));
  const tarballDir = path.join(sandbox, 'tarballs');
  const consumerDir = path.join(sandbox, 'consumer');
  fs.mkdirSync(tarballDir, { recursive: true });
  fs.mkdirSync(consumerDir, { recursive: true });

  const protocolTarball = await packLocalPackage('protocol', tarballDir, sandbox);
  const harnessTarball = await packLocalPackage('harness-kit', tarballDir, sandbox);
  const adaptersTarball = await packLocalPackage('adapters', tarballDir, sandbox);

  fs.writeFileSync(path.join(consumerDir, 'package.json'), `${JSON.stringify({
    type: 'module',
    private: true,
    dependencies: {
      '@frontier-infra/protocol': `file:${protocolTarball}`,
      '@frontier-infra/harness-kit': `file:${harnessTarball}`,
      '@frontier-infra/adapters': `file:${adaptersTarball}`,
    },
  }, null, 2)}\n`);

  await execFile('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--fund=false', '--package-lock=false'], {
    cwd: consumerDir,
    env: npmTestEnv(sandbox),
  });

  const consumerScript = path.join(consumerDir, 'consumer.mjs');
  fs.writeFileSync(consumerScript, `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createGatedBusinessConnector } from '@frontier-infra/adapters';
import { HarnessEngine, proposalOnlyWorker } from '@frontier-infra/harness-kit';
import { PROTOCOL_PACKAGE_VERSION } from '@frontier-infra/protocol';

const adapterSource = fs.readFileSync(path.join(process.cwd(), 'node_modules/@frontier-infra/adapters/src/index.mjs'), 'utf8');
assert.doesNotMatch(adapterSource, /\\.\\.\\/\\.\\.\\/harness-kit\\/src/);
assert.equal(PROTOCOL_PACKAGE_VERSION, '0.1.0');

const proposal = {
  id: 'p1',
  type: 'effect',
  effect: 'crm.update',
  scope: 'workspace:alpha',
  payload: { name: 'Ada' },
  idempotency_key: 'crm:update:packed',
};
const contract = {
  id: 'contract-1',
  goal_id: 'goal-1',
  proposed_by: 'worker-1',
  verifier_id: 'verifier-1',
  scope: 'workspace:alpha',
  expires_at: '2026-08-06T13:00:00.000Z',
  success_criteria: ['connector commits'],
  effect_allowlist: [{ effect: 'crm.update', scope: 'workspace:alpha' }],
  autonomy_ceiling: 1,
};
const connector = createGatedBusinessConnector({
  id: 'crm',
  effect: 'crm.update',
  scopes: ['workspace:alpha'],
  execute: async ({ proposal }) => ({ updated: proposal.payload.name }),
});
const harness = new HarnessEngine({
  deployment_id: 'packed-consumer',
  goal: { id: 'goal-1', deployment_id: 'packed-consumer', proposed_by: 'worker-1', contract, proposals: [proposal] },
  worker: proposalOnlyWorker({ id: 'worker-1', contract, proposals: [proposal] }),
  verifiers: [{
    id: 'verifier-1',
    scopes: ['workspace:alpha'],
    trust_ceiling: 1,
    verify: async ({ proposal_hash, contract_hash }) => ({
      passed: true,
      trust: 1,
      evidence_hash: 'packed-consumer-evidence',
      proposal_hash,
      contract_hash,
    }),
  }],
  adapters: [connector],
  operator_dial: 1,
  now: '2026-08-06T12:00:00.000Z',
});

harness.proposeContract();
assert.equal(harness.ratifyContract('contract-1').ok, true);
harness.store.append({
  type: 'worker_proposed',
  at: '2026-08-06T12:00:00.000Z',
  idempotency_key: 'proposal:p1',
  worker_id: 'worker-1',
  proposal,
});
assert.equal((await harness.recordProposalVerification(proposal)).ok, true);
const issued = harness.issueCapability(proposal);
assert.equal(issued.ok, true);
const committed = await harness.executeCapability({ proposal, capability: issued.capability, adapter_id: 'crm' });
assert.equal(committed.status, 'committed');
assert.deepEqual(committed.result, { updated: 'Ada' });
`);

  await execFile(process.execPath, [consumerScript], {
    cwd: consumerDir,
    env: npmTestEnv(sandbox),
  });
});

async function packLocalPackage(packageName, tarballDir, sandbox) {
  const { stdout } = await execFile('npm', [
    'pack',
    path.join(typescriptRoot, packageName),
    '--pack-destination',
    tarballDir,
    '--silent',
  ], {
    env: npmTestEnv(sandbox),
  });
  const tarballName = stdout.trim().split(/\r?\n/).at(-1);
  assert.ok(tarballName, `npm pack ${packageName} produced a tarball`);
  return path.join(tarballDir, tarballName);
}

function npmTestEnv(sandbox) {
  return {
    ...process.env,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_cache: path.join(sandbox, '.npm-cache'),
  };
}

test('AdapterError serializes only redacted details', () => {
  const error = new AdapterError('x', 'failed', { apiKey: 'secret', nested: { authorization: 'Bearer nope' } });
  assert.deepEqual(error.toJSON().details, { apiKey: '[REDACTED]', nested: { authorization: '[REDACTED]' } });
});
