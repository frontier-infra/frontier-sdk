import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HarnessEngine,
  MemoryEventStore,
  createEffectAdapter,
  createMemoryEffectAdapter,
  proposalOnlyWorker,
  sha256,
} from '../src/index.mjs';

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));

export function loadChaosCorpus() {
  return JSON.parse(fs.readFileSync(path.join(fixtureDirectory, 'chaos-corpus.v1.json'), 'utf8'));
}

export function loadLiveDeploymentChaosPlan() {
  return JSON.parse(fs.readFileSync(path.join(fixtureDirectory, 'live-deployment-chaos.v1.json'), 'utf8'));
}

function goal(overrides = {}) {
  const contract = {
    id: 'chaos-contract', goal_id: 'chaos-goal', proposed_by: 'worker-1', verifier_id: 'verifier-1',
    scope: 'workspace:alpha', expires_at: '2026-08-06T13:00:00.000Z', autonomy_ceiling: 1,
    effect_allowlist: [{ effect: 'memory.write', scope: 'workspace:alpha' }],
    ...(overrides.contract ?? {}),
  };
  const proposal = {
    id: 'chaos-write', type: 'effect', effect: 'memory.write', scope: 'workspace:alpha',
    payload: { ok: true }, idempotency_key: 'chaos-write-once', ...(overrides.proposal ?? {}),
  };
  const verifier = {
    id: 'verifier-1', scopes: ['workspace:alpha'], trust_ceiling: 1,
    verify: async ({ proposal_hash, contract_hash }) => ({
      passed: true, trust: 1, proposal_hash, contract_hash,
      evidence_hash: 'fixture-evidence', observed_at: '2026-08-06T12:00:00.000Z',
      expires_at: '2026-08-06T12:01:00.000Z',
    }),
    ...(overrides.verifier ?? {}),
  };
  return {
    id: 'chaos-goal', deployment_id: 'chaos-harness', proposed_by: 'worker-1',
    now: '2026-08-06T12:00:00.000Z', contract, proposals: [proposal], verifiers: [verifier],
    adapters: [{ id: 'memory', effect: 'memory.write', scopes: ['workspace:alpha'] }],
    budgets: { attempts_per_proposal: 2, wall_ms: 30_000, concurrency: 1 }, operator_dial: 1,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !['contract', 'proposal', 'verifier'].includes(key))),
  };
}

function makeHarness(inputGoal, options = {}) {
  const sink = [];
  const adapter = options.adapter ?? createMemoryEffectAdapter({ ...inputGoal.adapters[0], sink, failTimes: options.failTimes ?? 0 });
  const harness = new HarnessEngine({
    deployment_id: inputGoal.deployment_id,
    goal: inputGoal,
    worker: proposalOnlyWorker({ id: inputGoal.proposed_by, contract: inputGoal.contract, proposals: inputGoal.proposals }),
    verifiers: inputGoal.verifiers,
    adapters: [adapter], budgets: inputGoal.budgets, now: options.now ?? inputGoal.now,
    operator_dial: inputGoal.operator_dial, store: options.store,
  });
  return { harness, sink };
}

function proposalDigest(proposal) {
  return sha256({ id: proposal.id, type: proposal.type, effect: proposal.effect, scope: proposal.scope, payload: proposal.payload, idempotency_key: proposal.idempotency_key });
}

function recordProposal(harness, inputGoal) {
  const proposal = inputGoal.proposals[0];
  harness.store.append({
    type: 'worker_proposed', at: harness.currentTime(), idempotency_key: `proposal:${proposal.id}`,
    worker_id: inputGoal.proposed_by, proposal, proposal_hash: proposalDigest(proposal),
  });
}

async function authorize(inputGoal, options = {}) {
  const made = makeHarness(inputGoal, options);
  made.harness.proposeContract();
  const ratified = made.harness.ratifyContract(inputGoal.contract.id);
  if (!ratified.ok) throw new Error(`fixture setup could not ratify: ${ratified.reason}`);
  recordProposal(made.harness, inputGoal);
  const verified = await made.harness.recordProposalVerification(inputGoal.proposals[0]);
  if (!verified.ok) throw new Error(`fixture setup could not verify: ${verified.reason}`);
  const issued = made.harness.issueCapability(inputGoal.proposals[0], options.capabilityOptions);
  if (!issued.ok) throw new Error(`fixture setup could not issue: ${issued.reason}`);
  return { ...made, capability: issued.capability };
}

