import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  HarnessEngine,
  JsonlEventStore,
  MemoryEventStore,
  UNSIGNED_RECEIPT_LEVEL,
  UNSIGNED_RECEIPT_SIGNATURE,
  chaosFixtures,
  createEffectAdapter,
  createHarnessFromGoal,
  createMemoryEffectAdapter,
  proposalOnlyWorker,
  sha256,
} from '../src/index.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function happyGoal(overrides = {}) {
  return {
    id: 'goal-1',
    deployment_id: 'test-harness',
    proposed_by: 'worker-1',
    now: '2026-08-06T12:00:00.000Z',
    contract: {
      id: 'contract-1',
      goal_id: 'goal-1',
      proposed_by: 'worker-1',
      verifier_id: 'verifier-1',
      scope: 'workspace:alpha',
      expires_at: '2026-08-06T13:00:00.000Z',
      autonomy_ceiling: 1,
      success_criteria: ['effect committed'],
      effect_allowlist: [{ effect: 'memory.write', scope: 'workspace:alpha' }],
      ...(overrides.contract ?? {}),
    },
    verifiers: [{
      id: 'verifier-1',
      scopes: ['workspace:alpha'],
      trust_ceiling: 1,
      verify: async ({ proposal, proposal_hash, contract_hash }) => ({
        passed: proposal.payload?.ok === true,
        trust: 1,
        proposal_hash,
        contract_hash,
        observed_at: '2026-08-06T12:00:00.000Z',
        expires_at: '2026-08-06T12:01:00.000Z',
        evidence_hash: sha256({ expected_payload_ok: true, proposal_id: proposal.id }),
      }),
      ...(overrides.verifier ?? {}),
    }],
    proposals: [{
      id: 'write-1',
      type: 'effect',
      effect: 'memory.write',
      scope: 'workspace:alpha',
      payload: { ok: true },
      idempotency_key: 'write-1-once',
      ...(overrides.proposal ?? {}),
    }],
    adapters: [{ id: 'memory', effect: 'memory.write', scopes: ['workspace:alpha'], ...(overrides.adapter ?? {}) }],
    budgets: { attempts_per_proposal: 2, wall_ms: 30_000, concurrency: 1, ...(overrides.budgets ?? {}) },
    operator_dial: 1,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !['contract', 'verifier', 'proposal', 'adapter', 'budgets'].includes(key))),
  };
}

function harnessFrom(goal, options = {}) {
  const sink = options.sink ?? [];
  return {
    sink,
    harness: new HarnessEngine({
      deployment_id: goal.deployment_id,
      goal,
      worker: proposalOnlyWorker({ id: goal.proposed_by, contract: goal.contract, proposals: goal.proposals }),
      verifiers: goal.verifiers,
      adapters: options.adapters ?? [createMemoryEffectAdapter({ ...goal.adapters[0], sink, failTimes: options.failTimes ?? 0 })],
      budgets: goal.budgets,
      now: options.now ?? goal.now,
      store: options.store,
      operator_dial: options.operator_dial ?? goal.operator_dial ?? 0,
    }),
  };
}

function recordWorkerProposal(harness, goal, proposal = goal.proposals[0]) {
  const normalized = {
    type: 'effect',
    ...proposal,
  };
  harness.store.append({
    type: 'worker_proposed',
    at: harness.currentTime(),
    idempotency_key: `proposal:${normalized.id}`,
    worker_id: goal.proposed_by,
    proposal: normalized,
    proposal_hash: sha256({
      id: normalized.id,
      type: normalized.type,
      effect: normalized.effect,
      scope: normalized.scope,
      payload: normalized.payload ?? {},
      idempotency_key: normalized.idempotency_key,
    }),
  });
}

function forgedEnvelope(sequence, event, previousHash = null) {
  const normalizedEvent = {
    schema_version: 'frontier.harness.event.v1',
    at: event.at ?? '2026-08-06T12:00:00.000Z',
    ...event,
  };
  const eventHash = sha256({ sequence, event: normalizedEvent });
  const receiptCore = {
    schema_version: 'frontier.harness.receipt.v1',
    level: 'L3',
    signature: 'unsigned',
    previous_hash: previousHash,
    event_hash: eventHash,
    warning: 'Unsigned local L3 receipt only; this is not an AAR L4 signed receipt.',
  };
  return {
    schema_version: 'frontier.harness.event.v1',
    sequence,
    event: normalizedEvent,
    receipt: {
      ...receiptCore,
      receipt_hash: sha256(receiptCore),
    },
  };
}

test('happy path ratifies independently and commits only through an adapter capability', async () => {
  const goal = happyGoal();
  const { harness, sink } = harnessFrom(goal);
  const result = await harness.runOnce();

  assert.equal(result.status, 'pass');
  assert.equal(result.results[0].status, 'committed');
  assert.equal(sink.length, 1);
  const state = harness.state();
  assert.equal(state.contracts['contract-1'].status, 'ratified');
  assert.equal(state.contracts['contract-1'].ratified_by, 'verifier-1');
  assert.equal(state.effects['write-1-once'].adapter_id, 'memory');
  assert.equal(state.receipts.every((receipt) => receipt.level === UNSIGNED_RECEIPT_LEVEL), true);
  assert.equal(state.receipts.every((receipt) => receipt.signature === UNSIGNED_RECEIPT_SIGNATURE), true);
  assert.equal(state.receipts.some((receipt) => /not an AAR L4/.test(receipt.warning)), true);
});

