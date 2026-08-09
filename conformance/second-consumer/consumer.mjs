import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HARNESS_KIT_VERSION,
  HarnessEngine,
  JsonlEventStore,
  createEffectAdapter,
  proposalOnlyWorker,
  sha256,
  stableStringify,
  validateEnvelopeChain,
  validateSemanticReplay,
} from '@frontier-infra/harness-kit';

const NOW = '2026-08-08T12:00:00.000Z';
const CONTRACT_EXPIRY = '2026-08-08T13:00:00.000Z';
const CAPABILITY_EXPIRY = '2026-08-08T12:01:00.000Z';
const EFFECT = 'local.synthetic-artifact.write.v1';
const SCOPE = 'local:frontier-second-consumer:artifact';
const TARGET = 'synthetic-artifact.json';
const ADAPTER_ID = 'local-synthetic-artifact';
const RECORD = Object.freeze({
  schema_version: 'frontier.second-consumer.fixture.v1',
  fixture_id: 'fixture-001',
  value: 'synthetic-only',
});
const RECORD_DIGEST = sha256(RECORD);

function proposal() {
  return {
    id: 'write-synthetic-artifact',
    type: 'effect',
    effect: EFFECT,
    scope: SCOPE,
    payload: {
      target: TARGET,
      record: RECORD,
      record_sha256: RECORD_DIGEST,
    },
    idempotency_key: 'second-consumer:fixture-001:write-once',
  };
}

function contract() {
  return {
    id: 'second-consumer-contract-v1',
    goal_id: 'second-consumer-goal-v1',
    proposed_by: 'second-consumer-worker',
    verifier_id: 'second-consumer-policy',
    scope: SCOPE,
    expires_at: CONTRACT_EXPIRY,
    autonomy_ceiling: 1,
    success_criteria: ['one exact synthetic artifact is committed'],
    effect_allowlist: [{ effect: EFFECT, scope: SCOPE }],
  };
}

function createPolicyVerifier() {
  return {
    id: 'second-consumer-policy',
    scopes: [SCOPE],
    trust_ceiling: 1,
    verify({ proposal: candidate, proposal_hash, contract: activeContract, contract_hash }) {
      const payload = candidate.payload;
      const allowed = candidate.effect === EFFECT
        && candidate.scope === SCOPE
        && candidate.idempotency_key === 'second-consumer:fixture-001:write-once'
        && activeContract.id === 'second-consumer-contract-v1'
        && payload?.target === TARGET
        && payload?.record_sha256 === RECORD_DIGEST
        && sha256(payload?.record) === RECORD_DIGEST;
      return {
        passed: allowed,
        trust: allowed ? 1 : 0,
        evidence_hash: sha256({
          policy: 'frontier.second-consumer.policy.v1',
          proposal_hash,
          contract_hash,
          record_sha256: payload?.record_sha256 ?? null,
          allowed,
        }),
        proposal_hash,
        contract_hash,
        produced_by: 'second-consumer-policy',
        reason: allowed ? undefined : 'proposal does not match the exact synthetic policy',
      };
    },
  };
}

