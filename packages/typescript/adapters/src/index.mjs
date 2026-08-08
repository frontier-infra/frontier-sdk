import crypto from 'node:crypto';
import { createEffectAdapter } from '@frontier-infra/harness-kit';

export const ADAPTERS_PACKAGE_VERSION = '0.1.0';
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
export const DEFAULT_MAX_PROPOSAL_BYTES = 64_000;
export const DEFAULT_MAX_RECEIPT_BYTES = 1_000_000;
export const DEFAULT_MAX_ALERT_MESSAGE_BYTES = 4_096;
export const DEFAULT_MAX_ALERT_CONTEXT_BYTES = 16_384;
export const OPERATIONAL_ALERT_EFFECT = 'operations.alert.deliver';
export const OPERATIONAL_ALERT_SEVERITIES = Object.freeze(['info', 'warning', 'critical']);

const REDACTED = '[REDACTED]';
const SECRET_KEY_PATTERN = /(?:api[_-]?key|authorization|bearer|client[_-]?secret|cookie|password|secret|session|token)/i;
const FORBIDDEN_RAW_SECRET_FIELD_PATTERN = /^(?:api[_-]?key|authorization|client[_-]?secret|cookie|password|secret|session|token)$/i;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const IDENTIFIER_SEGMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class AdapterError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    this.details = redact(details);
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AdapterError('invalid_input', `${name} must be an object`);
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AdapterError('invalid_input', `${name} must be a non-empty string`);
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function byteLength(value) {
  return new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
}

function redact(value, key = '') {
  if (value === null || value === undefined) return value;
  if (SECRET_KEY_PATTERN.test(key)) return REDACTED;
  if (typeof value === 'string') {
    if (/^(?:Bearer|Basic)\s+/i.test(value) || /^tok_[a-f0-9]+/i.test(value)) return REDACTED;
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => redact(entry));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, redact(entry, entryKey)]));
  }
  return value;
}

export function redactSecrets(value) {
  return redact(value);
}

function isLocalHost(hostname) {
  return LOCAL_HOSTS.has(hostname) || hostname.endsWith('.localhost');
}

function normalizeBaseUrl(baseUrl, {
  allowLocalHttp = false,
  requireLocal = false,
  name = 'baseUrl',
} = {}) {
  assertNonEmptyString(baseUrl, name);
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new AdapterError('invalid_endpoint', `${name} must be an absolute URL`);
  }
  if (url.username || url.password) {
    throw new AdapterError('invalid_endpoint', `${name} must not contain credentials`);
  }
  if (url.search || url.hash) {
    throw new AdapterError('invalid_endpoint', `${name} must not contain a query string or fragment`);
  }
  const local = isLocalHost(url.hostname);
  if (requireLocal && !local) {
    throw new AdapterError('invalid_endpoint', `${name} must point at localhost for a local adapter`);
  }
  if (url.protocol !== 'https:') {
    if (!(url.protocol === 'http:' && allowLocalHttp && local)) {
      throw new AdapterError('invalid_endpoint', `${name} must use HTTPS except for explicitly allowed localhost HTTP`);
    }
  }
  return url.toString().replace(/\/$/, '');
}

function endpoint(baseUrl, path) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  if (baseUrl.endsWith('/v1') && normalizedPath.startsWith('/v1/')) {
    return `${baseUrl}${normalizedPath.slice(3)}`;
  }
  return `${baseUrl}${normalizedPath}`;
}