test('proposal-only worker escalations do not mint capabilities or run effects', async () => {
  const goal = happyGoal({
    proposals: [{
      id: 'needs-human',
      type: 'escalation',
      reason: 'missing production credential',
      idempotency_key: 'escalation-once',
    }],
  });
  const { harness, sink } = harnessFrom(goal);
  const result = await harness.runOnce();

  assert.equal(result.status, 'pass');
  assert.deepEqual(result.results, [{ proposal_id: 'needs-human', status: 'escalated', reason: 'missing production credential' }]);
  assert.equal(sink.length, 0);
  assert.deepEqual(harness.state().capabilities, {});
});

test('missing verifier fails closed into propose-only health and blocks effects', async () => {
  const goal = happyGoal({ verifiers: [] });
  const { harness, sink } = harnessFrom(goal);
  const result = await harness.runOnce();

  assert.equal(result.status, 'propose_only');
  assert.equal(result.results[0].status, 'propose_only');
  assert.match(result.results[0].reason, /runtime health is propose_only|contract is not ratified/);
  assert.equal(sink.length, 0);
  assert.equal(harness.runtimeHealth().report.can_mutate, false);
});

test('duplicate and reordered inputs are deterministic events rather than mutations', () => {
  const store = new MemoryEventStore();
  const first = store.append({ type: 'worker_proposed', at: '2026-08-06T12:00:00.000Z', idempotency_key: 'dup', proposal: { id: 'p1' } }, { input_sequence: 1 });
  const duplicate = store.append({ type: 'worker_proposed', at: '2026-08-06T12:00:00.000Z', idempotency_key: 'dup', proposal: { id: 'p1' } }, { input_sequence: 2 });
  const reordered = store.append({ type: 'worker_proposed', at: '2026-08-06T12:00:00.000Z', idempotency_key: 'later', proposal: { id: 'p2' } }, { input_sequence: 4 });

  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.envelope.event.type, 'input_duplicate');
  assert.equal(reordered.rejected, true);
  assert.equal(reordered.envelope.event.type, 'input_rejected');
  const state = store.state();
  assert.deepEqual(state.duplicate_inputs, ['duplicate:dup:2']);
  assert.equal(state.rejected_inputs[0].sequence, 4);
});

test('duplicate sequenced input advances live and reload state equally', () => {
  const live = new MemoryEventStore();
  live.append({ type: 'worker_proposed', at: '2026-08-06T12:00:00.000Z', idempotency_key: 'seq-1', proposal: { id: 'p1' } }, { input_sequence: 1 });
  live.append({ type: 'worker_proposed', at: '2026-08-06T12:00:01.000Z', idempotency_key: 'seq-1', proposal: { id: 'p1' } }, { input_sequence: 2 });
  const third = live.append({ type: 'worker_proposed', at: '2026-08-06T12:00:02.000Z', idempotency_key: 'seq-3', proposal: { id: 'p3' } }, { input_sequence: 3 });
  const reloaded = new MemoryEventStore(live.list());

  assert.equal(third.rejected, false);
  assert.equal(third.envelope.sequence, 3);
  assert.deepEqual(live.state(), reloaded.state());
});

test('public event-store API rejects forged committed effects', () => {
  const store = new MemoryEventStore();
  assert.throws(() => store.append({
    type: 'effect_committed',
    at: '2026-08-06T12:00:00.000Z',
    idempotency_key: 'forged-effect',
    operation_idempotency_key: 'forged-effect',
    capability_id: 'cap-forged',
    reservation_id: 'res-forged',
    adapter_id: 'memory',
    effect: 'memory.write',
    scope: 'workspace:alpha',
    result: { forged: true },
  }), /public event store API/);
  assert.equal(store.state().effects.size, 0);
});

test('hash-valid forged lifecycle logs are rejected on semantic replay', () => {
  const forged = forgedEnvelope(1, {
    type: 'effect_committed',
    idempotency_key: 'effect:forged',
    operation_idempotency_key: 'forged-effect',
    capability_id: 'cap-forged',
    reservation_id: 'res-forged',
    adapter_id: 'memory',
    effect: 'memory.write',
    scope: 'workspace:alpha',
    result: { forged: true },
  });
  assert.throws(() => new MemoryEventStore([forged]), /active reservation/);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-harness-forged-log-'));
  const logPath = path.join(tmp, 'events.jsonl');
  fs.writeFileSync(logPath, `${JSON.stringify(forged)}\n`);
  assert.throws(() => new JsonlEventStore(logPath), /active reservation/);
});

test('self-ratification is rejected', async () => {
  const goal = happyGoal({
    contract: { verifier_id: 'worker-1' },
    verifiers: [{ id: 'worker-1', scopes: ['workspace:alpha'] }],
  });
  const { harness, sink } = harnessFrom(goal);
  const result = await harness.runOnce();

  assert.equal(result.status, 'propose_only');
  assert.equal(sink.length, 0);
  assert.equal(harness.state().contracts['contract-1'].status, 'rejected');
});

