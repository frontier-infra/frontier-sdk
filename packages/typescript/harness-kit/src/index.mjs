import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

let protocol;
try {
  protocol = await import('@frontier-infra/protocol');
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  protocol = await import('../../protocol/src/index.mjs');
}

const { RUNTIME_HEALTH_SCHEMA_VERSION, RUNTIME_HEALTH_LAYERS, evaluateRuntimeHealth } = protocol;

export const HARNESS_KIT_VERSION = '0.1.0';
export const HARNESS_EVENT_SCHEMA_VERSION = 'frontier.harness.event.v1';
export const HARNESS_RECEIPT_SCHEMA_VERSION = 'frontier.harness.receipt.v1';
export const UNSIGNED_RECEIPT_LEVEL = 'L3';
export const UNSIGNED_RECEIPT_SIGNATURE = 'unsigned';

const DEFAULT_NOW = '2026-08-06T00:00:00.000Z';
const HEALTH_LAYERS = RUNTIME_HEALTH_LAYERS;
const DEFAULT_BUDGETS = Object.freeze({
  attempts_per_proposal: 2,
  wall_ms: 30_000,
  concurrency: 1,
});
const DEFAULT_JSONL_LOCK_TIMEOUT_MS = 1_000;
const DEFAULT_JSONL_LOCK_STALE_MS = 5_000;
const INTERNAL_APPEND = Symbol('frontier.harness.internal_append');
const PUBLIC_APPEND_EVENT_TYPES = new Set([
  'worker_proposed',
]);
const ADAPTER_EXECUTORS = new WeakMap();