function events(harness) {
  return harness.store.list().map((entry) => entry.event.type);
}

function forgedEnvelope() {
  const event = {
    schema_version: 'frontier.harness.event.v1', at: '2026-08-06T12:00:00.000Z', type: 'effect_committed',
    idempotency_key: 'effect:forged', operation_idempotency_key: 'forged-effect', capability_id: 'cap-forged',
    reservation_id: 'res-forged', adapter_id: 'memory', effect: 'memory.write', scope: 'workspace:alpha', result: { forged: true },
  };
  const eventHash = sha256({ sequence: 1, event });
  const receiptCore = {
    schema_version: 'frontier.harness.receipt.v1', level: 'L3', signature: 'unsigned', previous_hash: null,
    event_hash: eventHash, warning: 'Unsigned local L3 receipt only; this is not an AAR L4 signed receipt.',
  };
  return { schema_version: 'frontier.harness.event.v1', sequence: 1, event, receipt: { ...receiptCore, receipt_hash: sha256(receiptCore) } };
}

const handlers = {
  async 'missing-verifier'() {
    const input = goal({ verifiers: [] });
    const { harness } = makeHarness(input);
    const run = await harness.runOnce();
    return { outcome: run.results[0].status, can_mutate: harness.runtimeHealth().report.can_mutate, events: events(harness) };
  },
  async 'inert-verifier'() {
    const input = goal({ verifier: { verify: null, verifyAttestation: null } });
    const { harness } = makeHarness(input);
    const run = await harness.runOnce();
    return { outcome: run.results[0].status, can_mutate: harness.runtimeHealth().report.can_mutate, events: events(harness) };
  },
  async 'self-ratification'() {
    const input = goal({ contract: { verifier_id: 'worker-1' }, verifiers: [{ id: 'worker-1', scopes: ['workspace:alpha'], trust_ceiling: 1 }] });
    const { harness } = makeHarness(input);
    const run = await harness.runOnce();
    return { outcome: run.results[0].status, can_mutate: harness.runtimeHealth().report.can_mutate, events: events(harness) };
  },
  async 'duplicate-input'() {
    const store = new MemoryEventStore();
    const first = { type: 'worker_proposed', at: '2026-08-06T12:00:00.000Z', idempotency_key: 'duplicate', proposal: { id: 'p1' } };
    store.append(first, { input_sequence: 1 });
    const result = store.append(first, { input_sequence: 2 });
    return { outcome: result.duplicate ? 'duplicate' : 'unexpected', events: store.list().map((entry) => entry.event.type) };
  },
  async 'reordered-input'() {
    const store = new MemoryEventStore();
    const result = store.append({ type: 'worker_proposed', at: '2026-08-06T12:00:00.000Z', idempotency_key: 'late', proposal: { id: 'p1' } }, { input_sequence: 3 });
    return { outcome: result.rejected ? 'rejected' : 'unexpected', events: store.list().map((entry) => entry.event.type) };
  },
  async 'forged-capability'() {
    const input = goal();
    const { harness, capability } = await authorize(input);
    const result = await harness.executeCapability({ proposal: input.proposals[0], capability: { ...capability, token: 'forged-token' }, adapter_id: 'memory' });
    return { outcome: result.status, reason: result.reason, events: events(harness) };
  },
  async 'expired-capability'() {
    const input = goal();
    const made = await authorize(input, { capabilityOptions: { expires_at: '2026-08-06T12:00:01.000Z' } });
    made.harness.now = '2026-08-06T12:00:02.000Z';
    const result = await made.harness.executeCapability({ proposal: input.proposals[0], capability: made.capability, adapter_id: 'memory' });
    return { outcome: result.status, reason: result.reason, events: events(made.harness) };
  },
  async 'wrong-scope-capability'() {
    const input = goal();
    const { harness, capability } = await authorize(input);
    const result = await harness.executeCapability({ proposal: { ...input.proposals[0], scope: 'workspace:other' }, capability, adapter_id: 'memory' });
    return { outcome: result.status, reason: result.reason, events: events(harness) };
  },
  async 'replayed-capability'() {
    const input = goal();
    const { harness, capability } = await authorize(input);
    await harness.executeCapability({ proposal: input.proposals[0], capability, adapter_id: 'memory' });
    const replay = await harness.executeCapability({ proposal: input.proposals[0], capability, adapter_id: 'memory' });
    return { outcome: replay.status, events: events(harness) };
  },
  async 'ambiguous-adapter-failure'() {
    const input = goal();
    const { harness } = makeHarness(input, { failTimes: 1 });
    const run = await harness.runOnce();
    return { outcome: run.results[0].status, events: events(harness) };
  },
  async 'retry-budget-quarantine'() {
    const input = goal({ budgets: { attempts_per_proposal: 1, wall_ms: 30_000, concurrency: 1 } });
    const { harness } = makeHarness(input, { failTimes: 1 });
    const run = await harness.runOnce();
    return { outcome: run.results[0].status, events: events(harness) };
  },
  async 'operator-halt'() {
    const input = goal();
    const { harness } = makeHarness(input);
    harness.halt('chaos fixture halt');
    const run = await harness.runOnce();
    return { outcome: run.status, can_mutate: harness.runtimeHealth().report.can_mutate, events: events(harness) };
  },
  async 'stale-reservation-restart'() {
    let release;
    const blocker = new Promise((resolve) => { release = resolve; });
    const input = goal();
    const adapter = createEffectAdapter({ id: 'memory', effect: 'memory.write', scopes: ['workspace:alpha'], execute: async () => { await blocker; return { ok: true }; } });
    const made = await authorize(input, { adapter });
    const pending = made.harness.executeCapability({ proposal: input.proposals[0], capability: made.capability, adapter_id: 'memory' });
    await Promise.resolve();
    const restartedStore = new MemoryEventStore(made.harness.store.list());
    release();
    await pending;
    const restarted = makeHarness(input, { store: restartedStore, now: '2026-08-06T12:00:31.000Z' }).harness;
    restarted.runtimeHealth();
    const activeEffects = restarted.state().active_effects;
    return { outcome: activeEffects === 0 ? 'reaped' : 'stale', active_effects: activeEffects, events: events(restarted) };
  },
  async 'tampered-lifecycle-log'() {
    try {
      new MemoryEventStore([forgedEnvelope()]);
      return { outcome: 'accepted', events: [] };
    } catch (error) {
      return { outcome: 'rejected_on_load', reason: error.message, events: [] };
    }
  },
};