test('altered and expired contracts are rejected before mutation authority exists', () => {
  const altered = harnessFrom(happyGoal()).harness;
  const proposed = altered.proposeContract();
  const snapshot = structuredClone(proposed.contract);
  snapshot.scope = 'workspace:beta';
  const alteredResult = altered.ratifyContract('contract-1', 'verifier-1', snapshot);
  assert.equal(alteredResult.ok, false);
  assert.match(alteredResult.reason, /hash/);

  const expiredGoal = happyGoal({ contract: { expires_at: '2026-08-06T11:59:00.000Z' } });
  const expired = harnessFrom(expiredGoal).harness;
  expired.proposeContract();
  const expiredResult = expired.ratifyContract('contract-1');
  assert.equal(expiredResult.ok, false);
  assert.match(expiredResult.reason, /expired/);
});

test('stale, forged, replayed, and wrong-scope capabilities fail closed', async () => {
  const goal = happyGoal();
  const { harness } = harnessFrom(goal);
  harness.proposeContract();
  assert.equal(harness.ratifyContract('contract-1').ok, true);
  const proposal = goal.proposals[0];

  recordWorkerProposal(harness, goal, proposal);
  assert.equal((await harness.recordProposalVerification(proposal)).ok, true);
  const issued = harness.issueCapability(proposal);
  assert.equal(issued.ok, true);
  const forged = await harness.executeCapability({
    capability: { ...issued.capability, token: chaosFixtures.forgedCapability.token },
    adapter_id: 'memory',
    proposal,
  });
  assert.equal(forged.status, 'rejected');
  assert.match(forged.reason, /forged/);

  const wrongScope = await harness.executeCapability({
    capability: issued.capability,
    adapter_id: 'memory',
    proposal: { ...proposal, scope: 'workspace:beta' },
  });
  assert.equal(wrongScope.status, 'rejected');
  assert.match(wrongScope.reason, /scope|allowed/);

  const replayGoal = happyGoal();
  const replayHarness = harnessFrom(replayGoal).harness;
  replayHarness.proposeContract();
  assert.equal(replayHarness.ratifyContract('contract-1').ok, true);
  const replayProposal = replayGoal.proposals[0];
  recordWorkerProposal(replayHarness, replayGoal, replayProposal);
  assert.equal((await replayHarness.recordProposalVerification(replayProposal)).ok, true);
  const replayIssued = replayHarness.issueCapability(replayProposal);
  assert.equal(replayIssued.ok, true);
  const committed = await replayHarness.executeCapability({ proposal: replayProposal, capability: replayIssued.capability, adapter_id: 'memory' });
  assert.equal(committed.status, 'committed');
  const replay = await replayHarness.executeCapability({ proposal: replayProposal, capability: replayIssued.capability, adapter_id: 'memory' });
  assert.equal(replay.status, 'duplicate');

  const staleGoal = happyGoal({ proposal: { id: 'write-2', idempotency_key: 'write-2-once' } });
  const stale = harnessFrom(staleGoal, { now: staleGoal.now }).harness;
  stale.now = '2026-08-06T12:00:00.000Z';
  stale.proposeContract();
  assert.equal(stale.ratifyContract('contract-1').ok, true);
  recordWorkerProposal(stale, staleGoal);
  assert.equal((await stale.recordProposalVerification(staleGoal.proposals[0])).ok, true);
  const staleIssued = stale.issueCapability(staleGoal.proposals[0], { expires_at: '2026-08-06T12:00:01.000Z' });
  assert.equal(staleIssued.ok, true);
  stale.now = '2026-08-06T12:00:02.000Z';
  const staleConsumed = await stale.executeCapability({
    capability: staleIssued.capability,
    adapter_id: 'memory',
    proposal: staleGoal.proposals[0],
  });
  assert.equal(staleConsumed.status, 'rejected');
  assert.match(staleConsumed.reason, /expired/);
});

test('direct execution rechecks fail-closed runtime health after capability issuance', async () => {
  for (const [label, makeUnhealthy] of [
    ['halt', (harness) => harness.halt('post-issuance halt')],
    ['override', (harness) => harness.override('post-issuance override')],
  ]) {
    const goal = happyGoal();
    const { harness, sink } = harnessFrom(goal);
    harness.proposeContract();
    assert.equal(harness.ratifyContract('contract-1').ok, true);
    const proposal = goal.proposals[0];
    recordWorkerProposal(harness, goal, proposal);
    assert.equal((await harness.recordProposalVerification(proposal)).ok, true);
    const issued = harness.issueCapability(proposal);
    assert.equal(issued.ok, true);

    makeUnhealthy(harness);
    assert.equal(harness.runtimeHealth().report.can_mutate, false, label);
    const result = await harness.executeCapability({ proposal, capability: issued.capability, adapter_id: 'memory' });
    assert.equal(result.status, 'rejected', label);
    assert.match(result.reason, /runtime health/, label);
    assert.equal(sink.length, 0, label);
    const eventTypes = harness.store.list().map(({ event }) => event.type);
    assert.equal(eventTypes.includes('capability_reserved'), false, label);
    assert.equal(eventTypes.includes('effect_committed'), false, label);
  }
});