export class HarnessError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'HarnessError';
    this.code = code;
    this.details = details;
  }
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  const fields = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${fields.join(',')}}`;
}

export function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex');
}

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HarnessError('invalid_input', `${name} must be an object`);
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HarnessError('invalid_input', `${name} must be a non-empty string`);
  }
}

function normalizeIdentity(value, name) {
  assertNonEmptyString(value, name);
  return value.trim();
}

function normalizeOptionalIdentity(value, name) {
  if (value === undefined || value === null) return value;
  return normalizeIdentity(value, name);
}

function assertProbability(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new HarnessError('invalid_input', `${name} must be a number between 0 and 1`);
  }
  return value;
}

function parseMillis(value, name) {
  assertNonEmptyString(value, name);
  const millis = Date.parse(value);
  if (Number.isNaN(millis)) throw new HarnessError('invalid_input', `${name} must be an ISO timestamp`);
  return millis;
}

function normalizeTimestamp(value, name) {
  const millis = parseMillis(value, name);
  return new Date(millis).toISOString();
}

function nowFromClock(clock) {
  const value = typeof clock === 'function' ? clock() : clock;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return DEFAULT_NOW;
}

function normalizeScope(scope) {
  assertNonEmptyString(scope, 'scope');
  return scope.trim();
}

function scopeMatches(grant, requested) {
  const normalizedGrant = normalizeScope(grant);
  const normalizedRequested = normalizeScope(requested);
  return normalizedGrant === '*' || normalizedRequested === normalizedGrant || normalizedRequested.startsWith(`${normalizedGrant}:`);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

const SAFE_EXECUTOR_ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'AbortError', 'TimeoutError', 'AdapterError', 'HarnessError']);
const SAFE_EXECUTOR_ERROR_CODES = new Set(['aborted', 'timeout', 'invalid_capability']);

function safeExecutorError(error) {
  const details = {
    name: SAFE_EXECUTOR_ERROR_NAMES.has(error?.name) ? error.name : 'Error',
  };
  if (SAFE_EXECUTOR_ERROR_CODES.has(error?.code)) {
    details.code = error.code;
  }
  return details;
}

function contractHash(contract) {
  return sha256({
    id: contract.id,
    goal_id: contract.goal_id,
    proposed_by: contract.proposed_by,
    verifier_id: contract.verifier_id,
    scope: contract.scope,
    expires_at: contract.expires_at,
    autonomy_ceiling: contract.autonomy_ceiling,
    success_criteria: contract.success_criteria ?? [],
    effect_allowlist: contract.effect_allowlist ?? [],
  });
}

function proposalHash(proposal) {
  return sha256({
    id: proposal.id,
    type: proposal.type,
    effect: proposal.effect,
    scope: proposal.scope,
    payload: proposal.payload ?? {},
    idempotency_key: proposal.idempotency_key,
  });
}

function normalizeContract(contract, fallback = {}) {
  assertObject(contract, 'contract');
  assertNonEmptyString(contract.id, 'contract.id');
  assertNonEmptyString(contract.goal_id ?? fallback.goal_id, 'contract.goal_id');
  assertNonEmptyString(contract.proposed_by ?? fallback.proposed_by, 'contract.proposed_by');
  assertNonEmptyString(contract.verifier_id ?? fallback.verifier_id, 'contract.verifier_id');
  assertNonEmptyString(contract.scope ?? fallback.scope, 'contract.scope');
  const autonomyCeiling = contract.autonomy_ceiling ?? fallback.autonomy_ceiling ?? 0;
  return {
    id: normalizeIdentity(contract.id, 'contract.id'),
    goal_id: normalizeIdentity(contract.goal_id ?? fallback.goal_id, 'contract.goal_id'),
    proposed_by: normalizeIdentity(contract.proposed_by ?? fallback.proposed_by, 'contract.proposed_by'),
    verifier_id: normalizeIdentity(contract.verifier_id ?? fallback.verifier_id, 'contract.verifier_id'),
    scope: normalizeScope(contract.scope ?? fallback.scope),
    expires_at: normalizeTimestamp(contract.expires_at ?? fallback.expires_at, 'contract.expires_at'),
    autonomy_ceiling: assertProbability(autonomyCeiling, 'contract.autonomy_ceiling'),
    success_criteria: Array.isArray(contract.success_criteria) ? clone(contract.success_criteria) : [],
    effect_allowlist: Array.isArray(contract.effect_allowlist)
      ? contract.effect_allowlist.map((entry, index) => {
        assertObject(entry, `contract.effect_allowlist[${index}]`);
        return {
          effect: normalizeIdentity(entry.effect, `contract.effect_allowlist[${index}].effect`),
          scope: entry.scope === undefined ? undefined : normalizeScope(entry.scope),
        };
      })
      : [],
  };
}

function normalizeVerifier(verifier) {
  assertObject(verifier, 'verifier');
  assertNonEmptyString(verifier.id, 'verifier.id');
  const scopes = Array.isArray(verifier.scopes) && verifier.scopes.length ? verifier.scopes.map(normalizeScope) : ['*'];
  const trustCeiling = verifier.trust_ceiling ?? 0;
  return {
    id: normalizeIdentity(verifier.id, 'verifier.id'),
    scopes,
    active: verifier.active !== false,
    trust_ceiling: assertProbability(trustCeiling, 'verifier.trust_ceiling'),
    verify: typeof verifier.verify === 'function' ? verifier.verify : null,
    verifyAttestation: typeof verifier.verifyAttestation === 'function' ? verifier.verifyAttestation : null,
  };
}

function normalizeProposal(proposal, index = 0) {
  assertObject(proposal, 'proposal');
  const type = proposal.type ?? 'effect';
  if (type !== 'effect' && type !== 'escalation') {
    throw new HarnessError('invalid_worker_output', `proposal.type must be effect or escalation at index ${index}`);
  }
  const id = normalizeIdentity(proposal.id ?? `proposal-${index + 1}`, `proposal[${index}].id`);
  assertNonEmptyString(id, `proposal[${index}].id`);
  if (type === 'escalation') {
    return {
      id,
      type,
      reason: proposal.reason ?? 'worker_escalation',
      summary: proposal.summary ?? proposal.reason ?? 'worker requested escalation',
      idempotency_key: normalizeIdentity(proposal.idempotency_key ?? `escalation:${id}`, `proposal[${index}].idempotency_key`),
    };
  }
  assertNonEmptyString(proposal.effect, `proposal[${index}].effect`);
  assertNonEmptyString(proposal.scope, `proposal[${index}].scope`);
  assertNonEmptyString(proposal.idempotency_key, `proposal[${index}].idempotency_key`);
  return {
    id,
    type,
    effect: normalizeIdentity(proposal.effect, `proposal[${index}].effect`),
    scope: normalizeScope(proposal.scope),
    payload: clone(proposal.payload ?? {}),
    idempotency_key: normalizeIdentity(proposal.idempotency_key, `proposal[${index}].idempotency_key`),
  };
}

function emptyState() {
  return {
    sequence: 0,
    receipts: [],
    contracts: new Map(),
    current_contract_id: null,
    contract_hash: null,
    proposals: new Map(),
    capabilities: new Map(),
    reservations: new Map(),
    consumed_capabilities: new Map(),
    effects: new Map(),
    proposal_verifications: new Map(),
    proposal_attempts: new Map(),
    deferred_proposals: [],
    quarantine: new Set(),
    halted: false,
    halt_reason: null,
    override_active: false,
    override_reason: null,
    operator_dial: 0,
    health_issues: [],
    duplicate_inputs: [],
    rejected_inputs: [],
    active_effects: 0,
  };
}

function mapSet(map, key, value) {
  map.set(key, value);
  return map;
}

function reduceEvent(state, envelope) {
  const event = envelope.event;
  state.sequence = Math.max(state.sequence, envelope.sequence ?? state.sequence);
  state.receipts.push(envelope.receipt);
  if (event.type === 'contract_proposed') {
    state.contracts.set(event.contract.id, {
      ...event.contract,
      status: 'proposed',
      hash: event.contract_hash,
      proposed_at: event.at,
      ratified_by: null,
    });
    state.current_contract_id = event.contract.id;
    state.contract_hash = event.contract_hash;
  } else if (event.type === 'contract_ratified') {
    const contract = state.contracts.get(event.contract_id);
    if (contract) {
      contract.status = 'ratified';
      contract.ratified_by = event.verifier_id;
      contract.ratified_at = event.at;
      state.contract_hash = event.contract_hash;
    }
  } else if (event.type === 'contract_rejected') {
    const contract = state.contracts.get(event.contract_id);
    if (contract) contract.status = 'rejected';
    state.health_issues.push({ layer: 'governance', reason_code: event.reason_code, summary: event.reason });
  } else if (event.type === 'worker_proposed') {
    state.proposals.set(event.proposal.id, {
      ...event.proposal,
      proposal_hash: event.proposal_hash ?? proposalHash(event.proposal),
      worker_id: event.worker_id,
      at: event.at,
    });
  } else if (event.type === 'proposal_verified') {
    state.proposal_verifications.set(event.proposal_hash, {
      proposal_id: event.proposal_id,
      proposal_hash: event.proposal_hash,
      contract_hash: event.contract_hash,
      scope: event.scope,
      effect: event.effect,
      verifier_id: event.verifier_id,
      trust: event.trust,
      observed_at: event.observed_at,
      expires_at: event.expires_at,
      status: 'pass',
    });
  } else if (event.type === 'proposal_verification_rejected') {
    state.health_issues.push({ layer: 'governance', reason_code: event.reason_code ?? 'governance_gate_failed', summary: event.reason });
  } else if (event.type === 'capability_issued') {
    state.capabilities.set(event.capability.id, { ...event.capability, consumed: false, reserved_by: null, failed: false });
  } else if (event.type === 'capability_rejected') {
    state.health_issues.push({ layer: 'governance', reason_code: event.reason_code ?? 'governance_gate_failed', summary: event.reason });
  } else if (event.type === 'capability_reserved') {
    state.reservations.set(event.reservation.id, { ...event.reservation, status: 'active' });
    const capability = state.capabilities.get(event.reservation.capability_id);
    if (capability) capability.reserved_by = event.reservation.id;
    state.active_effects += 1;
  } else if (event.type === 'capability_reservation_failed') {
    const reservation = state.reservations.get(event.reservation_id);
    if (reservation) {
      reservation.status = 'failed';
      reservation.failed_at = event.at;
      reservation.reason = event.reason;
      state.active_effects = Math.max(0, state.active_effects - 1);
    }
    const capability = reservation ? state.capabilities.get(reservation.capability_id) : null;
    if (capability) {
      capability.consumed = true;
      capability.failed = true;
    }
  } else if (event.type === 'capability_reservation_expired') {
    const reservation = state.reservations.get(event.reservation_id);
    if (reservation && reservation.status === 'active') {
      reservation.status = 'failed';
      reservation.failed_at = event.at;
      reservation.reason = event.reason;
      state.active_effects = Math.max(0, state.active_effects - 1);
    }
    const capability = reservation ? state.capabilities.get(reservation.capability_id) : state.capabilities.get(event.capability_id);
    if (capability) {
      capability.consumed = true;
      capability.failed = true;
    }
  } else if (event.type === 'reservation_operation_rejected') {
    state.health_issues.push({ layer: 'governance', reason_code: 'governance_gate_failed', summary: event.reason });
  } else if (event.type === 'effect_committed') {
    state.effects.set(event.operation_idempotency_key, event.result);
    const capability = state.capabilities.get(event.capability_id);
    if (capability) capability.consumed = true;
    const reservation = state.reservations.get(event.reservation_id);
    if (reservation) {
      reservation.status = 'completed';
      reservation.completed_at = event.at;
      reservation.result = event.result;
      state.active_effects = Math.max(0, state.active_effects - 1);
    }
    state.consumed_capabilities.set(event.capability_id, {
      idempotency_key: event.operation_idempotency_key,
      effect: event.effect,
      scope: event.scope,
      result: event.result,
      reservation_id: event.reservation_id,
    });
  } else if (event.type === 'effect_failed') {
    mapSet(state.proposal_attempts, event.proposal_id, (state.proposal_attempts.get(event.proposal_id) ?? 0) + 1);
    state.health_issues.push({ layer: 'execution', reason_code: 'scheduler_stalled', summary: event.reason });
  } else if (event.type === 'proposal_quarantined') {
    state.quarantine.add(event.proposal_id);
    state.health_issues.push({ layer: 'execution', reason_code: 'scheduler_stalled', summary: event.reason });
  } else if (event.type === 'proposal_deferred') {
    state.deferred_proposals.push({ proposal_id: event.proposal_id, reason: event.reason });
  } else if (event.type === 'halted') {
    state.halted = true;
    state.halt_reason = event.reason;
  } else if (event.type === 'override_set') {
    state.override_active = true;
    state.override_reason = event.reason;
    state.halted = false;
    state.halt_reason = null;
  } else if (event.type === 'override_cleared') {
    state.override_active = false;
    state.override_reason = null;
  } else if (event.type === 'operator_dial_set') {
    state.operator_dial = event.operator_dial;
  } else if (event.type === 'input_duplicate') {
    state.duplicate_inputs.push(event.idempotency_key);
  } else if (event.type === 'input_rejected') {
    state.rejected_inputs.push({ reason: event.reason, sequence: event.input_sequence });
  }
  return state;
}

export function reduceHarnessEvents(events) {
  return events.reduce((state, envelope) => reduceEvent(state, envelope), emptyState());
}

function loadEnvelopeIntoStore(store, envelope) {
  if (envelope.input_sequence !== undefined) {
    if (!Number.isInteger(envelope.input_sequence) || envelope.input_sequence < 1) {
      throw new HarnessError('reordered_input', 'input_sequence must be a positive integer');
    }
    const expected = store.externalSequences.size + 1;
    if (envelope.input_sequence !== expected) {
      throw new HarnessError('reordered_input', `expected input_sequence ${expected}, got ${envelope.input_sequence}`);
    }
    store.externalSequences.add(envelope.input_sequence);
  }
  const key = envelope.event?.idempotency_key;
  if (key && store.idempotencyKeys.has(key)) {
    throw new HarnessError('duplicate_input', `duplicate idempotency key ${key}`);
  }
  if (key) store.idempotencyKeys.add(key);
  store.events.push(clone(envelope));
}

function appendInternal(store, event, options = {}) {
  return store.append(event, { ...options, internal: INTERNAL_APPEND });
}

function serializableState(state) {
  return {
    sequence: state.sequence,
    receipts: state.receipts,
    contracts: Object.fromEntries(state.contracts),
    current_contract_id: state.current_contract_id,
    contract_hash: state.contract_hash,
    proposals: Object.fromEntries(state.proposals),
    capabilities: Object.fromEntries(state.capabilities),
    reservations: Object.fromEntries(state.reservations),
    consumed_capabilities: Object.fromEntries(state.consumed_capabilities),
    effects: Object.fromEntries(state.effects),
    proposal_verifications: Object.fromEntries(state.proposal_verifications),
    proposal_attempts: Object.fromEntries(state.proposal_attempts),
    deferred_proposals: state.deferred_proposals,
    quarantine: [...state.quarantine],
    halted: state.halted,
    halt_reason: state.halt_reason,
    override_active: state.override_active,
    override_reason: state.override_reason,
    operator_dial: state.operator_dial,
    health_issues: state.health_issues,
    duplicate_inputs: state.duplicate_inputs,
    rejected_inputs: state.rejected_inputs,
    active_effects: state.active_effects,
  };
}

export class MemoryEventStore {
  constructor(events = []) {
    this.events = [];
    this.idempotencyKeys = new Set();
    this.externalSequences = new Set();
    if (events.length) {
      validateEnvelopeChain(events);
      validateSemanticReplay(events);
      for (const envelope of events) loadEnvelopeIntoStore(this, envelope);
    }
  }

  list() {
    return this.events.map(clone);
  }

  state() {
    return reduceHarnessEvents(this.list());
  }

  lastReceiptHash() {
    return this.events.at(-1)?.receipt?.receipt_hash ?? null;
  }

  append(event, options = {}) {
    assertObject(event, 'event');
    assertNonEmptyString(event.type, 'event.type');
    const internal = options.internal === INTERNAL_APPEND;
    if (!internal && !PUBLIC_APPEND_EVENT_TYPES.has(event.type)) {
      throw new HarnessError('invalid_input', `event type ${event.type} cannot be appended through the public event store API`);
    }
    const key = event.idempotency_key;
    if (options.input_sequence !== undefined) {
      const expected = this.externalSequences.size + 1;
      if (options.input_sequence !== expected) {
        const rejected = this.#envelope({
          type: 'input_rejected',
          at: event.at,
          idempotency_key: `reordered:${options.input_sequence}:${this.events.length + 1}`,
          input_sequence: options.input_sequence,
          reason: `expected input_sequence ${expected}, got ${options.input_sequence}`,
        });
        this.idempotencyKeys.add(rejected.event.idempotency_key);
        this.events.push(rejected);
        return { rejected: true, envelope: clone(rejected) };
      }
      this.externalSequences.add(options.input_sequence);
    }
    if (key && this.idempotencyKeys.has(key)) {
      const duplicate = this.#envelope({
        type: 'input_duplicate',
        at: event.at,
        idempotency_key: `duplicate:${key}:${this.events.length + 1}`,
        duplicate_type: event.type,
        duplicate_key: key,
      }, options);
      this.idempotencyKeys.add(duplicate.event.idempotency_key);
      this.events.push(duplicate);
      return { duplicate: true, envelope: clone(duplicate) };
    }
    const envelope = this.#envelope(event, options);
    validateSemanticReplay([...this.events, envelope]);
    if (key) this.idempotencyKeys.add(key);
    this.events.push(envelope);
    return { duplicate: false, rejected: false, envelope: clone(envelope) };
  }

  #envelope(event, options = {}) {
    const sequence = this.events.length + 1;
    const normalizedEvent = {
      schema_version: HARNESS_EVENT_SCHEMA_VERSION,
      at: event.at ?? DEFAULT_NOW,
      ...clone(event),
    };
    const previousHash = this.lastReceiptHash();
    const eventHash = sha256({ sequence, event: normalizedEvent });
    const receiptCore = {
      schema_version: HARNESS_RECEIPT_SCHEMA_VERSION,
      level: UNSIGNED_RECEIPT_LEVEL,
      signature: UNSIGNED_RECEIPT_SIGNATURE,
      previous_hash: previousHash,
      event_hash: eventHash,
      warning: 'Unsigned local L3 receipt only; this is not an AAR L4 signed receipt.',
    };
    const receipt = {
      ...receiptCore,
      receipt_hash: sha256(receiptCore),
    };
    return {
      schema_version: HARNESS_EVENT_SCHEMA_VERSION,
      sequence,
      input_sequence: options.input_sequence,
      event: normalizedEvent,
      receipt,
    };
  }
}

export function validateEnvelopeChain(events) {
  let previousHash = null;
  for (const [index, envelope] of events.entries()) {
    assertObject(envelope, `events[${index}]`);
    assertObject(envelope.event, `events[${index}].event`);
    assertObject(envelope.receipt, `events[${index}].receipt`);
    const sequence = index + 1;
    if (envelope.sequence !== sequence) {
      throw new HarnessError('invalid_event_chain', `event sequence ${envelope.sequence} should be ${sequence}`);
    }
    if (envelope.schema_version !== HARNESS_EVENT_SCHEMA_VERSION) {
      throw new HarnessError('invalid_event_chain', `event ${sequence} schema_version is invalid`);
    }
    const expectedEventHash = sha256({ sequence, event: envelope.event });
    if (envelope.receipt.event_hash !== expectedEventHash) {
      throw new HarnessError('invalid_event_chain', `event ${sequence} hash mismatch`);
    }
    if (envelope.receipt.previous_hash !== previousHash) {
      throw new HarnessError('invalid_event_chain', `event ${sequence} previous_hash mismatch`);
    }
    if (envelope.receipt.level !== UNSIGNED_RECEIPT_LEVEL || envelope.receipt.signature !== UNSIGNED_RECEIPT_SIGNATURE) {
      throw new HarnessError('invalid_event_chain', `event ${sequence} receipt must be unsigned L3`);
    }
    const { receipt_hash: _receiptHash, ...receiptCore } = envelope.receipt;
    const expectedReceiptHash = sha256(receiptCore);
    if (envelope.receipt.receipt_hash !== expectedReceiptHash) {
      throw new HarnessError('invalid_event_chain', `event ${sequence} receipt_hash mismatch`);
    }
    previousHash = envelope.receipt.receipt_hash;
  }
  return true;
}

export function validateSemanticReplay(events) {
  const state = emptyState();
  for (const envelope of events) {
    const event = envelope.event;
    if (event.type === 'contract_proposed') {
      if (contractHash(normalizeContract(event.contract)) !== event.contract_hash) {
        throw new HarnessError('invalid_event_chain', `event ${envelope.sequence} contract hash mismatch`);
      }
    } else if (event.type === 'contract_ratified') {
      const contract = state.contracts.get(event.contract_id);
      if (!contract || contract.status !== 'proposed') {
        throw new HarnessError('invalid_event_chain', `event ${envelope.sequence} ratifies a missing or non-proposed contract`);
      }
      if (contract.hash !== event.contract_hash) {
        throw new HarnessError('invalid_event_chain', `event ${envelope.sequence} ratified contract hash mismatch`);
      }
      if (contract.verifier_id !== event.verifier_id) {
        throw new HarnessError('invalid_event_chain', `event ${envelope.sequence} ratifier is not the contract verifier`);
      }
      if (contract.proposed_by === event.verifier_id) {
        throw new HarnessError('invalid_event_chain', `event ${envelope.sequence} self-ratifies a contract`);
      }
    } else if (event.type === 'worker_proposed') {
      if (event.proposal_hash !== undefined && proposalHash(event.proposal) !== event.proposal_hash) {
        throw new HarnessError('invalid_event_chain', `event ${envelope.sequence} proposal hash mismatch`);
      }
    } else if (event.type === 'proposal_verified') {
      const recordedProposal = state.proposals.get(event.proposal_id);
      if (!recordedProposal || recordedProposal.proposal_hash !== event.proposal_hash) {
        throw new HarnessError('invalid_event_chain', `event ${envelope.sequence} verifies a missing or altered worker proposal`);
      }
      const contract = [...state.contracts.values()].find((candidate) => candidate.hash === event.contract_hash);
      if (!contract || contract.status !== 'ratified') {
        throw new HarnessError('invalid_event_chain', `event ${envelope.sequence} verifies without a ratified contract`);
      }
      if (event.contract_hash !== contract.hash) {
        throw new HarnessError('invalid_event_chain', `event ${envelope.sequence} verification contract hash mismatch`);
      }
      if (event.verifier_id !== contract.ratified_by) {
        throw new HarnessError('invalid_event_chain', `event ${envelope.sequence} verifier is not the ratified contract verifier`);
      }
      if (recordedProposal.worker_id === event.verifier_id) {
        throw new HarnessError('invalid_event_chain', `event ${envelope.sequence} verifier matches worker`);
      }
      if (recordedProposal.scope !== event.scope || recordedProposal.effect !== event.effect) {
        throw new HarnessError('invalid_event_chain', `event ${envelope.sequence} verification scope or effect mismatch`);
      }
      if (typeof event.trust !== 'number' || event.trust <= 0 || event.trust > 1) {
        throw new HarnessError('invalid_event_chain', `event ${envelope.sequence} verification trust must be >0 and <=1`);
      }
      const hasEvidence = typeof event.evidence_hash === 'string' && event.evidence_hash.trim()
        || (Array.isArray(event.evidence_refs) && event.evidence_refs.length > 0);
      if (!hasEvidence) {
        throw new HarnessError('invalid_event_chain', `event ${envelope.sequence} verification must include evidence`);
      }
      const observedAt = parseMillis(event.observed_at, `events[${envelope.sequence}].event.observed_at`);
      const expiresAt = parseMillis(event.expires_at, `events[${envelope.sequence}].event.expires_at`);
      if (expiresAt <= observedAt) {
        throw new HarnessError('invalid_event_chain', `event ${envelope.sequence} verification expires_at must be after observed_at`);
      }
      if (expiresAt > Date.parse(contract.expires_at)) {
        throw new HarnessError('invalid_event_chain', `event ${envelope.sequence} verification expiry exceeds contract expiry`);
      }
    } else if (event.type === 'capability_issued') {
      const capability = event.capability;
      const verification = state.proposal_verifications.get(capability?.proposal_hash);
      if (!verification || verification.status !== 'pass') {
        throw new HarnessError('invalid_event_chain', `event ${envelope.sequence} issues capability without passing verification`);
      }
      if (verification.contract_hash !== capability.contract_hash || verification.effect !== capability.effect || verification.scope !== capability.scope) {
        throw new HarnessError('invalid_event_chain', `event ${envelope.sequence} capability does not match verification`);
      }
      const contract = [...state.contracts.values()].find((candidate) => candidate.hash === capability.contract_hash);
      if (!contract || contract.status !== 'ratified') {
        throw new HarnessError('invalid_event_chain', `event ${envelope.sequence} capability is not bound to a ratified contract`);
      }
      if (verification.verifier_id !== contract.ratified_by || capability.verified_by !== contract.ratified_by) {
        throw new HarnessError('invalid_event_chain', `event ${envelope.sequence} capability verifier is not the ratified contract verifier`);
      }
      if (!contract.effect_allowlist.length || !contract.effect_allowlist.some((entry) => (
        entry.effect === capability.effect && scopeMatches(entry.scope ?? contract.scope, capability.scope)
      ))) {
        throw new HarnessError('invalid_event_chain', `event ${envelope.sequence} capability effect is not allowed by contract`);
      }
      if (capability.token !== undefined) {
        throw new HarnessError('invalid_event_chain', `event ${envelope.sequence} persisted a capability token`);
      }
    } else if (event.type === 'capability_reserved') {
      const reservation = event.reservation;
      const capability = state.capabilities.get(reservation?.capability_id);
      if (!capability || capability.consumed || capability.failed) {
        throw new HarnessError('invalid_event_chain', `event ${envelope.sequence} reserves a missing or terminal capability`);
      }
      if (reservation.lease_secret !== undefined || typeof reservation.lease_secret_hash !== 'string' || !reservation.lease_secret_hash.trim()) {
        throw new HarnessError('invalid_event_chain', `event ${envelope.sequence} reservation must persist only a lease secret hash`);
      }
      if (capability.effect !== reservation.effect || capability.scope !== reservation.scope || capability.idempotency_key !== reservation.idempotency_key) {
        throw new HarnessError('invalid_event_chain', `event ${envelope.sequence} reservation does not match capability`);
      }
      const active = [...state.reservations.values()].find((candidate) => candidate.capability_id === capability.id && candidate.status === 'active');
      if (active) {
        throw new HarnessError('invalid_event_chain', `event ${envelope.sequence} reserves an already active capability`);
      }
    } else if (event.type === 'effect_committed') {
      const reservation = state.reservations.get(event.reservation_id);
      if (!reservation || reservation.status !== 'active') {
        throw new HarnessError('invalid_event_chain', `event ${envelope.sequence} commits without an active reservation`);
      }
      const capability = state.capabilities.get(event.capability_id);
      if (!capability || capability.id !== reservation.capability_id || capability.consumed || capability.failed) {
        throw new HarnessError('invalid_event_chain', `event ${envelope.sequence} commits a missing or terminal capability`);
      }
      if (
        reservation.adapter_id !== event.adapter_id
        || reservation.effect !== event.effect
        || reservation.scope !== event.scope
        || reservation.idempotency_key !== event.operation_idempotency_key
      ) {
        throw new HarnessError('invalid_event_chain', `event ${envelope.sequence} commit does not match reservation`);
      }
    } else if (event.type === 'capability_reservation_failed' || event.type === 'capability_reservation_expired') {
      const reservation = state.reservations.get(event.reservation_id);
      if (!reservation || reservation.status !== 'active') {
        throw new HarnessError('invalid_event_chain', `event ${envelope.sequence} terminates a missing or inactive reservation`);
      }
    }
    reduceEvent(state, envelope);
  }
  return true;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readJsonlEvents(filePath) {
  let events = [];
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (content.length > 0 && !content.endsWith('\n')) {
      throw new HarnessError('invalid_event_chain', `event log ${filePath} ends with a partial line`);
    }
    events = content.split('\n').filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new HarnessError('invalid_event_chain', `event log ${filePath} has invalid JSON on line ${index + 1}`, { cause: error.message });
      }
    });
    validateEnvelopeChain(events);
    validateSemanticReplay(events);
  }
  return events;
}

export class JsonlEventStore extends MemoryEventStore {
  constructor(filePath, options = {}) {
    const events = readJsonlEvents(filePath);
    super(events);
    this.filePath = filePath;
    this.lockPath = options.lockPath ?? `${filePath}.lock`;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_JSONL_LOCK_TIMEOUT_MS;
    this.lockStaleMs = options.lockStaleMs ?? DEFAULT_JSONL_LOCK_STALE_MS;
  }

  #replaceMemory(events) {
    this.events = [];
    this.idempotencyKeys = new Set();
    this.externalSequences = new Set();
    validateEnvelopeChain(events);
    for (const envelope of events) loadEnvelopeIntoStore(this, envelope);
  }

  #withLock(operation) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const started = Date.now();
    const owner = {
      pid: process.pid,
      created_at: new Date().toISOString(),
      created_ms: Date.now(),
      file: this.filePath,
    };
    while (true) {
      let fd = null;
      try {
        fd = fs.openSync(this.lockPath, 'wx');
        fs.writeSync(fd, `${JSON.stringify(owner)}\n`);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = null;
        try {
          return operation();
        } finally {
          try {
            fs.unlinkSync(this.lockPath);
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
          }
        }
      } catch (error) {
        if (fd !== null) fs.closeSync(fd);
        if (error?.code !== 'EEXIST') throw error;
        let lock = null;
        try {
          lock = JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
        } catch {
          lock = null;
        }
        const ageMs = Date.now() - (Number.isFinite(lock?.created_ms) ? lock.created_ms : Date.parse(lock?.created_at ?? 0));
        const staleByTime = Number.isFinite(ageMs) && ageMs >= this.lockStaleMs;
        const ownerAlive = pidIsAlive(lock?.pid);
        if (staleByTime && !ownerAlive) {
          try {
            fs.unlinkSync(this.lockPath);
            continue;
          } catch (unlinkError) {
            if (unlinkError?.code !== 'ENOENT') throw unlinkError;
          }
        }
        if (Date.now() - started >= this.lockTimeoutMs) {
          throw new HarnessError('event_store_locked', `could not acquire event log lock ${this.lockPath} within ${this.lockTimeoutMs}ms`);
        }
        sleepSync(Math.min(25, Math.max(1, this.lockTimeoutMs - (Date.now() - started))));
      }
    }
  }

  #appendLine(envelope) {
    const fd = fs.openSync(this.filePath, 'a');
    try {
      fs.writeSync(fd, `${JSON.stringify(envelope)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  append(event, options = {}) {
    return this.#withLock(() => {
      this.#replaceMemory(readJsonlEvents(this.filePath));
      const result = super.append(event, options);
      this.#appendLine(result.envelope);
      return result;
    });
  }
}