function assess(fixture, actual) {
  const failures = [];
  const expected = fixture.expected;
  if (actual.outcome !== expected.outcome) failures.push(`outcome expected ${expected.outcome}, got ${actual.outcome}`);
  if ('can_mutate' in expected && actual.can_mutate !== expected.can_mutate) failures.push(`can_mutate expected ${expected.can_mutate}, got ${actual.can_mutate}`);
  if ('active_effects' in expected && actual.active_effects !== expected.active_effects) failures.push(`active_effects expected ${expected.active_effects}, got ${actual.active_effects}`);
  if (expected.reason_includes && !String(actual.reason ?? '').includes(expected.reason_includes)) failures.push(`reason does not include ${expected.reason_includes}`);
  if (expected.required_event && !actual.events.includes(expected.required_event)) failures.push(`missing event ${expected.required_event}`);
  if (expected.forbidden_event && actual.events.includes(expected.forbidden_event)) failures.push(`forbidden event ${expected.forbidden_event} was recorded`);
  if ('committed_event_count' in expected) {
    const count = actual.events.filter((event) => event === 'effect_committed').length;
    if (count !== expected.committed_event_count) failures.push(`effect_committed count expected ${expected.committed_event_count}, got ${count}`);
  }
  return failures;
}

export async function runChaosCorpus(corpus = loadChaosCorpus()) {
  const results = [];
  for (const fixture of corpus.fixtures) {
    const handler = handlers[fixture.id];
    if (!handler) {
      results.push({ id: fixture.id, status: 'NOT_RUN', failures: ['no runner registered'] });
      continue;
    }
    try {
      const actual = await handler();
      const failures = assess(fixture, actual);
      results.push({ id: fixture.id, status: failures.length ? 'FAIL' : 'PASS', actual, failures });
    } catch (error) {
      results.push({ id: fixture.id, status: 'FAIL', failures: [error.message] });
    }
  }
  return {
    schema_version: 'frontier.harness.chaos-report.v1', corpus_id: corpus.corpus_id,
    evidence_scope: corpus.evidence_scope, status: results.every((result) => result.status === 'PASS') ? 'PASS' : 'FAIL', results,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runChaosCorpus();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.status === 'PASS' ? 0 : 1;
}