test('direct execution binds payload to the proposal hash stored for the capability', async () => {
  const goal = happyGoal();
  const { harness, sink } = harnessFrom(goal);
  harness.proposeContract();
  assert.equal(harness.ratifyContract('contract-1').ok, true);
  const proposal = goal.proposals[0];
  recordWorkerProposal(harness, goal, proposal);
  assert.equal((await harness.recordProposalVerification(proposal)).ok, true);
  const issued = harness.issueCapability(proposal);
  assert.equal(issued.ok, true);

  const altered = structuredClone(proposal);
  altered.payload = { ok: false };
  const alteredHash = sha256({
    id: altered.id,
    type: altered.type,
    effect: altered.effect,
    scope: altered.scope,
    payload: altered.payload,
    idempotency_key: altered.idempotency_key,
  });
  for (const capability of [issued.capability, { ...issued.capability, proposal_hash: alteredHash }]) {
    const rejected = await harness.executeCapability({ proposal: altered, capability, adapter_id: 'memory' });
    assert.equal(rejected.status, 'rejected');
    assert.match(rejected.reason, /proposal hash/);
  }
  assert.equal(sink.length, 0);
  assert.equal(harness.store.list().some(({ event }) => event.type === 'capability_reserved'), false);
  assert.equal(harness.store.list().some(({ event }) => event.type === 'effect_committed'), false);
  assert.equal(harness.state().capabilities[issued.capability.id].consumed, false);
});

test('capabilities require proposal verification and reject self or altered verification', async () => {
  const goal = happyGoal();
  const { harness } = harnessFrom(goal);
  harness.proposeContract();
  assert.equal(harness.ratifyContract('contract-1').ok, true);

  const direct = harness.issueCapability(goal.proposals[0]);
  assert.equal(direct.ok, false);
  assert.match(direct.reason, /recorded by worker_proposed/);

  const selfGoal = happyGoal({
    verifiers: [
      { id: 'verifier-1', scopes: ['workspace:alpha'], verify: async () => ({ passed: true, trust: 1, evidence_hash: 'ok' }) },
      { id: 'worker-1', scopes: ['workspace:alpha'], verify: async () => ({ passed: true, trust: 1, evidence_hash: 'echo' }) },
    ],
  });
  const self = harnessFrom(selfGoal).harness;
  self.proposeContract();
  assert.equal(self.ratifyContract('contract-1', 'verifier-1').ok, true);
  recordWorkerProposal(self, selfGoal);
  const selfVerified = await self.recordProposalVerification(selfGoal.proposals[0], 'worker-1');
  assert.equal(selfVerified.ok, false);
  assert.match(selfVerified.reason, /worker\/proposer/);

  const altered = harnessFrom(goal).harness;
  altered.proposeContract();
  assert.equal(altered.ratifyContract('contract-1').ok, true);
  recordWorkerProposal(altered, goal);
  assert.equal((await altered.recordProposalVerification(goal.proposals[0])).ok, true);
  const alteredProposal = structuredClone(goal.proposals[0]);
  alteredProposal.payload = { ok: false };
  const alteredIssued = altered.issueCapability(alteredProposal);
  assert.equal(alteredIssued.ok, false);
  assert.match(alteredIssued.reason, /recorded worker proposal hash mismatch|no recorded passing/);
});

test('secure tokens reject deterministic forging and unregistered adapter execution', async () => {
  const goal = happyGoal();
  const { harness } = harnessFrom(goal);
  harness.proposeContract();
  assert.equal(harness.ratifyContract('contract-1').ok, true);
  recordWorkerProposal(harness, goal);
  assert.equal((await harness.recordProposalVerification(goal.proposals[0])).ok, true);
  const issued = harness.issueCapability(goal.proposals[0]);
  assert.equal(issued.ok, true);

  const deterministicGuess = `tok_${sha256({
    id: issued.capability.id,
    proposal_id: goal.proposals[0].id,
    contract_hash: issued.capability.contract_hash,
    at: goal.now,
  }).slice(0, 32)}`;
  assert.notEqual(issued.capability.token, deterministicGuess);
  const forged = await harness.executeCapability({
    capability: { ...issued.capability, token: deterministicGuess },
    adapter_id: 'memory',
    proposal: goal.proposals[0],
  });
  assert.equal(forged.status, 'rejected');
  assert.match(forged.reason, /forged/);

  const unregistered = await harness.executeCapability({
    capability: issued.capability,
    adapter_id: 'not-registered',
    proposal: goal.proposals[0],
  });
  assert.equal(unregistered.status, 'rejected');
  assert.match(unregistered.reason, /not registered/);
});

test('governed execution rejects concurrent replay and allows idempotent completed duplicates', async () => {
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const goal = happyGoal();
  const sink = [];
  const blockingAdapter = createEffectAdapter({
    id: 'memory',
    effect: 'memory.write',
    scopes: ['workspace:alpha'],
    async execute({ proposal }) {
      await blocker;
      const result = { ok: true, adapter_id: 'memory', payload: proposal.payload };
      sink.push(result);
      return result;
    },
  });
  const { harness } = harnessFrom(goal, { adapters: [blockingAdapter], sink });
  harness.proposeContract();
  assert.equal(harness.ratifyContract('contract-1').ok, true);
  recordWorkerProposal(harness, goal);
  assert.equal((await harness.recordProposalVerification(goal.proposals[0])).ok, true);
  const issued = harness.issueCapability(goal.proposals[0]);
  assert.equal(issued.ok, true);

  const first = harness.executeCapability({ proposal: goal.proposals[0], capability: issued.capability, adapter_id: 'memory' });
  const concurrent = await harness.executeCapability({ proposal: goal.proposals[0], capability: issued.capability, adapter_id: 'memory' });
  assert.equal(concurrent.status, 'rejected');
  assert.match(concurrent.reason, /already reserved/);
  assert.equal(harness.state().effects['write-1-once'], undefined);
  release();

  const completed = await first;
  assert.equal(completed.status, 'committed');
  assert.equal(sink.length, 1);
  const duplicateConsume = await harness.executeCapability({ proposal: goal.proposals[0], capability: issued.capability, adapter_id: 'memory' });
  assert.equal(duplicateConsume.status, 'duplicate');
});