export class VerifierRegistry {
  constructor(verifiers = []) {
    this.verifiers = new Map(verifiers.map((verifier) => {
      const normalized = normalizeVerifier(verifier);
      return [normalized.id, normalized];
    }));
  }

  register(verifier) {
    const normalized = normalizeVerifier(verifier);
    this.verifiers.set(normalized.id, normalized);
    return normalized;
  }

  get(id) {
    return this.verifiers.get(id) ?? null;
  }

  canRatify(contract, verifierId) {
    const verifier = this.get(verifierId);
    if (!verifier || !verifier.active) {
      return { ok: false, reason_code: 'missing_verifier', reason: `verifier ${verifierId} is missing or inactive` };
    }
    if (contract.proposed_by === verifier.id) {
      return { ok: false, reason_code: 'missing_verifier', reason: 'contract cannot be ratified by its proposer' };
    }
    if (!verifier.scopes.some((scope) => scopeMatches(scope, contract.scope))) {
      return { ok: false, reason_code: 'missing_verifier', reason: `verifier ${verifier.id} is not trusted for ${contract.scope}` };
    }
    return { ok: true, verifier };
  }
}

export function proposalOnlyWorker({ id = 'worker', contract, proposals = [] } = {}) {
  const workerId = normalizeIdentity(id, 'worker.id');
  return {
    id: workerId,
    proposeContract(goal) {
      if (!contract && !goal.contract) return null;
      return normalizeContract(contract ?? goal.contract, {
        goal_id: goal.id,
        proposed_by: workerId,
        verifier_id: goal.verifier_id,
        scope: goal.scope,
        expires_at: goal.expires_at,
      });
    },
    async propose() {
      return proposals.map((proposal, index) => normalizeProposal(proposal, index));
    },
  };
}