function mergeSignals(inputSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  let timeoutId = null;
  const abortFromInput = () => controller.abort(inputSignal?.reason);
  if (inputSignal?.aborted) abortFromInput();
  if (inputSignal) inputSignal.addEventListener('abort', abortFromInput, { once: true });
  if (timeoutMs !== null && timeoutMs !== undefined) {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort(new AdapterError('timeout', `operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      if (timeoutId) clearTimeout(timeoutId);
      if (inputSignal) inputSignal.removeEventListener('abort', abortFromInput);
    },
  };
}

async function runWithTimeout(work, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const merged = mergeSignals(signal, timeoutMs);
  try {
    return await work(merged.signal);
  } catch (error) {
    if (merged.timedOut()) {
      throw new AdapterError('timeout', `operation timed out after ${timeoutMs}ms`);
    }
    if (error?.name === 'AbortError') {
      throw new AdapterError('aborted', 'operation was aborted');
    }
    throw error;
  } finally {
    merged.cleanup();
  }
}

async function readJsonResponse(response, {
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  provider = 'provider',
} = {}) {
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
    throw new AdapterError('response_too_large', `${provider} response exceeds ${maxResponseBytes} bytes`, { content_length: contentLength });
  }
  const text = await response.text();
  if (byteLength(text) > maxResponseBytes) {
    throw new AdapterError('response_too_large', `${provider} response exceeds ${maxResponseBytes} bytes`, { received_bytes: byteLength(text) });
  }
  if (!response.ok) {
    throw new AdapterError('provider_error', `${provider} returned HTTP ${response.status}`, { status: response.status });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AdapterError('invalid_provider_response', `${provider} response was not JSON`);
  }
}

function openAiResponsesText(json) {
  if (typeof json.output_text === 'string') return json.output_text;
  const texts = [];
  for (const item of json.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === 'string') texts.push(content.text);
    }
  }
  return texts.join('\n');
}

function openAiChatText(json) {
  return json.choices?.map((choice) => choice.message?.content).filter((entry) => typeof entry === 'string').join('\n') ?? '';
}

function anthropicMessageText(json) {
  return json.content?.map((entry) => entry.type === 'text' ? entry.text : '').filter(Boolean).join('\n') ?? '';
}

function parseProposalText(text, options = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new AdapterError('invalid_model_output', 'model output did not contain proposal JSON');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AdapterError('invalid_model_output', 'model output was not valid JSON');
  }
  const proposals = Array.isArray(parsed) ? parsed : parsed.proposals;
  if (!Array.isArray(proposals)) {
    throw new AdapterError('invalid_model_output', 'model output must be an array or an object with proposals');
  }
  return proposals.map((proposal, index) => normalizeProposal(proposal, index, options));
}

function normalizeProposal(proposal, index, { maxProposalBytes = DEFAULT_MAX_PROPOSAL_BYTES } = {}) {
  assertObject(proposal, `proposals[${index}]`);
  if (byteLength(proposal) > maxProposalBytes) {
    throw new AdapterError('proposal_too_large', `proposal ${index} exceeds ${maxProposalBytes} bytes`);
  }
  const type = proposal.type ?? 'effect';
  if (type !== 'effect' && type !== 'escalation') {
    throw new AdapterError('invalid_model_output', `proposal ${index} type must be effect or escalation`);
  }
  const id = proposal.id ?? `proposal-${index + 1}`;
  assertNonEmptyString(id, `proposals[${index}].id`);
  if (type === 'escalation') {
    return {
      id,
      type,
      reason: proposal.reason ?? 'model_escalation',
      summary: proposal.summary ?? proposal.reason ?? 'model requested escalation',
      idempotency_key: proposal.idempotency_key ?? `escalation:${id}`,
    };
  }
  assertNonEmptyString(proposal.effect, `proposals[${index}].effect`);
  assertNonEmptyString(proposal.scope, `proposals[${index}].scope`);
  assertNonEmptyString(proposal.idempotency_key, `proposals[${index}].idempotency_key`);
  return {
    id,
    type,
    effect: proposal.effect,
    scope: proposal.scope,
    payload: clone(proposal.payload ?? {}),
    idempotency_key: proposal.idempotency_key,
  };
}

function messagesFromInput(input) {
  if (Array.isArray(input?.messages)) return input.messages;
  const content = input?.prompt ?? input?.input ?? '';
  assertNonEmptyString(content, 'input.prompt');
  return [{ role: 'user', content }];
}

function responseInputFromInput(input) {
  if (input?.input !== undefined) return input.input;
  if (input?.prompt !== undefined) return input.prompt;
  if (Array.isArray(input?.messages)) return input.messages;
  throw new AdapterError('invalid_input', 'input.prompt, input.input, or input.messages is required');
}

function authHeaders({ apiKey, headers = {}, scheme = 'Bearer' }) {
  if (!apiKey) return { ...headers };
  return { ...headers, Authorization: `${scheme} ${apiKey}` };
}

function defineProposalPort(port) {
  return Object.freeze(port);
}

export function createOpenAICompatibleAdapter({
  id = 'openai-compatible',
  baseUrl = 'https://api.openai.com',
  apiKey,
  fetch: fetchImpl = globalThis.fetch,
  model,
  mode = 'responses',
  allowLocalHttp = false,
  requireLocal = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  maxProposalBytes = DEFAULT_MAX_PROPOSAL_BYTES,
  headers = {},
} = {}) {
  if (typeof fetchImpl !== 'function') throw new AdapterError('invalid_input', 'fetch must be a function');
  assertNonEmptyString(model, 'model');
  if (!['responses', 'chat'].includes(mode)) throw new AdapterError('invalid_input', 'mode must be responses or chat');
  const safeBaseUrl = normalizeBaseUrl(baseUrl, { allowLocalHttp, requireLocal });
  return defineProposalPort({
    id,
    kind: 'proposal-port',
    provider: 'openai-compatible',
    mode,
    baseUrl: safeBaseUrl,
    async propose(input = {}, options = {}) {
      const path = mode === 'responses' ? '/v1/responses' : '/v1/chat/completions';
      const body = mode === 'responses'
        ? { model, input: responseInputFromInput(input), instructions: input.instructions, metadata: input.metadata }
        : { model, messages: messagesFromInput(input), temperature: input.temperature };
      const json = await postJson({
        fetchImpl,
        url: endpoint(safeBaseUrl, path),
        body,
        headers: authHeaders({ apiKey, headers }),
        timeoutMs,
        maxResponseBytes,
        signal: options.signal,
        provider: 'openai-compatible',
      });
      return parseProposalText(mode === 'responses' ? openAiResponsesText(json) : openAiChatText(json), { maxProposalBytes });
    },
  });
}

export function createLocalOpenAICompatibleAdapter(options = {}) {
  return createOpenAICompatibleAdapter({
    ...options,
    id: options.id ?? 'local-openai-compatible',
    baseUrl: options.baseUrl ?? 'http://localhost:11434',
    allowLocalHttp: true,
    requireLocal: true,
  });
}

export function createAnthropicMessagesAdapter({
  id = 'anthropic-messages',
  baseUrl = 'https://api.anthropic.com',
  apiKey,
  fetch: fetchImpl = globalThis.fetch,
  model,
  anthropicVersion = '2023-06-01',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  maxProposalBytes = DEFAULT_MAX_PROPOSAL_BYTES,
  maxTokens = 1024,
  headers = {},
} = {}) {
  if (typeof fetchImpl !== 'function') throw new AdapterError('invalid_input', 'fetch must be a function');
  assertNonEmptyString(model, 'model');
  const safeBaseUrl = normalizeBaseUrl(baseUrl);
  return defineProposalPort({
    id,
    kind: 'proposal-port',
    provider: 'anthropic',
    mode: 'messages',
    baseUrl: safeBaseUrl,
    async propose(input = {}, options = {}) {
      const json = await postJson({
        fetchImpl,
        url: endpoint(safeBaseUrl, '/v1/messages'),
        body: { model, messages: messagesFromInput(input), max_tokens: input.max_tokens ?? maxTokens, system: input.system },
        headers: {
          ...headers,
          'x-api-key': apiKey,
          'anthropic-version': anthropicVersion,
        },
        timeoutMs,
        maxResponseBytes,
        signal: options.signal,
        provider: 'anthropic',
      });
      return parseProposalText(anthropicMessageText(json), { maxProposalBytes });
    },
  });
}

export function createBrowserWorkerProposalPort({
  id = 'browser-worker',
  request,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxProposalBytes = DEFAULT_MAX_PROPOSAL_BYTES,
} = {}) {
  if (typeof request !== 'function') throw new AdapterError('invalid_input', 'request must be a function');
  return defineProposalPort({
    id,
    kind: 'proposal-port',
    provider: 'browser-worker',
    async propose(input = {}, options = {}) {
      const output = await runWithTimeout((signal) => request(clone(input), { signal }), { signal: options.signal, timeoutMs });
      if (typeof output === 'string') return parseProposalText(output, { maxProposalBytes });
      const proposals = Array.isArray(output) ? output : output?.proposals;
      if (!Array.isArray(proposals)) throw new AdapterError('invalid_model_output', 'browser worker output must contain proposals');
      return proposals.map((proposal, index) => normalizeProposal(proposal, index, { maxProposalBytes }));
    },
  });
}

async function postJson({
  fetchImpl,
  url,
  body,
  headers,
  timeoutMs,
  maxResponseBytes,
  signal,
  provider,
}) {
  return runWithTimeout(async (deadlineSignal) => {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined && value !== null)),
      },
      body: JSON.stringify(body),
      signal: deadlineSignal,
    });
    return readJsonResponse(response, { maxResponseBytes, provider });
  }, { signal, timeoutMs });
}

export function createGatedBusinessConnector({
  id = 'business-connector',
  effect,
  scopes = ['*'],
  client,
  execute,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  assertNonEmptyString(effect, 'effect');
  if (typeof execute !== 'function') throw new AdapterError('invalid_input', 'execute must be a function');
  return createEffectAdapter({
    id,
    effect,
    scopes,
    execute: async ({ proposal, capability, signal } = {}) => {
      assertObject(proposal, 'proposal');
      if (capability.one_time !== true) {
        throw new AdapterError('invalid_capability', 'capability must be one-time');
      }
      return runWithTimeout((deadlineSignal) => execute({
        client,
        proposal: clone(proposal),
        capability: clone(capability),
        signal: deadlineSignal,
      }), { signal, timeoutMs });
    },
  });
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function redactAlertText(value) {
  return value
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [REDACTED]')
    .replace(/\b(api[_-]?key|authorization|client[_-]?secret|cookie|password|secret|session|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\b(?:sk|tok)_[A-Za-z0-9_-]+\b/g, REDACTED);
}

function redactAlertValue(value, key = '') {
  if (value === null || value === undefined) return value;
  if (SECRET_KEY_PATTERN.test(key)) return REDACTED;
  if (typeof value === 'string') return redactAlertText(value);
  if (Array.isArray(value)) return value.map((entry) => redactAlertValue(entry));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, redactAlertValue(entry, entryKey)]));
  }
  return value;
}

function normalizeOperationalAlert(payload, {
  maxMessageBytes = DEFAULT_MAX_ALERT_MESSAGE_BYTES,
  maxContextBytes = DEFAULT_MAX_ALERT_CONTEXT_BYTES,
} = {}) {
  assertObject(payload, 'proposal.payload');
  const severity = String(payload.severity ?? '').trim().toLowerCase();
  if (!OPERATIONAL_ALERT_SEVERITIES.includes(severity)) {
    throw new AdapterError('invalid_alert_severity', `alert severity must be one of ${OPERATIONAL_ALERT_SEVERITIES.join(', ')}`);
  }
  assertNonEmptyString(payload.message, 'proposal.payload.message');
  const message = redactAlertText(payload.message.trim());
  if (byteLength(message) > maxMessageBytes) {
    throw new AdapterError('alert_message_too_large', `alert message exceeds ${maxMessageBytes} bytes`);
  }
  const context = redactAlertValue(payload.context ?? {});
  if (byteLength(context) > maxContextBytes) {
    throw new AdapterError('alert_context_too_large', `alert context exceeds ${maxContextBytes} bytes`);
  }
  return Object.freeze({ severity, message, context: clone(context) });
}

export function operationalAlertIdempotencyKey({ effect = OPERATIONAL_ALERT_EFFECT, scope, payload } = {}, options = {}) {
  assertNonEmptyString(effect, 'effect');
  assertNonEmptyString(scope, 'scope');
  const alert = normalizeOperationalAlert(payload, options);
  const digest = crypto.createHash('sha256').update(stableJson({ effect: effect.trim(), scope: scope.trim(), alert })).digest('hex');
  return `operational-alert:${digest}`;
}

export function createOperationalAlertConnector({
  id = 'operational-alert',
  effect = OPERATIONAL_ALERT_EFFECT,
  scopes = ['*'],
  client,
  deliver,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxMessageBytes = DEFAULT_MAX_ALERT_MESSAGE_BYTES,
  maxContextBytes = DEFAULT_MAX_ALERT_CONTEXT_BYTES,
} = {}) {
  if (typeof deliver !== 'function') throw new AdapterError('invalid_input', 'deliver must be a function');
  return createGatedBusinessConnector({
    id,
    effect,
    scopes,
    client,
    timeoutMs,
    execute: ({ client: privateClient, proposal, capability, signal }) => {
      const alert = normalizeOperationalAlert(proposal.payload, { maxMessageBytes, maxContextBytes });
      const expectedIdempotencyKey = operationalAlertIdempotencyKey({
        effect: proposal.effect,
        scope: proposal.scope,
        payload: proposal.payload,
      }, { maxMessageBytes, maxContextBytes });
      if (proposal.idempotency_key !== expectedIdempotencyKey) {
        throw new AdapterError('invalid_alert_idempotency', 'alert idempotency key does not match its normalized effect, scope, and content');
      }
      return deliver({
        client: privateClient,
        alert,
        capability,
        idempotency_key: expectedIdempotencyKey,
        signal,
      });
    },
  });
}

export function createPostgresStatePort({
  client,
  table = 'frontier_state',
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!client || typeof client.query !== 'function') throw new AdapterError('invalid_input', 'client.query is required');
  const quotedTable = quoteIdentifierPath(table);
  return Object.freeze({
    id: 'postgres-state',
    kind: 'state-port',
    async loadState(key, options = {}) {
      assertNonEmptyString(key, 'key');
      try {
        const result = await runWithTimeout((signal) => client.query({
          text: `select state, version from ${quotedTable} where key = $1`,
          values: [key],
          signal,
        }), { signal: options.signal, timeoutMs });
        const row = result.rows?.[0];
        return row ? { state: clone(row.state), version: row.version } : null;
      } catch (error) {
        throw storageError('postgres loadState failed', error);
      }
    },
    async saveState(key, state, options = {}) {
      assertNonEmptyString(key, 'key');
      try {
        const query = Number.isInteger(options.expectedVersion)
          ? {
              text: `update ${quotedTable} set state = $2, version = version + 1 where key = $1 and version = $3 returning version`,
              values: [key, clone(state), options.expectedVersion],
            }
          : {
              text: `insert into ${quotedTable} (key, state, version) values ($1, $2, 1) on conflict (key) do update set state = $2, version = ${quotedTable}.version + 1 returning version`,
              values: [key, clone(state)],
            };
        const result = await runWithTimeout((signal) => client.query({
          ...query,
          signal,
        }), { signal: options.signal, timeoutMs });
        if (Number.isInteger(options.expectedVersion) && !result.rows?.length) {
          throw new AdapterError('storage_conflict', 'postgres saveState version conflict');
        }
        return { ok: true, version: result.rows?.[0]?.version ?? null };
      } catch (error) {
        throw storageError('postgres saveState failed', error);
      }
    },
  });
}

export function createRedisQueuePort({
  client,
  keyPrefix = 'frontier',
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const send = client?.sendCommand ?? client?.command;
  if (typeof send !== 'function') throw new AdapterError('invalid_input', 'client.sendCommand or client.command is required');
  const call = (command, args, signal) => send.call(client, command, args, { signal });
  return Object.freeze({
    id: 'redis-queue',
    kind: 'queue-port',
    async enqueue(queue, item, idempotencyKey, options = {}) {
      assertNonEmptyString(queue, 'queue');
      assertNonEmptyString(idempotencyKey, 'idempotencyKey');
      try {
        const queueKey = `${keyPrefix}:queue:${queue}`;
        const idempotencyKeyName = `${keyPrefix}:idem:${idempotencyKey}`;
        const ttlSeconds = String(options.ttlSeconds ?? 86_400);
        const payload = JSON.stringify({ id: idempotencyKey, idempotency_key: idempotencyKey, item: clone(item) });
        const script = [
          "if redis.call('SET', KEYS[2], '1', 'NX', 'EX', ARGV[2]) then",
          "  redis.call('LPUSH', KEYS[1], ARGV[1])",
          "  return 1",
          'end',
          'return 0',
        ].join('\n');
        const result = await runWithTimeout((signal) => call('EVAL', [script, '2', queueKey, idempotencyKeyName, payload, ttlSeconds], signal), { signal: options.signal, timeoutMs });
        return Number(result) === 1 || result === true
          ? { ok: true, id: idempotencyKey }
          : { ok: false, duplicate: true, id: idempotencyKey };
      } catch (error) {
        throw storageError('redis enqueue failed', error);
      }
    },
    async claimIdempotency(idempotencyKey, options = {}) {
      assertNonEmptyString(idempotencyKey, 'idempotencyKey');
      const ttlSeconds = options.ttlSeconds ?? 86_400;
      try {
        const result = await runWithTimeout((signal) => call('SET', [`${keyPrefix}:idem:${idempotencyKey}`, '1', 'NX', 'EX', String(ttlSeconds)], signal), { signal: options.signal, timeoutMs });
        return { ok: result === 'OK' || result === true };
      } catch (error) {
        throw storageError('redis claimIdempotency failed', error);
      }
    },
    async ack(queue, id, options = {}) {
      assertNonEmptyString(queue, 'queue');
      assertNonEmptyString(id, 'id');
      try {
        const script = [
          "local entries = redis.call('LRANGE', KEYS[1], 0, -1)",
          'for _, raw in ipairs(entries) do',
          '  local decoded_ok, entry = pcall(cjson.decode, raw)',
          "  if decoded_ok and (entry['id'] == ARGV[1] or entry['idempotency_key'] == ARGV[1]) then",
          "    return redis.call('LREM', KEYS[1], 1, raw)",
          '  end',
          'end',
          'return 0',
        ].join('\n');
        const result = await runWithTimeout((signal) => call('EVAL', [script, '1', `${keyPrefix}:queue:${queue}`, id], signal), { signal: options.signal, timeoutMs });
        return Number(result) === 1 || result === true ? { ok: true } : { ok: false };
      } catch (error) {
        throw storageError('redis ack failed', error);
      }
    },
  });
}

export function createS3EvidenceReceiptPort({
  client,
  bucket,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxReceiptBytes = DEFAULT_MAX_RECEIPT_BYTES,
} = {}) {
  if (!client || (typeof client.putObject !== 'function' && typeof client.send !== 'function')) {
    throw new AdapterError('invalid_input', 'client.putObject or client.send is required');
  }
  assertNonEmptyString(bucket, 'bucket');
  return Object.freeze({
    id: 's3-evidence',
    kind: 'evidence-port',
    async putReceipt(key, receipt, options = {}) {
      assertNonEmptyString(key, 'key');
      try {
        const { body, parsed } = parseReceipt(receipt, maxReceiptBytes);
        assertNoRawSecretFields(parsed);
        const sha256Hex = crypto.createHash('sha256').update(body).digest('hex');
        const checksumSha256 = crypto.createHash('sha256').update(body).digest('base64');
        const input = {
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: 'application/json',
          Metadata: { sha256: sha256Hex },
          ChecksumSHA256: checksumSha256,
        };
        await runWithTimeout((signal) => {
          if (typeof client.putObject === 'function') return client.putObject({ ...input, signal });
          return client.send({ type: 'PutObject', input, signal });
        }, { signal: options.signal, timeoutMs });
        return { ok: true, bytes: body.byteLength, sha256: sha256Hex };
      } catch (error) {
        throw storageError('s3 putReceipt failed', error);
      }
    },
  });
}

// Explicit product-facing name for the same byte-preserving S3 receipt sink.
// Keep the legacy export for compatibility; both names intentionally share one implementation.
export const createS3ReceiptEvidenceSink = createS3EvidenceReceiptPort;

function parseReceipt(receipt, maxReceiptBytes) {
  let body;
  let text;
  try {
    if (typeof receipt === 'string') {
      text = receipt;
      body = new TextEncoder().encode(receipt);
    } else if (receipt instanceof Uint8Array) {
      body = new Uint8Array(receipt);
      text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } else {
      text = JSON.stringify(receipt);
      if (typeof text !== 'string') throw new TypeError('receipt is not JSON serializable');
      body = new TextEncoder().encode(text);
    }
    if (body.byteLength > maxReceiptBytes) {
      throw new AdapterError('receipt_too_large', 'receipt exceeds the configured size limit');
    }
    return { body, parsed: JSON.parse(text) };
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError('invalid_receipt', 'receipt must be valid UTF-8 JSON');
  }
}

function assertNoRawSecretFields(value, path = []) {
  if (value === null || value === undefined || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoRawSecretFields(entry, [...path, String(index)]));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_RAW_SECRET_FIELD_PATTERN.test(key)) {
      throw new AdapterError('forbidden_secret_field', `receipt contains forbidden raw secret field ${[...path, key].join('.')}`);
    }
    assertNoRawSecretFields(entry, [...path, key]);
  }
}

function storageError(message, cause) {
  const safeFailures = {
    storage_conflict: 'storage version conflict',
    receipt_too_large: 'receipt exceeds the configured size limit',
    forbidden_secret_field: 'receipt contains a forbidden raw secret field',
    invalid_receipt: 'receipt must be valid UTF-8 JSON',
  };
  if (cause instanceof AdapterError && safeFailures[cause.code]) {
    return new AdapterError(cause.code, safeFailures[cause.code]);
  }
  return new AdapterError('storage_failed_closed', message, { cause: safeErrorIdentity(cause) });
}

function safeErrorIdentity(error) {
  const safeNames = new Set(['Error', 'TypeError', 'RangeError', 'AbortError', 'TimeoutError']);
  const name = safeNames.has(error?.name) ? error.name : 'Error';
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    ? error.code
    : undefined;
  return code ? { name, code } : { name };
}

function quoteIdentifierPath(identifier) {
  assertNonEmptyString(identifier, 'identifier');
  const segments = identifier.split('.');
  if (!segments.every((segment) => IDENTIFIER_SEGMENT_PATTERN.test(segment))) {
    throw new AdapterError('invalid_identifier', 'identifier must contain only SQL identifier segments');
  }
  return segments.map((segment) => `"${segment.replaceAll('"', '""')}"`).join('.');
}

function uniq(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
}

export function normalizeClerkClaims(claims) {
  assertObject(claims, 'claims');
  return {
    provider: 'clerk',
    subject: claims.sub ?? claims.user_id,
    email: claims.email ?? claims.email_address,
    email_verified: claims.email_verified === true,
    organization_id: claims.org_id ?? claims.organization_id,
    roles: uniq([claims.org_role, ...(Array.isArray(claims.roles) ? claims.roles : [])]),
  };
}

export function normalizeAuth0Claims(claims) {
  assertObject(claims, 'claims');
  const namespaceRoles = Object.entries(claims)
    .filter(([key, value]) => key.endsWith('/roles') && Array.isArray(value))
    .flatMap(([, value]) => value);
  return {
    provider: 'auth0',
    subject: claims.sub,
    email: claims.email,
    email_verified: claims.email_verified === true,
    organization_id: claims.org_id ?? claims['https://frontierinfra.org/org_id'],
    roles: uniq([...(Array.isArray(claims.roles) ? claims.roles : []), ...namespaceRoles]),
  };
}

export function normalizeWorkOSClaims(claims) {
  assertObject(claims, 'claims');
  return {
    provider: 'workos',
    subject: claims.sub ?? claims.user_id,
    email: claims.email,
    email_verified: claims.email_verified === true,
    organization_id: claims.org_id ?? claims.organization_id,
    roles: uniq([claims.role, ...(Array.isArray(claims.roles) ? claims.roles : [])]),
  };
}

export const identityClaimExamples = Object.freeze({
  clerk: Object.freeze({
    claims: Object.freeze({ sub: 'user_123', email: 'user@example.com', org_id: 'org_123', org_role: 'admin' }),
    normalized: Object.freeze({ provider: 'clerk', subject: 'user_123', email: 'user@example.com', email_verified: false, organization_id: 'org_123', roles: ['admin'] }),
  }),
  auth0: Object.freeze({
    claims: Object.freeze({ sub: 'auth0|123', email: 'user@example.com', 'https://example.com/roles': ['editor'] }),
    normalized: Object.freeze({ provider: 'auth0', subject: 'auth0|123', email: 'user@example.com', email_verified: false, organization_id: undefined, roles: ['editor'] }),
  }),
  workos: Object.freeze({
    claims: Object.freeze({ sub: 'user_123', email: 'user@example.com', organization_id: 'org_123', role: 'member' }),
    normalized: Object.freeze({ provider: 'workos', subject: 'user_123', email: 'user@example.com', email_verified: false, organization_id: 'org_123', roles: ['member'] }),
  }),
});