test('reservation lifecycle is not public and stores only lease-secret hashes', async () => {
  const goal = happyGoal();
  const { harness } = harnessFrom(goal);
  harness.proposeContract();
  assert.equal(harness.ratifyContract('contract-1').ok, true);
  recordWorkerProposal(harness, goal);
  assert.equal((await harness.recordProposalVerification(goal.proposals[0])).ok, true);
  const issued = harness.issueCapability(goal.proposals[0]);
  assert.equal(issued.ok, true);
  assert.equal(typeof harness.reserveCapability, 'undefined');
  assert.equal(typeof harness.completeCapabilityReservation, 'undefined');
  assert.equal(typeof harness.failCapabilityReservation, 'undefined');

  const committed = await harness.executeCapability({ proposal: goal.proposals[0], capability: issued.capability, adapter_id: 'memory' });
  assert.equal(committed.status, 'committed');
  const stored = Object.values(harness.state().reservations)[0];
  assert.equal(stored.lease_secret, undefined);
  assert.equal(typeof stored.lease_secret_hash, 'string');
});

test('connector failure marks ambiguous reservation without a false committed effect', async () => {
  const goal = happyGoal({ budgets: { attempts_per_proposal: 2 } });
  const { harness, sink } = harnessFrom(goal, { failTimes: 1 });
  const result = await harness.runOnce();
  const state = harness.state();

  assert.equal(result.results[0].status, 'ambiguous');
  assert.equal(sink.length, 0);
  assert.deepEqual(state.effects, {});
  assert.equal(Object.values(state.reservations).some((reservation) => reservation.status === 'failed'), true);
  assert.equal(harness.store.list().some((event) => event.event.type === 'effect_committed'), false);
  assert.equal(harness.store.list().some((event) => event.event.type === 'capability_reservation_failed'), true);
  assert.equal(harness.store.list().some((event) => event.event.type === 'effect_failed'), true);
});

test('ambiguous executor errors do not expose downstream secret messages or tokens', async () => {
  const secret = 'sk_live_executor_secret_token_123';
  const goal = happyGoal();
  const adapter = createEffectAdapter({
    id: 'secret-adapter',
    effect: 'memory.write',
    scopes: ['workspace:alpha'],
    execute: async () => {
      throw Object.assign(new Error(`downstream leaked ${secret}`), {
        name: `Custom${secret}`,
        code: secret,
      });
    },
  });
  const { harness } = harnessFrom(goal, { adapters: [adapter] });
  harness.proposeContract();
  assert.equal(harness.ratifyContract('contract-1').ok, true);
  recordWorkerProposal(harness, goal);
  assert.equal((await harness.recordProposalVerification(goal.proposals[0])).ok, true);
  const issued = harness.issueCapability(goal.proposals[0]);
  assert.equal(issued.ok, true);

  const result = await harness.executeCapability({
    proposal: goal.proposals[0],
    capability: issued.capability,
    adapter_id: 'secret-adapter',
  });
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(result.error, { name: 'Error' });
  assert.equal(result.reason, 'effect execution failed after authorization reservation');

  const serializedPublicSurfaces = JSON.stringify({
    result,
    events: harness.store.list(),
    receipts: harness.store.list().map((envelope) => envelope.receipt),
    state: harness.state(),
  });
  assert.doesNotMatch(serializedPublicSurfaces, new RegExp(secret));
  assert.doesNotMatch(serializedPublicSurfaces, new RegExp(issued.capability.token));
  assert.match(serializedPublicSurfaces, /effect execution failed after authorization reservation/);
  assert.equal(harness.store.list().some((event) => event.event.type === 'effect_committed'), false);
});

test('stale capabilities cannot execute and terminal reservations isolate retries', async () => {
  const goal = happyGoal();
  const { harness } = harnessFrom(goal, { now: goal.now });
  harness.now = '2026-08-06T12:00:00.000Z';
  harness.proposeContract();
  assert.equal(harness.ratifyContract('contract-1').ok, true);
  recordWorkerProposal(harness, goal);
  assert.equal((await harness.recordProposalVerification(goal.proposals[0])).ok, true);
  const issued = harness.issueCapability(goal.proposals[0], { expires_at: '2026-08-06T12:00:01.000Z' });
  assert.equal(issued.ok, true);
  harness.now = '2026-08-06T12:00:02.000Z';
  const completed = await harness.executeCapability({ proposal: goal.proposals[0], capability: issued.capability, adapter_id: 'memory' });
  assert.equal(completed.status, 'rejected');
  assert.match(completed.reason, /expired/);
  assert.deepEqual(harness.state().effects, {});
  assert.equal(harness.state().active_effects, 0);
  const reuse = await harness.executeCapability({ proposal: goal.proposals[0], capability: issued.capability, adapter_id: 'memory' });
  assert.equal(reuse.status, 'rejected');
});