export function createEffectAdapter({
  id = 'effect-adapter',
  effect,
  scopes = ['*'],
  execute,
} = {}) {
  assertNonEmptyString(effect, 'effect');
  if (typeof execute !== 'function') {
    throw new HarnessError('invalid_input', 'adapter execute must be a function');
  }
  const adapter = Object.freeze({
    id: normalizeIdentity(id, 'adapter.id'),
    effect: normalizeIdentity(effect, 'adapter.effect'),
    scopes: scopes.map(normalizeScope),
  });
  ADAPTER_EXECUTORS.set(adapter, execute);
  return adapter;
}

export const createGatedAdapter = createEffectAdapter;

export function createMemoryEffectAdapter({
  id = 'memory-adapter',
  effect,
  scopes = ['*'],
  failTimes = 0,
  sink = [],
} = {}) {
  assertNonEmptyString(effect, 'effect');
  const adapterId = normalizeIdentity(id, 'adapter.id');
  const adapterEffect = normalizeIdentity(effect, 'adapter.effect');
  let failuresRemaining = failTimes;
  return createEffectAdapter({
    id: adapterId,
    effect: adapterEffect,
    scopes: scopes.map(normalizeScope),
    async execute({ proposal }) {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new HarnessError('adapter_failed', `${adapterId} simulated failure`);
      }
      const result = {
        adapter_id: adapterId,
        proposal_id: proposal.id,
        effect: proposal.effect,
        scope: proposal.scope,
        payload: proposal.payload,
      };
      sink.push(result);
      return result;
    },
  });
}

function adapterAllows(adapter, proposal) {
  return adapter.effect === proposal.effect && (adapter.scopes ?? ['*']).some((scope) => scopeMatches(scope, proposal.scope));
}

export class HarnessEngine {
  constructor({
    deployment_id = 'frontier-harness',
    goal,
    worker,
    verifiers = [],
    adapters = [],
    budgets = {},
    store = new MemoryEventStore(),
    now = DEFAULT_NOW,
    operator_dial = 0,
    tokenSource = () => crypto.randomBytes(32).toString('base64url'),
    elapsedSource = () => Number(process.hrtime.bigint() / 1_000_000n),
  } = {}) {
    assertObject(goal, 'goal');
    assertNonEmptyString(goal.id, 'goal.id');
    this.deployment_id = normalizeIdentity(deployment_id, 'deployment_id');
    this.goal = clone(goal);
    this.worker = worker ?? proposalOnlyWorker({ id: goal.proposed_by ?? 'worker', contract: goal.contract, proposals: goal.proposals ?? [] });
    this.verifiers = verifiers instanceof VerifierRegistry ? verifiers : new VerifierRegistry(verifiers);
    this.adapters = new Map(adapters.map((adapter) => {
      const normalizedId = normalizeIdentity(adapter.id, 'adapter.id');
      if (adapter.id !== normalizedId) {
        throw new HarnessError('invalid_input', 'adapter.id must already be normalized by createEffectAdapter');
      }
      return [normalizedId, adapter];
    }));
    this.budgets = { ...DEFAULT_BUDGETS, ...budgets };
    this.store = store;
    this.now = now;
    this.operator_dial = assertProbability(operator_dial, 'operator_dial');
    this.tokenSource = tokenSource;
    this.elapsedSource = elapsedSource;
    if (this.operator_dial !== 0 && this.store.state().operator_dial !== this.operator_dial) {
      this.setOperatorDial(this.operator_dial, 'initial operator dial');
    }
  }

  currentTime() {
    return nowFromClock(this.now);
  }

  elapsedMs() {
    const value = this.elapsedSource();
    if (!Number.isFinite(value)) throw new HarnessError('invalid_clock', 'elapsedSource must return a finite number');
    return value;
  }

  state() {
    return serializableState(this.store.state());
  }

  setOperatorDial(operatorDial, reason = 'operator dial update') {
    const at = this.currentTime();
    const normalizedDial = assertProbability(operatorDial, 'operator_dial');
    appendInternal(this.store, {
      type: 'operator_dial_set',
      at,
      idempotency_key: `operator-dial:${normalizedDial}:${sha256(reason).slice(0, 10)}:${this.store.list().length + 1}`,
      operator_dial: normalizedDial,
      previous_operator_dial: this.store.state().operator_dial,
      reason,
    });
    this.operator_dial = normalizedDial;
    return { ok: true, operator_dial: normalizedDial };
  }