function createLocalAdapter(effectRoot, calls) {
  return createEffectAdapter({
    id: ADAPTER_ID,
    effect: EFFECT,
    scopes: [SCOPE],
    execute({ proposal: authorizedProposal, capability }) {
      const payload = authorizedProposal.payload;
      assert.equal(capability.effect, EFFECT);
      assert.equal(capability.scope, SCOPE);
      assert.equal(capability.one_time, true);
      assert.equal(payload.target, TARGET);
      assert.equal(payload.record_sha256, RECORD_DIGEST);
      assert.equal(sha256(payload.record), RECORD_DIGEST);
      assert.equal(fs.readdirSync(effectRoot).length, 0);

      const targetPath = path.join(effectRoot, TARGET);
      fs.writeFileSync(targetPath, `${stableStringify(payload.record)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      calls.push({ target: TARGET, record_sha256: RECORD_DIGEST });
      return {
        target: TARGET,
        record_sha256: RECORD_DIGEST,
        bytes: fs.statSync(targetPath).size,
      };
    },
  });
}

function createFixture({ root, now = NOW } = {}) {
  const fixtureRoot = root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-second-consumer-effect.'));
  const effectRoot = path.join(fixtureRoot, 'effects');
  const stateRoot = path.join(fixtureRoot, 'state');
  fs.mkdirSync(effectRoot, { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });
  const eventPath = path.join(stateRoot, 'receipts.jsonl');
  const calls = [];
  const draft = proposal();
  const governingContract = contract();
  const worker = proposalOnlyWorker({
    id: 'second-consumer-worker',
    contract: governingContract,
    proposals: [draft],
  });
  const adapter = createLocalAdapter(effectRoot, calls);
  const harness = new HarnessEngine({
    deployment_id: 'second-consumer-local-proof',
    goal: {
      id: 'second-consumer-goal-v1',
      proposed_by: worker.id,
      verifier_id: 'second-consumer-policy',
      proposal_verifier_id: 'second-consumer-policy',
      contract: governingContract,
      proposals: [draft],
    },
    worker,
    verifiers: [createPolicyVerifier()],
    adapters: [adapter],
    store: new JsonlEventStore(eventPath),
    now,
    operator_dial: 1,
    budgets: { attempts_per_proposal: 1, wall_ms: 30_000, concurrency: 1 },
    tokenSource: () => 'second-consumer-local-token',
  });
  assert.equal('execute' in adapter, false, 'the executor must remain opaque to the consumer');
  return { harness, worker, adapter, calls, draft, effectRoot, eventPath };
}

async function authorize(fixture, expiresAt = CAPABILITY_EXPIRY) {
  const { harness, worker, draft } = fixture;
  const proposedContract = worker.proposeContract(harness.goal);
  harness.proposeContract(proposedContract);
  const ratified = harness.ratifyContract(proposedContract.id, 'second-consumer-policy', proposedContract);
  assert.equal(ratified.ok, true);
  const [workerProposal] = await worker.propose({
    goal: harness.goal,
    state: harness.state(),
    health: harness.runtimeHealth().health,
  });
  assert.deepEqual(workerProposal, draft);
  harness.store.append({
    type: 'worker_proposed',
    at: harness.currentTime(),
    idempotency_key: `proposal:${workerProposal.id}`,
    worker_id: worker.id,
    proposal: workerProposal,
  });
  const verified = await harness.recordProposalVerification(workerProposal, 'second-consumer-policy');
  assert.equal(verified.ok, true);
  const issued = harness.issueCapability(workerProposal, { expires_at: expiresAt });
  assert.equal(issued.ok, true);
  return { proposal: workerProposal, capability: issued.capability };
}

async function positiveAndReplayProof(root) {
  const fixture = createFixture({ root: path.join(root, 'positive') });
  const authorized = await authorize(fixture);
  const committed = await fixture.harness.executeCapability({
    ...authorized,
    adapter_id: ADAPTER_ID,
  });
  assert.equal(committed.status, 'committed');
  assert.equal(fixture.calls.length, 1);

  const targetPath = path.join(fixture.effectRoot, TARGET);
  assert.deepEqual(JSON.parse(fs.readFileSync(targetPath, 'utf8')), RECORD);
  assert.equal(fs.statSync(targetPath).mode & 0o777, 0o600);

  const replay = await fixture.harness.executeCapability({
    ...authorized,
    adapter_id: ADAPTER_ID,
  });
  assert.equal(replay.status, 'duplicate');
  assert.equal(fixture.calls.length, 1);

  const events = fixture.harness.store.list();
  assert.equal(validateEnvelopeChain(events), true);
  assert.equal(validateSemanticReplay(events), true);
  const eventTypes = events.map(({ event }) => event.type);
  for (const required of [
    'contract_proposed',
    'contract_ratified',
    'worker_proposed',
    'proposal_verified',
    'capability_issued',
    'capability_reserved',
    'effect_committed',
  ]) {
    assert.ok(eventTypes.includes(required), `missing receipt event ${required}`);
  }
  assert.equal(eventTypes.filter((type) => type === 'effect_committed').length, 1);
  assert.equal(fixture.harness.state().capabilities[authorized.capability.id].consumed, true);
  return {
    event_count: events.length,
    receipt_head_sha256: events.at(-1).receipt.receipt_hash,
    committed_result: committed.result,
    replay_status: replay.status,
  };
}

async function tamperProof(root) {
  const fixture = createFixture({ root: path.join(root, 'tamper') });
  const authorized = await authorize(fixture);
  const altered = structuredClone(authorized.proposal);
  altered.payload.record = { ...RECORD, value: 'altered' };
  const result = await fixture.harness.executeCapability({
    proposal: altered,
    capability: authorized.capability,
    adapter_id: ADAPTER_ID,
  });
  assert.equal(result.status, 'rejected');
  assert.match(result.reason, /proposal hash/);
  assert.equal(fixture.calls.length, 0);
  assert.deepEqual(fs.readdirSync(fixture.effectRoot), []);
  return result.status;
}

async function policyDenialProof(root) {
  const fixture = createFixture({ root: path.join(root, 'policy-denial') });
  const proposedContract = fixture.worker.proposeContract(fixture.harness.goal);
  fixture.harness.proposeContract(proposedContract);
  assert.equal(fixture.harness.ratifyContract(proposedContract.id).ok, true);
  const disallowed = structuredClone(fixture.draft);
  disallowed.payload.target = 'other-artifact.json';
  fixture.harness.store.append({
    type: 'worker_proposed',
    at: fixture.harness.currentTime(),
    idempotency_key: `proposal:${disallowed.id}`,
    worker_id: fixture.worker.id,
    proposal: disallowed,
  });
  const verification = await fixture.harness.recordProposalVerification(disallowed);
  assert.equal(verification.ok, false);
  assert.match(verification.reason, /exact synthetic policy/);
  const issuance = fixture.harness.issueCapability(disallowed);
  assert.equal(issuance.ok, false);
  assert.equal(fixture.calls.length, 0);
  assert.deepEqual(fs.readdirSync(fixture.effectRoot), []);
  return 'rejected';
}

async function expiryProof(root) {
  let clock = NOW;
  const fixture = createFixture({ root: path.join(root, 'expiry'), now: () => clock });
  const authorized = await authorize(fixture, '2026-08-08T12:00:01.000Z');
  clock = '2026-08-08T12:00:02.000Z';
  const result = await fixture.harness.executeCapability({ ...authorized, adapter_id: ADAPTER_ID });
  assert.equal(result.status, 'rejected');
  assert.match(result.reason, /expired/);
  assert.equal(fixture.calls.length, 0);
  return result.status;
}

async function haltProof(root) {
  const fixture = createFixture({ root: path.join(root, 'halt') });
  const authorized = await authorize(fixture);
  fixture.harness.halt('second-consumer adversarial proof');
  const result = await fixture.harness.executeCapability({ ...authorized, adapter_id: ADAPTER_ID });
  assert.equal(result.status, 'rejected');
  assert.match(result.reason, /runtime health/);
  assert.equal(fixture.calls.length, 0);
  return result.status;
}

const proofRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-second-consumer-proof.'));
try {
  for (const name of ['positive', 'policy-denial', 'tamper', 'expiry', 'halt']) {
    fs.mkdirSync(path.join(proofRoot, name), { recursive: true });
  }
  const positive = await positiveAndReplayProof(proofRoot);
  const proof = {
    schema_version: 'frontier.harness.second-consumer-proof.v1',
    evidence_class: 'local_offline_synthetic',
    harness_kit_version: HARNESS_KIT_VERSION,
    public_import: '@frontier-infra/harness-kit',
    effect: EFFECT,
    scope: SCOPE,
    target: TARGET,
    record_sha256: RECORD_DIGEST,
    positive,
    adversarial: {
      policy_mismatch: await policyDenialProof(proofRoot),
      proposal_tamper: await tamperProof(proofRoot),
      replay: positive.replay_status,
      expiry: await expiryProof(proofRoot),
      operator_halt: await haltProof(proofRoot),
    },
    external_effects: false,
    publication_performed: false,
  };
  process.stdout.write(`${JSON.stringify(proof)}\n`);
} finally {
  fs.rmSync(proofRoot, { recursive: true, force: true });
}