test('effect authority requires the minimum of operator, contract, verdict, and verifier trust to be 1', async () => {
  const cases = [
    ['operator dial', { operator_dial: 0.5 }],
    ['contract ceiling', { contract: { autonomy_ceiling: 0.5 } }],
    ['verifier ceiling', { verifier: { trust_ceiling: 0.5 } }],
    ['verdict trust', { verifier: { verify: async ({ proposal_hash, contract_hash }) => ({
      passed: true,
      trust: 0.5,
      proposal_hash,
      contract_hash,
      observed_at: '2026-08-06T12:00:00.000Z',
      expires_at: '2026-08-06T12:01:00.000Z',
      evidence_hash: 'low-trust',
    }) } }],
  ];

  for (const [label, overrides] of cases) {
    const goal = happyGoal(overrides);
    const { harness } = harnessFrom(goal);
    harness.proposeContract();
    assert.equal(harness.ratifyContract('contract-1').ok, true, label);
    recordWorkerProposal(harness, goal);
    assert.equal((await harness.recordProposalVerification(goal.proposals[0])).ok, true, label);
    const issued = harness.issueCapability(goal.proposals[0]);
    assert.equal(issued.ok, false, label);
    assert.match(issued.reason, /below required 1/, label);
  }
});

test('operator dial changes are receipted and persisted', () => {
  const store = new MemoryEventStore();
  const goal = happyGoal({ operator_dial: 0 });
  const { harness } = harnessFrom(goal, { store });
  const changed = harness.setOperatorDial(1, 'approved live effect');

  assert.equal(changed.ok, true);
  assert.equal(harness.state().operator_dial, 1);
  const event = harness.store.list().at(-1).event;
  assert.equal(event.type, 'operator_dial_set');
  assert.equal(event.operator_dial, 1);
  assert.equal(event.previous_operator_dial, 0);
});

test('contract expiration is checked again during capability issuance', async () => {
  const goal = happyGoal({
    contract: { expires_at: '2026-08-06T12:00:10.000Z' },
    verifier: {
      verify: async ({ proposal_hash, contract_hash }) => ({
        passed: true,
        trust: 1,
        proposal_hash,
        contract_hash,
        evidence_hash: 'fresh-before-expiry',
        observed_at: '2026-08-06T12:00:00.000Z',
        expires_at: '2026-08-06T12:00:10.000Z',
      }),
    },
  });
  const { harness } = harnessFrom(goal, { now: goal.now });
  harness.now = '2026-08-06T12:00:00.000Z';
  harness.proposeContract();
  assert.equal(harness.ratifyContract('contract-1').ok, true);
  recordWorkerProposal(harness, goal);
  assert.equal((await harness.recordProposalVerification(goal.proposals[0])).ok, true);
  harness.now = '2026-08-06T12:00:11.000Z';
  const issued = harness.issueCapability(goal.proposals[0]);
  assert.equal(issued.ok, false);
  assert.match(issued.reason, /contract is expired/);
});

test('raw caller-supplied verdicts are rejected without verifier attestation validation', async () => {
  const goal = happyGoal({ verifier: { verify: null } });
  const { harness } = harnessFrom(goal);
  harness.proposeContract();
  assert.equal(harness.ratifyContract('contract-1').ok, true);
  recordWorkerProposal(harness, goal);
  const forgedVerdict = await harness.recordProposalVerification(goal.proposals[0], 'verifier-1', {
    verdict: {
      passed: true,
      trust: 1,
      evidence_hash: 'caller-says-so',
    },
  });
  assert.equal(forgedVerdict.ok, false);
  assert.match(forgedVerdict.reason, /cannot validate external/);
  assert.equal(harness.issueCapability(goal.proposals[0]).ok, false);
});

test('proposal verification requires exact recorded worker proposal before verifier or capability paths', async () => {
  const goal = happyGoal();
  const { harness } = harnessFrom(goal);
  harness.proposeContract();
  assert.equal(harness.ratifyContract('contract-1').ok, true);

  const bypassVerification = await harness.recordProposalVerification(goal.proposals[0]);
  assert.equal(bypassVerification.ok, false);
  assert.match(bypassVerification.reason, /recorded by worker_proposed/);

  recordWorkerProposal(harness, goal);
  const altered = structuredClone(goal.proposals[0]);
  altered.scope = 'workspace:alpha:child';
  const alteredVerification = await harness.recordProposalVerification(altered);
  assert.equal(alteredVerification.ok, false);
  assert.match(alteredVerification.reason, /hash mismatch|outside contract scope/);
});

test('verifier callback errors and invalid verdict windows persist rejection receipts', async () => {
  const badWindows = [
    ['future observed', {
      observed_at: '2026-08-06T12:00:01.000Z',
      expires_at: '2026-08-06T12:01:00.000Z',
    }, /future/],
    ['expired verdict', {
      observed_at: '2026-08-06T11:59:00.000Z',
      expires_at: '2026-08-06T12:00:00.000Z',
    }, /expired/],
    ['invalid observed', {
      observed_at: 'not-a-date',
      expires_at: '2026-08-06T12:01:00.000Z',
    }, /ISO timestamp/],
  ];

  for (const [label, window, pattern] of badWindows) {
    const goal = happyGoal({
      verifier: {
        verify: async ({ proposal_hash, contract_hash }) => ({
          passed: true,
          trust: 1,
          proposal_hash,
          contract_hash,
          evidence_hash: label,
          ...window,
        }),
      },
    });
    const { harness } = harnessFrom(goal);
    harness.proposeContract();
    assert.equal(harness.ratifyContract('contract-1').ok, true, label);
    recordWorkerProposal(harness, goal);
    const result = await harness.recordProposalVerification(goal.proposals[0]);
    assert.equal(result.ok, false, label);
    assert.match(result.reason, pattern, label);
    assert.equal(harness.store.list().at(-1).event.type, 'proposal_verification_rejected', label);
  }

  const throwingGoal = happyGoal({
    verifier: {
      verify: async () => {
        throw new Error('verifier offline');
      },
    },
  });
  const { harness } = harnessFrom(throwingGoal);
  harness.proposeContract();
  assert.equal(harness.ratifyContract('contract-1').ok, true);
  recordWorkerProposal(harness, throwingGoal);
  const thrown = await harness.recordProposalVerification(throwingGoal.proposals[0]);
  assert.equal(thrown.ok, false);
  assert.match(thrown.reason, /verifier offline/);
  assert.equal(harness.store.list().at(-1).event.type, 'proposal_verification_rejected');
});