  proposeContract(contract = null) {
    const normalized = normalizeContract(contract ?? this.worker.proposeContract?.(this.goal) ?? this.goal.contract, {
      goal_id: this.goal.id,
      proposed_by: this.worker.id,
      verifier_id: this.goal.verifier_id,
      scope: this.goal.scope,
      expires_at: this.goal.expires_at,
    });
    const hash = contractHash(normalized);
    appendInternal(this.store, {
      type: 'contract_proposed',
      at: this.currentTime(),
      idempotency_key: `contract:${normalized.id}:proposed`,
      contract: normalized,
      contract_hash: hash,
    });
    return { contract: normalized, contract_hash: hash };
  }

  ratifyContract(contractId = this.store.state().current_contract_id, verifierId = null, contractSnapshot = null) {
    const state = this.store.state();
    const contract = state.contracts.get(contractId);
    if (!contract) throw new HarnessError('missing_contract', `contract ${contractId} is not proposed`);
    const at = this.currentTime();
    if (Date.parse(contract.expires_at) <= Date.parse(at)) {
      appendInternal(this.store, {
        type: 'contract_rejected',
        at,
        idempotency_key: `contract:${contract.id}:expired:${at}`,
        contract_id: contract.id,
        reason_code: 'unratified_contract',
        reason: 'contract is expired',
      });
      return { ok: false, reason: 'contract is expired' };
    }
    const expectedHash = contract.hash;
    if (contractSnapshot && contractHash(normalizeContract(contractSnapshot)) !== expectedHash) {
      appendInternal(this.store, {
        type: 'contract_rejected',
        at,
        idempotency_key: `contract:${contract.id}:altered:${at}`,
        contract_id: contract.id,
        reason_code: 'unratified_contract',
        reason: 'contract snapshot hash does not match proposed contract',
      });
      return { ok: false, reason: 'contract snapshot hash does not match proposed contract' };
    }
    const selectedVerifier = normalizeIdentity(verifierId ?? contract.verifier_id, 'verifier_id');
    if (selectedVerifier !== contract.verifier_id) {
      appendInternal(this.store, {
        type: 'contract_rejected',
        at,
        idempotency_key: `contract:${contract.id}:wrong-verifier:${selectedVerifier}:${at}`,
        contract_id: contract.id,
        reason_code: 'missing_verifier',
        reason: 'contract must be ratified by its nominated verifier',
      });
      return { ok: false, reason: 'contract must be ratified by its nominated verifier' };
    }
    const allowed = this.verifiers.canRatify(contract, selectedVerifier);
    if (!allowed.ok) {
      appendInternal(this.store, {
        type: 'contract_rejected',
        at,
        idempotency_key: `contract:${contract.id}:rejected:${selectedVerifier}:${at}`,
        contract_id: contract.id,
        reason_code: allowed.reason_code,
        reason: allowed.reason,
      });
      return { ok: false, reason: allowed.reason };
    }
    appendInternal(this.store, {
      type: 'contract_ratified',
      at,
      idempotency_key: `contract:${contract.id}:ratified:${selectedVerifier}`,
      contract_id: contract.id,
      contract_hash: expectedHash,
      verifier_id: selectedVerifier,
    });
    return { ok: true, verifier: allowed.verifier, contract_hash: expectedHash };
  }