test('durable reload rejects tampered events, receipts, and reordered sequence', async () => {
  const { harness } = harnessFrom(happyGoal());
  await harness.runOnce();
  const events = harness.store.list();

  const tamperedEvent = structuredClone(events);
  tamperedEvent.find((event) => event.event.type === 'contract_proposed').event.contract.scope = 'workspace:evil';
  assert.throws(() => new MemoryEventStore(tamperedEvent), /hash mismatch/);

  const tamperedReceipt = structuredClone(events);
  tamperedReceipt[1].receipt.previous_hash = '0'.repeat(64);
  assert.throws(() => new MemoryEventStore(tamperedReceipt), /previous_hash mismatch/);

  const reordered = structuredClone(events);
  reordered[1].sequence = 99;
  assert.throws(() => new MemoryEventStore(reordered), /sequence 99 should be 2/);
});

test('append-only JSONL persists opaque execution lifecycle and rejects partial lines', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-harness-log-'));
  const logPath = path.join(tmp, 'events.jsonl');
  const store = new JsonlEventStore(logPath);
  const goal = happyGoal();
  const { harness } = harnessFrom(goal, { store });
  harness.proposeContract();
  assert.equal(harness.ratifyContract('contract-1').ok, true);
  recordWorkerProposal(harness, goal);
  assert.equal((await harness.recordProposalVerification(goal.proposals[0])).ok, true);
  const issued = harness.issueCapability(goal.proposals[0]);
  assert.equal(issued.ok, true);
  const committed = await harness.executeCapability({ proposal: goal.proposals[0], capability: issued.capability, adapter_id: 'memory' });
  assert.equal(committed.status, 'committed');

  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.some((line) => line.includes('capability_reserved')), true);
  const reloaded = new JsonlEventStore(logPath);
  const reservation = [...reloaded.state().reservations.values()][0];
  assert.equal(reservation.status, 'completed');
  assert.equal(reservation.lease_secret, undefined);
  assert.equal(typeof reservation.lease_secret_hash, 'string');

  fs.appendFileSync(logPath, '{"partial":');
  assert.throws(() => new JsonlEventStore(logPath), /partial line/);
});

test('JSONL stale instances reload under lock so sequence numbers stay unique', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-harness-seq-'));
  const logPath = path.join(tmp, 'events.jsonl');
  const first = new JsonlEventStore(logPath);
  const stale = new JsonlEventStore(logPath);

  const firstAppend = first.append({ type: 'worker_proposed', at: '2026-08-06T12:00:00.000Z', idempotency_key: 'proposal-1', proposal: { id: 'p1' } });
  const secondAppend = stale.append({ type: 'worker_proposed', at: '2026-08-06T12:00:01.000Z', idempotency_key: 'proposal-2', proposal: { id: 'p2' } });

  assert.equal(firstAppend.envelope.sequence, 1);
  assert.equal(secondAppend.envelope.sequence, 2);
  const reloaded = new JsonlEventStore(logPath);
  assert.deepEqual(reloaded.list().map((event) => event.sequence), [1, 2]);
});

test('JSONL stale dead-pid locks are recovered for public input appends', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-harness-lock-'));
  const logPath = path.join(tmp, 'events.jsonl');
  const store = new JsonlEventStore(logPath, { lockStaleMs: 1, lockTimeoutMs: 500 });
  store.append({ type: 'worker_proposed', at: '2026-08-06T12:00:00.000Z', idempotency_key: 'before-stale-lock', proposal: { id: 'p1' } });
  assert.equal(new JsonlEventStore(logPath).list().length, 1);

  fs.writeFileSync(`${logPath}.lock`, JSON.stringify({
    pid: 999_999_999,
    created_at: '2000-01-01T00:00:00.000Z',
    created_ms: 1,
  }));
  const recovered = store.append({
    type: 'worker_proposed',
    at: '2026-08-06T12:00:01.000Z',
    idempotency_key: 'after-stale-lock',
    proposal: { id: 'p2' },
  });
  assert.equal(recovered.envelope.sequence, 2);
});