  async recordProposalVerification(proposal, verifierId = null, options = {}) {
    const normalizedProposal = normalizeProposal(proposal);
    const state = this.store.state();
    const contract = state.current_contract_id ? state.contracts.get(state.current_contract_id) : null;
    const at = this.currentTime();
    const hash = proposalHash(normalizedProposal);
    const reject = (reason, reasonCode = 'governance_gate_failed') => {
      appendInternal(this.store, {
        type: 'proposal_verification_rejected',
        at,
        idempotency_key: `proposal-verification-rejected:${normalizedProposal.id}:${sha256(reason).slice(0, 10)}:${this.store.list().length + 1}`,
        proposal_id: normalizedProposal.id,
        proposal_hash: hash,
        reason,
        reason_code: reasonCode,
      });
      return { ok: false, reason };
    };
    if (!contract || contract.status !== 'ratified') return reject('contract is not ratified', 'unratified_contract');
    if (Date.parse(contract.expires_at) <= Date.parse(at)) return reject('contract is expired', 'unratified_contract');
    if (!scopeMatches(contract.scope, normalizedProposal.scope)) {
      return reject(`proposal scope ${normalizedProposal.scope} is outside contract scope ${contract.scope}`);
    }
    const selectedVerifier = normalizeIdentity(verifierId ?? contract.ratified_by, 'verifier_id');
    if (selectedVerifier !== contract.ratified_by) {
      return reject('proposal verification must be performed by the ratified contract verifier', 'missing_verifier');
    }
    const verifier = this.verifiers.get(selectedVerifier);
    if (!verifier || !verifier.active) return reject(`verifier ${selectedVerifier} is missing or inactive`, 'missing_verifier');
    const recordedProposal = state.proposals.get(normalizedProposal.id);
    if (!recordedProposal) return reject('proposal must be recorded by worker_proposed before verification', 'governance_gate_failed');
    if (recordedProposal.proposal_hash !== hash) return reject('recorded worker proposal hash mismatch', 'governance_gate_failed');
    const proposer = recordedProposal.worker_id;
    if (verifier.id === proposer) return reject('proposal verifier cannot be the worker/proposer', 'missing_verifier');
    if (!verifier.scopes.some((scope) => scopeMatches(scope, normalizedProposal.scope))) {
      return reject(`verifier ${verifier.id} is not trusted for ${normalizedProposal.scope}`, 'missing_verifier');
    }
    const context = {
      proposal: clone(normalizedProposal),
      proposal_hash: proposalHash(normalizedProposal),
      contract: clone(contract),
      contract_hash: contract.hash,
      goal: clone(this.goal),
      state: this.state(),
    };
    let verdict = null;
    try {
      if (options.verdict) {
        if (!verifier.verifyAttestation) {
          return reject(`verifier ${verifier.id} cannot validate external proposal attestations`, 'missing_verifier');
        }
        verdict = await verifier.verifyAttestation(options.verdict, context);
      } else if (verifier.verify) {
        verdict = await verifier.verify({
          ...context,
        });
      }
    } catch (error) {
      return reject(`verifier ${verifier.id} threw during verification: ${error.message}`);
    }
    if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict)) {
      return reject(`verifier ${verifier.id} did not provide an evidence-bound verdict`, 'missing_verifier');
    }
    if (verdict.passed !== true) return reject(verdict.reason ?? 'proposal verification did not pass');
    let verdictProducer;
    try {
      verdictProducer = normalizeOptionalIdentity(verdict.produced_by, 'verdict.produced_by');
    } catch (error) {
      return reject(error.message);
    }
    if (verdictProducer && verdictProducer === proposer) return reject('proposal verifier echoed the worker/proposer', 'missing_verifier');
    if (verdict.proposal_hash && verdict.proposal_hash !== proposalHash(normalizedProposal)) return reject('proposal verification hash mismatch');
    if (verdict.contract_hash && verdict.contract_hash !== contract.hash) return reject('proposal verification contract hash mismatch');
    if (typeof verdict.trust !== 'number' || verdict.trust <= 0 || verdict.trust > 1) {
      return reject('proposal verification trust must be >0 and <=1');
    }
    const hasEvidence = typeof verdict.evidence_hash === 'string' && verdict.evidence_hash.trim()
      || (Array.isArray(verdict.evidence_refs) && verdict.evidence_refs.length > 0);
    if (!hasEvidence) return reject('proposal verification must include evidence refs or an evidence hash');
    let observedAt;
    let expiresAt;
    try {
      observedAt = normalizeTimestamp(verdict.observed_at ?? options.observed_at ?? at, 'verdict.observed_at');
      expiresAt = normalizeTimestamp(verdict.expires_at ?? options.expires_at ?? new Date(Date.parse(observedAt) + 60_000).toISOString(), 'verdict.expires_at');
    } catch (error) {
      return reject(error.message);
    }
    if (Date.parse(observedAt) > Date.parse(at)) return reject('proposal verification observed_at is in the future');
    if (Date.parse(expiresAt) <= Date.parse(at)) return reject('proposal verification is expired');
    if (Date.parse(expiresAt) <= Date.parse(observedAt)) return reject('proposal verification expires_at must be after observed_at');
    if (Date.parse(expiresAt) > Date.parse(contract.expires_at)) return reject('proposal verification expiry exceeds contract expiry');
    appendInternal(this.store, {
      type: 'proposal_verified',
      at,
      idempotency_key: `proposal-verified:${hash}:${verifier.id}`,
      proposal_id: normalizedProposal.id,
      proposal_hash: hash,
      contract_hash: contract.hash,
      scope: normalizedProposal.scope,
      effect: normalizedProposal.effect,
      verifier_id: verifier.id,
      trust: verdict.trust,
      evidence_hash: verdict.evidence_hash ?? sha256(verdict.evidence_refs),
      evidence_refs: verdict.evidence_refs ?? [],
      observed_at: observedAt,
      expires_at: expiresAt,
    });
    return { ok: true, proposal_hash: hash, verifier, expires_at: expiresAt, verdict: clone(verdict) };
  }

  halt(reason = 'operator halt') {
    appendInternal(this.store, {
      type: 'halted',
      at: this.currentTime(),
      idempotency_key: `halt:${sha256(reason).slice(0, 12)}:${this.store.list().length + 1}`,
      reason,
    });
  }

  override(reason = 'operator override') {
    appendInternal(this.store, {
      type: 'override_set',
      at: this.currentTime(),
      idempotency_key: `override:${sha256(reason).slice(0, 12)}:${this.store.list().length + 1}`,
      reason,
    });
  }

  clearOverride(reason = 'override cleared') {
    appendInternal(this.store, {
      type: 'override_cleared',
      at: this.currentTime(),
      idempotency_key: `override-clear:${sha256(reason).slice(0, 12)}:${this.store.list().length + 1}`,
      reason,
    });
  }

  #reapExpiredReservations(at = this.currentTime()) {
    const state = this.store.state();
    for (const reservation of state.reservations.values()) {
      if (reservation.status !== 'active') continue;
      const capability = state.capabilities.get(reservation.capability_id);
      const leaseExpired = Date.parse(reservation.lease_expires_at) <= Date.parse(at);
      const capabilityExpired = capability && Date.parse(capability.expires_at) <= Date.parse(at);
      if (!leaseExpired && !capabilityExpired) continue;
      appendInternal(this.store, {
        type: 'capability_reservation_expired',
        at,
        idempotency_key: `reservation-expired:${reservation.id}:${this.store.list().length + 1}`,
        reservation_id: reservation.id,
        capability_id: reservation.capability_id,
        reason: capabilityExpired ? 'capability expired while reserved' : 'reservation lease expired',
      });
    }
  }

  #rejectReservationOperation(reservationId, reason) {
    appendInternal(this.store, {
      type: 'reservation_operation_rejected',
      at: this.currentTime(),
      idempotency_key: `reservation-operation-rejected:${reservationId ?? 'unknown'}:${sha256(reason).slice(0, 10)}:${this.store.list().length + 1}`,
      reservation_id: reservationId ?? null,
      reason,
    });
    return { status: 'rejected', reason };
  }

  runtimeHealth(extraIssues = []) {
    this.#reapExpiredReservations();
    const state = this.store.state();
    const at = this.currentTime();
    const contract = state.current_contract_id ? state.contracts.get(state.current_contract_id) : null;
    const ratifier = contract?.ratified_by ? this.verifiers.get(contract.ratified_by) : null;
    const ratifierCanRun = Boolean(ratifier?.active && (ratifier.verify || ratifier.verifyAttestation));
    const checks = {
      process: [{
        id: 'process-not-halted',
        status: state.halted ? 'fail' : 'pass',
        reason_code: state.halted ? 'no_ack_halt' : undefined,
        observed_at: at,
        stale_after_seconds: 60,
        summary: state.halted ? state.halt_reason ?? 'halted' : 'process accepts work',
      }],
      scheduler: [{
        id: 'budget-concurrency',
        status: state.active_effects >= this.budgets.concurrency ? 'fail' : 'pass',
        reason_code: state.active_effects >= this.budgets.concurrency ? 'scheduler_stalled' : undefined,
        observed_at: at,
        stale_after_seconds: 60,
        summary: 'attempt, wall-clock, and concurrency budgets are enforced',
      }],
      execution: [{
        id: 'quarantine-empty',
        status: state.quarantine.size > 0 ? 'fail' : 'pass',
        reason_code: state.quarantine.size > 0 ? 'scheduler_stalled' : undefined,
        observed_at: at,
        stale_after_seconds: 60,
        summary: state.quarantine.size > 0 ? 'one or more proposals are quarantined' : 'no quarantined proposals',
      }],
      governance: [{
        id: 'ratified-independent-contract',
        status: contract?.status === 'ratified' && contract.ratified_by !== contract.proposed_by ? 'pass' : 'fail',
        reason_code: contract ? 'unratified_contract' : 'missing_verifier',
        observed_at: at,
        stale_after_seconds: 60,
        summary: contract ? 'current contract must be verifier-ratified independently' : 'no proposed contract',
      }, {
        id: 'proposal-run-verifier-available',
        status: ratifierCanRun ? 'pass' : 'fail',
        reason_code: 'missing_verifier',
        observed_at: at,
        stale_after_seconds: 60,
        summary: ratifierCanRun ? 'ratifying verifier can verify proposals or attestations' : 'ratifying verifier cannot run proposal verification',
      }],
    };

    if (state.override_active) {
      checks.governance.push({
        id: 'operator-override-active',
        status: 'fail',
        reason_code: 'active_override',
        observed_at: at,
        stale_after_seconds: 60,
        summary: state.override_reason ?? 'operator override active',
      });
    }
    for (const issue of [...state.health_issues, ...extraIssues]) {
      const layer = HEALTH_LAYERS.includes(issue.layer) ? issue.layer : 'execution';
      checks[layer].push({
        id: `issue-${sha256(issue.summary ?? issue.reason_code).slice(0, 10)}`,
        status: 'fail',
        reason_code: issue.reason_code ?? 'governance_gate_failed',
        observed_at: at,
        stale_after_seconds: 60,
        summary: issue.summary ?? issue.reason ?? 'harness issue',
      });
    }
    const health = {
      schema_version: RUNTIME_HEALTH_SCHEMA_VERSION,
      deployment_id: this.deployment_id,
      checked_at: at,
      layers: Object.fromEntries(HEALTH_LAYERS.map((layer) => [layer, { checks: checks[layer] }])),
      aggregate_policy: {
        status: 'fail_closed',
        rule: 'effects require ratified contract, healthy gate, scoped unexpired capability, and registered opaque adapter execution',
      },
    };
    return { health, report: evaluateRuntimeHealth(health) };
  }

  issueCapability(proposal, options = {}) {
    const normalizedProposal = normalizeProposal(proposal);
    this.#reapExpiredReservations();
    const state = this.store.state();
    const contract = state.current_contract_id ? state.contracts.get(state.current_contract_id) : null;
    const at = this.currentTime();
    if (!contract || contract.status !== 'ratified') {
      return this.#rejectCapability(normalizedProposal, 'contract is not ratified', 'unratified_contract');
    }
    if (Date.parse(contract.expires_at) <= Date.parse(at)) {
      return this.#rejectCapability(normalizedProposal, 'contract is expired', 'unratified_contract');
    }
    const health = this.runtimeHealth();
    if (!health.report.can_mutate) {
      return this.#rejectCapability(normalizedProposal, `runtime health is ${health.report.status}`, 'governance_gate_failed');
    }
    if (!scopeMatches(contract.scope, normalizedProposal.scope)) {
      return this.#rejectCapability(normalizedProposal, `proposal scope ${normalizedProposal.scope} is outside contract scope ${contract.scope}`, 'governance_gate_failed');
    }
    const allowed = contract.effect_allowlist.length > 0
      && contract.effect_allowlist.some((entry) => entry.effect === normalizedProposal.effect && scopeMatches(entry.scope ?? contract.scope, normalizedProposal.scope));
    if (!allowed) {
      return this.#rejectCapability(normalizedProposal, `effect ${normalizedProposal.effect} is not allowed by contract`, 'governance_gate_failed');
    }
    const hash = proposalHash(normalizedProposal);
    const recordedProposal = state.proposals.get(normalizedProposal.id);
    if (!recordedProposal) {
      return this.#rejectCapability(normalizedProposal, 'proposal must be recorded by worker_proposed before capability issuance', 'governance_gate_failed');
    }
    if (recordedProposal.proposal_hash !== hash) {
      return this.#rejectCapability(normalizedProposal, 'recorded worker proposal hash mismatch', 'governance_gate_failed');
    }
    const verification = state.proposal_verifications.get(hash);
    if (!verification || verification.status !== 'pass') {
      return this.#rejectCapability(normalizedProposal, 'proposal has no recorded passing independent verification', 'missing_verifier');
    }
    const verifier = this.verifiers.get(verification.verifier_id);
    const proposer = recordedProposal.worker_id;
    if (!verifier || !verifier.active || verifier.id === proposer) {
      return this.#rejectCapability(normalizedProposal, 'proposal verification is not independently trusted', 'missing_verifier');
    }
    if (verification.contract_hash !== contract.hash) {
      return this.#rejectCapability(normalizedProposal, 'proposal verification is bound to a different contract', 'governance_gate_failed');
    }
    if (verification.verifier_id !== contract.ratified_by) {
      return this.#rejectCapability(normalizedProposal, 'proposal verification must be bound to the ratified contract verifier', 'missing_verifier');
    }
    if (verification.scope !== normalizedProposal.scope || verification.effect !== normalizedProposal.effect) {
      return this.#rejectCapability(normalizedProposal, 'proposal verification scope or effect mismatch', 'governance_gate_failed');
    }
    if (Date.parse(verification.expires_at) <= Date.parse(at)) {
      return this.#rejectCapability(normalizedProposal, 'proposal verification is expired', 'governance_gate_failed');
    }
    if (!verifier.scopes.some((scope) => scopeMatches(scope, normalizedProposal.scope))) {
      return this.#rejectCapability(normalizedProposal, 'proposal verifier lacks scoped trust', 'missing_verifier');
    }
    const operatorDial = state.operator_dial;
    const authority = Math.min(operatorDial, contract.autonomy_ceiling, verification.trust, verifier.trust_ceiling);
    if (authority !== 1) {
      return this.#rejectCapability(
        normalizedProposal,
        `effect authority ${authority} is below required 1 (operator_dial=${operatorDial}, contract_autonomy_ceiling=${contract.autonomy_ceiling}, verdict_trust=${verification.trust}, verifier_trust_ceiling=${verifier.trust_ceiling})`,
        'governance_gate_failed',
      );
    }
    const expiresAt = normalizeTimestamp(options.expires_at ?? new Date(Date.parse(at) + 60_000).toISOString(), 'capability.expires_at');
    if (Date.parse(expiresAt) > Date.parse(contract.expires_at)) {
      return this.#rejectCapability(normalizedProposal, 'capability expiry exceeds contract expiry', 'governance_gate_failed');
    }
    const id = options.id ?? `cap-${sha256({ proposal: normalizedProposal, at, contract_hash: contract.hash, nonce: this.tokenSource() }).slice(0, 18)}`;
    const token = `tok_${this.tokenSource()}`;
    const capability = {
      id,
      token,
      token_hash: sha256(token),
      contract_id: contract.id,
      contract_hash: contract.hash,
      proposal_hash: hash,
      proposal_id: normalizedProposal.id,
      verified_by: verifier.id,
      effect: normalizedProposal.effect,
      scope: normalizedProposal.scope,
      one_time: options.one_time !== false,
      expires_at: expiresAt,
      idempotency_key: normalizedProposal.idempotency_key,
      authority,
      operator_dial: operatorDial,
      contract_autonomy_ceiling: contract.autonomy_ceiling,
      verdict_trust: verification.trust,
      verifier_trust_ceiling: verifier.trust_ceiling,
    };
    appendInternal(this.store, {
      type: 'capability_issued',
      at,
      idempotency_key: `capability:${id}:issued`,
      capability: { ...capability, token: undefined },
    });
    return { ok: true, capability };
  }

  #rejectCapability(proposal, reason, reasonCode) {
    appendInternal(this.store, {
      type: 'capability_rejected',
      at: this.currentTime(),
      idempotency_key: `capability-rejected:${proposal.id}:${sha256(reason).slice(0, 10)}:${this.store.list().length + 1}`,
      proposal_id: proposal.id,
      reason,
      reason_code: reasonCode,
    });
    return { ok: false, reason };
  }

  #reserveCapability({ capability, proposal_hash, effect, scope, idempotency_key, adapter_id, lease_expires_at }) {
    this.#reapExpiredReservations();
    const state = this.store.state();
    const at = this.currentTime();
    assertObject(capability, 'capability');
    assertNonEmptyString(capability.id, 'capability.id');
    const normalizedAdapterId = normalizeIdentity(adapter_id, 'adapter_id');
    const normalizedEffect = normalizeIdentity(effect, 'effect');
    const normalizedScope = normalizeScope(scope);
    const normalizedIdempotencyKey = normalizeIdentity(idempotency_key, 'idempotency_key');
    const normalizedProposalHash = normalizeIdentity(proposal_hash, 'proposal_hash');
    const stored = state.capabilities.get(capability.id);
    const fail = (reason) => {
      appendInternal(this.store, {
        type: 'capability_rejected',
        at,
        idempotency_key: `consume-rejected:${capability.id}:${sha256(reason).slice(0, 10)}:${this.store.list().length + 1}`,
        proposal_id: capability.proposal_id ?? null,
        reason,
        reason_code: 'governance_gate_failed',
      });
      return { status: 'rejected', reason };
    };
    const adapter = this.adapters.get(normalizedAdapterId);
    if (!adapter) return fail(`adapter ${normalizedAdapterId} is not registered`);
    if (!adapterAllows(adapter, { effect: normalizedEffect, scope: normalizedScope })) return fail(`adapter ${normalizedAdapterId} is not allowed for ${normalizedEffect} ${normalizedScope}`);
    if (!stored) return fail('capability is forged or unknown');
    if (sha256(capability.token ?? '') !== stored.token_hash) return fail('capability token is forged');
    if (stored.proposal_hash !== normalizedProposalHash) return fail('capability proposal hash mismatch');
    if (Date.parse(stored.expires_at) <= Date.parse(at)) return fail('capability is expired');
    if (stored.one_time !== true) return fail('capability must be one-time');
    if (stored.effect !== normalizedEffect) return fail('capability effect mismatch');
    if (!scopeMatches(stored.scope, normalizedScope) || !scopeMatches(normalizedScope, stored.scope)) return fail('capability scope mismatch');
    if (stored.idempotency_key !== normalizedIdempotencyKey) return fail('capability idempotency key mismatch');
    if (stored.consumed || stored.failed) {
      if (state.effects.has(normalizedIdempotencyKey)) return { status: 'duplicate', result: state.effects.get(normalizedIdempotencyKey) };
      return fail('capability already reached a terminal state');
    }
    const prior = state.consumed_capabilities.get(stored.id);
    if (prior) {
      if (prior.idempotency_key === normalizedIdempotencyKey && prior.effect === normalizedEffect && prior.scope === normalizedScope) {
        return { status: 'duplicate', result: prior.result };
      }
      return fail('capability was already consumed for a different operation');
    }
    if (state.effects.has(normalizedIdempotencyKey)) {
      return { status: 'duplicate', result: state.effects.get(normalizedIdempotencyKey) };
    }
    const activeReservation = [...state.reservations.values()].find((reservation) => (
      reservation.capability_id === stored.id
      && reservation.status === 'active'
      && Date.parse(reservation.lease_expires_at) > Date.parse(at)
    ));
    if (activeReservation) return fail(`capability already reserved by ${activeReservation.id}`);
    const health = this.runtimeHealth();
    if (!health.report.can_mutate) return fail(`runtime health is ${health.report.status}`);
    const leaseExpiresAt = normalizeTimestamp(lease_expires_at ?? new Date(Date.parse(at) + 30_000).toISOString(), 'lease_expires_at');
    if (Date.parse(leaseExpiresAt) > Date.parse(stored.expires_at)) {
      return fail('reservation lease exceeds capability expiry');
    }
    const reservation = {
      id: `res-${sha256({ capability_id: stored.id, adapter_id: normalizedAdapterId, effect: normalizedEffect, scope: normalizedScope, idempotency_key: normalizedIdempotencyKey, at, nonce: this.tokenSource() }).slice(0, 18)}`,
      capability_id: stored.id,
      proposal_id: stored.proposal_id,
      adapter_id: normalizedAdapterId,
      effect: normalizedEffect,
      scope: normalizedScope,
      idempotency_key: normalizedIdempotencyKey,
      lease_expires_at: leaseExpiresAt,
    };
    const leaseSecret = `lease_${this.tokenSource()}`;
    appendInternal(this.store, {
      type: 'capability_reserved',
      at,
      idempotency_key: `reservation:${reservation.id}:reserved`,
      reservation: {
        ...reservation,
        lease_secret_hash: sha256(leaseSecret),
      },
    });
    return { status: 'reserved', reservation: { ...reservation, lease_secret: leaseSecret } };
  }

  #completeCapabilityReservation({ reservation, result }) {
    this.#reapExpiredReservations();
    const state = this.store.state();
    const at = this.currentTime();
    assertObject(reservation, 'reservation');
    assertNonEmptyString(reservation.id, 'reservation.id');
    const storedReservation = state.reservations.get(reservation.id);
    const fail = (reason) => {
      appendInternal(this.store, {
        type: 'capability_reservation_failed',
        at,
        idempotency_key: `reservation-failed:${reservation.id}:${sha256(reason).slice(0, 10)}:${this.store.list().length + 1}`,
        reservation_id: reservation.id,
        reason,
      });
      return { status: 'rejected', reason };
    };
    if (!storedReservation) return this.#rejectReservationOperation(reservation.id, 'reservation is unknown');
    if (normalizeOptionalIdentity(reservation.adapter_id, 'reservation.adapter_id') !== storedReservation.adapter_id) {
      return this.#rejectReservationOperation(reservation.id, 'reservation adapter identity mismatch');
    }
    if (sha256(reservation.lease_secret ?? '') !== storedReservation.lease_secret_hash) {
      return this.#rejectReservationOperation(reservation.id, 'reservation lease secret is forged or missing');
    }
    if (storedReservation.status === 'completed') return { status: 'duplicate', result: storedReservation.result };
    if (storedReservation.status === 'failed') return { status: 'rejected', reason: storedReservation.reason ?? 'reservation already failed' };
    if (Date.parse(storedReservation.lease_expires_at) <= Date.parse(at)) return fail('reservation lease is expired');
    const capability = state.capabilities.get(storedReservation.capability_id);
    if (!capability) return fail('reservation capability is missing');
    if (Date.parse(capability.expires_at) <= Date.parse(at)) return fail('capability is expired');
    appendInternal(this.store, {
      type: 'effect_committed',
      at,
      idempotency_key: `effect:${storedReservation.id}:${storedReservation.idempotency_key}`,
      operation_idempotency_key: storedReservation.idempotency_key,
      capability_id: capability.id,
      reservation_id: storedReservation.id,
      adapter_id: storedReservation.adapter_id,
      effect: storedReservation.effect,
      scope: storedReservation.scope,
      result: clone(result ?? { ok: true }),
    });
    return { status: 'committed', result: clone(result ?? { ok: true }) };
  }

  #failCapabilityReservation({ reservation, reason }) {
    this.#reapExpiredReservations();
    const state = this.store.state();
    const at = this.currentTime();
    assertObject(reservation, 'reservation');
    assertNonEmptyString(reservation.id, 'reservation.id');
    const storedReservation = state.reservations.get(reservation.id);
    if (!storedReservation) return this.#rejectReservationOperation(reservation.id, 'reservation is unknown');
    if (normalizeOptionalIdentity(reservation.adapter_id, 'reservation.adapter_id') !== storedReservation.adapter_id) {
      return this.#rejectReservationOperation(reservation.id, 'reservation adapter identity mismatch');
    }
    if (sha256(reservation.lease_secret ?? '') !== storedReservation.lease_secret_hash) {
      return this.#rejectReservationOperation(reservation.id, 'reservation lease secret is forged or missing');
    }
    if (storedReservation.status === 'completed') return { status: 'rejected', reason: 'reservation already completed' };
    if (storedReservation.status === 'failed') return { status: 'duplicate', reason: storedReservation.reason };
    appendInternal(this.store, {
      type: 'capability_reservation_failed',
      at,
      idempotency_key: `reservation-failed:${reservation.id}:${sha256(reason).slice(0, 10)}:${this.store.list().length + 1}`,
      reservation_id: reservation.id,
      reason,
    });
    return { status: 'failed', reason };
  }

  async executeCapability({ proposal, capability, adapter_id, signal } = {}) {
    const normalizedProposal = normalizeProposal(proposal);
    const normalizedAdapterId = normalizeIdentity(adapter_id, 'adapter_id');
    const adapter = this.adapters.get(normalizedAdapterId);
    if (!adapter) return { status: 'rejected', reason: `adapter ${normalizedAdapterId} is not registered` };
    if (!adapterAllows(adapter, normalizedProposal)) {
      return { status: 'rejected', reason: `adapter ${normalizedAdapterId} is not allowed for ${normalizedProposal.effect} ${normalizedProposal.scope}` };
    }
    const execute = ADAPTER_EXECUTORS.get(adapter);
    if (typeof execute !== 'function') {
      return { status: 'rejected', reason: `adapter ${normalizedAdapterId} has no private executor` };
    }
    if (!capability) return { status: 'rejected', reason: 'missing capability' };
    const reserved = this.#reserveCapability({
      capability,
      proposal_hash: proposalHash(normalizedProposal),
      effect: normalizedProposal.effect,
      scope: normalizedProposal.scope,
      idempotency_key: normalizedProposal.idempotency_key,
      adapter_id: normalizedAdapterId,
    });
    if (reserved.status !== 'reserved') return reserved;
    try {
      const result = await execute({
        proposal: clone(normalizedProposal),
        capability: {
          id: capability.id,
          contract_id: capability.contract_id,
          contract_hash: capability.contract_hash,
          proposal_hash: capability.proposal_hash,
          proposal_id: capability.proposal_id,
          verified_by: capability.verified_by,
          effect: capability.effect,
          scope: capability.scope,
          one_time: capability.one_time,
          expires_at: capability.expires_at,
          idempotency_key: capability.idempotency_key,
          authority: capability.authority,
          operator_dial: capability.operator_dial,
          contract_autonomy_ceiling: capability.contract_autonomy_ceiling,
          verdict_trust: capability.verdict_trust,
          verifier_trust_ceiling: capability.verifier_trust_ceiling,
        },
        signal,
      });
      return this.#completeCapabilityReservation({ reservation: reserved.reservation, result });
    } catch (error) {
      const failed = this.#failCapabilityReservation({
        reservation: reserved.reservation,
        reason: 'effect execution failed after authorization reservation',
      });
      return {
        status: 'ambiguous',
        ambiguous: true,
        reason: 'effect execution failed after authorization reservation',
        error: safeExecutorError(error),
        reservation_result: failed,
      };
    }
  }

  applyCapability(input = {}) {
    return this.executeCapability(input);
  }

  async runOnce() {
    const started = this.elapsedMs();
    const stateBefore = this.store.state();
    if (stateBefore.halted && !stateBefore.override_active) {
      return { status: 'halted', report: this.runtimeHealth().report, results: [] };
    }
    let contract = stateBefore.current_contract_id ? stateBefore.contracts.get(stateBefore.current_contract_id) : null;
    if (!contract) {
      this.proposeContract();
      contract = this.store.state().contracts.get(this.store.state().current_contract_id);
    }
    if (contract?.status !== 'ratified') {
      this.ratifyContract(contract.id);
    }

    const proposals = (await this.worker.propose({ goal: clone(this.goal), state: this.state(), health: this.runtimeHealth().health }))
      .map((proposal, index) => normalizeProposal(proposal, index));
    const results = [];
    for (const [index, proposal] of proposals.entries()) {
      if (this.elapsedMs() - started > this.budgets.wall_ms) {
        appendInternal(this.store, {
          type: 'proposal_quarantined',
          at: this.currentTime(),
          idempotency_key: `quarantine:${proposal.id}:wall:${this.store.list().length + 1}`,
          proposal_id: proposal.id,
          reason: 'wall-clock budget exhausted',
        });
        results.push({ proposal_id: proposal.id, status: 'quarantined' });
        continue;
      }
      if (index >= this.budgets.concurrency) {
        appendInternal(this.store, {
          type: 'proposal_deferred',
          at: this.currentTime(),
          idempotency_key: `deferred:${proposal.id}:${this.store.list().length + 1}`,
          proposal_id: proposal.id,
          reason: `concurrency budget ${this.budgets.concurrency} reached`,
        });
        results.push({ proposal_id: proposal.id, status: 'deferred', reason: `concurrency budget ${this.budgets.concurrency} reached` });
        continue;
      }
      appendInternal(this.store, {
        type: 'worker_proposed',
        at: this.currentTime(),
        idempotency_key: `proposal:${proposal.id}`,
        worker_id: normalizeIdentity(this.worker.id, 'worker.id'),
        proposal,
        proposal_hash: proposalHash(proposal),
      });
      if (proposal.type === 'escalation') {
        results.push({ proposal_id: proposal.id, status: 'escalated', reason: proposal.reason });
        continue;
      }
      if (this.store.state().quarantine.has(proposal.id)) {
        results.push({ proposal_id: proposal.id, status: 'quarantined' });
        continue;
      }
      const attempts = this.store.state().proposal_attempts.get(proposal.id) ?? 0;
      if (attempts >= this.budgets.attempts_per_proposal) {
        appendInternal(this.store, {
          type: 'proposal_quarantined',
          at: this.currentTime(),
          idempotency_key: `quarantine:${proposal.id}:attempts:${this.store.list().length + 1}`,
          proposal_id: proposal.id,
          reason: 'attempt budget exhausted',
        });
        results.push({ proposal_id: proposal.id, status: 'quarantined' });
        continue;
      }
      const adapter = [...this.adapters.values()].find((candidate) => adapterAllows(candidate, proposal));
      if (!adapter) {
        appendInternal(this.store, {
          type: 'effect_failed',
          at: this.currentTime(),
          idempotency_key: `effect-failed:${proposal.id}:missing-adapter:${this.store.list().length + 1}`,
          proposal_id: proposal.id,
          reason: `no adapter for ${proposal.effect} ${proposal.scope}`,
        });
        results.push({ proposal_id: proposal.id, status: 'failed', reason: 'missing adapter' });
        continue;
      }
      const verification = await this.recordProposalVerification(proposal, this.goal.proposal_verifier_id ?? null);
      if (!verification.ok) {
        results.push({ proposal_id: proposal.id, status: 'propose_only', reason: verification.reason });
        continue;
      }
      const issued = this.issueCapability(proposal);
      if (!issued.ok) {
        results.push({ proposal_id: proposal.id, status: 'propose_only', reason: issued.reason });
        continue;
      }
      try {
        const applied = await this.executeCapability({ proposal, capability: issued.capability, adapter_id: adapter.id });
        if (applied.status === 'ambiguous') {
          appendInternal(this.store, {
            type: 'effect_failed',
            at: this.currentTime(),
            idempotency_key: `effect-failed:${proposal.id}:ambiguous:${attempts + 1}:${this.store.list().length + 1}`,
            proposal_id: proposal.id,
            reason: applied.reason ?? 'effect execution ambiguous after authorization',
          });
          if ((this.store.state().proposal_attempts.get(proposal.id) ?? 0) >= this.budgets.attempts_per_proposal) {
            appendInternal(this.store, {
              type: 'proposal_quarantined',
              at: this.currentTime(),
              idempotency_key: `quarantine:${proposal.id}:adapter:${this.store.list().length + 1}`,
              proposal_id: proposal.id,
              reason: 'attempt budget exhausted',
            });
          }
        }
        results.push({ proposal_id: proposal.id, status: applied.status, result: applied.result });
      } catch (error) {
        appendInternal(this.store, {
          type: 'effect_failed',
          at: this.currentTime(),
          idempotency_key: `effect-failed:${proposal.id}:${attempts + 1}:${this.store.list().length + 1}`,
          proposal_id: proposal.id,
          reason: error.message,
        });
        if ((this.store.state().proposal_attempts.get(proposal.id) ?? 0) >= this.budgets.attempts_per_proposal) {
          appendInternal(this.store, {
            type: 'proposal_quarantined',
            at: this.currentTime(),
            idempotency_key: `quarantine:${proposal.id}:adapter:${this.store.list().length + 1}`,
            proposal_id: proposal.id,
            reason: 'attempt budget exhausted',
          });
        }
        results.push({ proposal_id: proposal.id, status: 'failed', reason: error.message });
      }
    }
    return { status: this.runtimeHealth().report.status, report: this.runtimeHealth().report, results };
  }
}