test('verifier identity without a verify port or worker echo cannot mint capability', async () => {
  const noPortGoal = happyGoal({ verifier: { verify: null } });
  const noPort = harnessFrom(noPortGoal).harness;
  noPort.proposeContract();
  assert.equal(noPort.ratifyContract('contract-1').ok, true);
  recordWorkerProposal(noPort, noPortGoal);
  const noPortVerification = await noPort.recordProposalVerification(noPortGoal.proposals[0]);
  assert.equal(noPortVerification.ok, false);
  assert.match(noPortVerification.reason, /did not provide/);
  assert.equal(noPort.issueCapability(noPortGoal.proposals[0]).ok, false);

  const echoGoal = happyGoal({
    verifier: {
      verify: async ({ proposal_hash, contract_hash }) => ({
        passed: true,
        trust: 1,
        proposal_hash,
        contract_hash,
        produced_by: 'worker-1',
        evidence_hash: 'worker-echo',
      }),
    },
  });
  const echo = harnessFrom(echoGoal).harness;
  echo.proposeContract();
  assert.equal(echo.ratifyContract('contract-1').ok, true);
  recordWorkerProposal(echo, echoGoal);
  const echoVerification = await echo.recordProposalVerification(echoGoal.proposals[0]);
  assert.equal(echoVerification.ok, false);
  assert.match(echoVerification.reason, /echoed/);
  assert.equal(echo.issueCapability(echoGoal.proposals[0]).ok, false);
});

test('concurrency defers excess proposals and monotonic wall budget quarantines late work', async () => {
  const twoProposalGoal = happyGoal({
    proposals: [
      happyGoal().proposals[0],
      {
        id: 'write-2',
        type: 'effect',
        effect: 'memory.write',
        scope: 'workspace:alpha',
        payload: { ok: true },
        idempotency_key: 'write-2-once',
      },
    ],
    budgets: { attempts_per_proposal: 2, wall_ms: 30_000, concurrency: 1 },
  });
  const { harness } = harnessFrom(twoProposalGoal);
  const result = await harness.runOnce();
  assert.deepEqual(result.results.map((entry) => entry.status), ['committed', 'deferred']);
  assert.equal(harness.state().deferred_proposals[0].proposal_id, 'write-2');

  const elapsed = [0, 100, 101];
  const wallGoal = happyGoal({ budgets: { attempts_per_proposal: 2, wall_ms: 50, concurrency: 1 } });
  const wall = harnessFrom(wallGoal, { now: wallGoal.now }).harness;
  wall.elapsedSource = () => elapsed.shift() ?? 101;
  const wallResult = await wall.runOnce();
  assert.equal(wallResult.results[0].status, 'quarantined');
  assert.equal(wall.state().quarantine.includes('write-1'), true);
});

test('halt blocks work and override remains visible in health', async () => {
  const goal = happyGoal();
  const { harness, sink } = harnessFrom(goal);
  harness.halt('operator halt');
  const halted = await harness.runOnce();
  assert.equal(halted.status, 'halted');
  assert.equal(sink.length, 0);

  harness.override('break-glass review');
  const report = harness.runtimeHealth().report;
  assert.equal(report.status, 'halted');
  assert.equal(report.can_mutate, false);
  assert.equal(report.halted.length > 0, true);
});

test('adapter retries quarantine a proposal after the attempt budget', async () => {
  const goal = happyGoal({ budgets: { attempts_per_proposal: 1 } });
  const { harness, sink } = harnessFrom(goal, { failTimes: 2 });
  const first = await harness.runOnce();
  const second = await harness.runOnce();

  assert.equal(first.results[0].status, 'ambiguous');
  assert.equal(second.results[0].status, 'quarantined');
  assert.equal(sink.length, 0);
  assert.equal(harness.state().quarantine.includes('write-1'), true);
  assert.equal(harness.runtimeHealth().report.status, 'blocked');
});

test('protocol health integrates governance gate failures', async () => {
  const goal = happyGoal({ proposal: { scope: 'workspace:beta' } });
  const { harness } = harnessFrom(goal);
  const result = await harness.runOnce();

  assert.equal(result.status, 'blocked');
  assert.equal(result.report.can_mutate, false);
  assert.equal(result.report.propose_only.length > 0 || result.report.blockers.length > 0, true);
});

test('receipt chain is hash-linked and unsigned L3 only', async () => {
  const { harness } = harnessFrom(happyGoal());
  await harness.runOnce();
  const receipts = harness.state().receipts;

  assert.equal(receipts.length >= 4, true);
  assert.equal(receipts[0].previous_hash, null);
  for (let i = 1; i < receipts.length; i += 1) {
    assert.equal(receipts[i].previous_hash, receipts[i - 1].receipt_hash);
    assert.equal(receipts[i].level, 'L3');
    assert.equal(receipts[i].signature, 'unsigned');
    assert.match(receipts[i].warning, /not an AAR L4 signed receipt/);
    assert.doesNotMatch(receipts[i].warning, /^AAR L4 signed receipt/);
  }
});

test('CLI runs a goal fixture once and persists JSONL events', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-harness-'));
  const goalPath = path.join(tmp, 'goal.json');
  const fixture = fs.readFileSync(path.join(packageRoot, 'fixtures/goal-happy.json'), 'utf8');
  fs.writeFileSync(goalPath, fixture);

  const output = execFileSync(process.execPath, [path.join(packageRoot, 'src/cli.mjs'), 'run', goalPath, '--once'], {
    encoding: 'utf8',
    cwd: packageRoot,
  });
  assert.match(output, /status propose_only/);
  const eventsPath = path.join(tmp, '.frontier-harness/events.jsonl');
  assert.equal(fs.existsSync(eventsPath), true);
  const events = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events.at(-1).receipt.level, 'L3');
  assert.equal(events.at(-1).receipt.signature, 'unsigned');
  assert.equal(events.some((event) => event.event.type === 'effect_committed'), false);
});