export const chaosFixtures = Object.freeze({
  duplicateInput: Object.freeze({ type: 'worker_proposed', idempotency_key: 'duplicate-key' }),
  reorderedInput: Object.freeze({ input_sequence: 3, expected_sequence: 1 }),
  forgedCapability: Object.freeze({ id: 'cap-forged', token: 'forged-token' }),
  expiredCapability: Object.freeze({ expires_at: '2026-08-05T00:00:00.000Z' }),
  wrongScopeCapability: Object.freeze({ requested_scope: 'workspace:other' }),
  adapterFailure: Object.freeze({ failTimes: 2 }),
});

export function createHarnessFromGoal(goal, options = {}) {
  const worker = proposalOnlyWorker({
    id: goal.proposed_by ?? goal.worker_id ?? 'worker',
    contract: goal.contract,
    proposals: goal.proposals ?? [],
  });
  const adapters = (goal.adapters ?? []).map((adapter) => createMemoryEffectAdapter(adapter));
  return new HarnessEngine({
    deployment_id: goal.deployment_id ?? 'frontier-harness',
    goal,
    worker,
    verifiers: goal.verifiers ?? [],
    adapters,
    budgets: goal.budgets ?? {},
    operator_dial: goal.operator_dial ?? 0,
    ...options,
  });
}
