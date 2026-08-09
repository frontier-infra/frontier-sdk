import {
  RUNTIME_HEALTH_SCHEMA_VERSION,
  evaluateRuntimeHealth,
  runtimeHealthExitCode,
  type RuntimeHealthContract,
  type RuntimeHealthLayerName,
  type RuntimeHealthReport,
} from '@frontier-infra/protocol';
import {
  HarnessEngine,
  MemoryEventStore,
  createEffectAdapter,
  createHarnessFromGoal,
  createMemoryEffectAdapter,
  proposalOnlyWorker,
  type HarnessContract,
  type HarnessCapabilityExecutionResult,
  type HarnessGoal,
  type HarnessProposal,
  type HarnessRunOnceResult,
  type HarnessSerializableState,
  type HarnessVerifier,
  type NormalizedHarnessProposalForEffect,
} from '@frontier-infra/harness-kit';
import {
  createBrowserWorkerProposalPort,
  createGatedBusinessConnector,
  createOperationalAlertConnector,
  createPostgresStatePort,
  createRedisQueuePort,
  createS3ReceiptEvidenceSink,
  operationalAlertIdempotencyKey,
  type OperationalAlert,
  type PostgresStatePort,
  type ProposalPort,
  type RedisQueuePort,
} from '@frontier-infra/adapters';
import {
  ApprovalPanel,
  ContractCard,
  OverrideControl,
  ReceiptTimeline,
  RuntimeHealthPanel,
  type RuntimeHealthReport as GovernanceRuntimeHealthReport,
} from '@frontier-infra/governance-react';
import {
  TEMPLATE_MANIFEST,
  formatNextSteps,
  sanitizePackageName,
  type ScaffoldResult,
} from '@frontier-infra/create-frontier-app';
import {
  AUDIT_PACKAGE_VERSION,
  AUDIT_PACKET_SCHEMA_VERSION,
  runAudit,
  verifyAudit,
  type AuditRunOptions,
  type AuditRunResult,
  type AuditVerifyOptions,
  type AuditVerifyResult,
} from '@frontier-infra/audit';
import {
  loadChaosCorpus,
  loadLiveDeploymentChaosPlan,
  runChaosCorpus,
  type ChaosReport,
} from '@frontier-infra/harness-kit/chaos-fixtures';

const checkedAt = '2026-08-06T12:00:00.000Z';
const health: RuntimeHealthContract = {
  schema_version: RUNTIME_HEALTH_SCHEMA_VERSION,
  deployment_id: 'typed-consumer',
  checked_at: checkedAt,
  layers: Object.fromEntries(
    (['process', 'scheduler', 'execution', 'governance'] satisfies RuntimeHealthLayerName[]).map((layer) => [
      layer,
      {
        checks: [{
          id: `${layer}-ok`,
          status: 'pass',
          critical: true,
          observed_at: checkedAt,
          stale_after_seconds: 60,
          summary: `${layer} passes`,
        }],
      },
    ]),
  ) as RuntimeHealthContract['layers'],
};

const report: RuntimeHealthReport = evaluateRuntimeHealth(health);
const exitCode: 0 | 1 | 2 = runtimeHealthExitCode(report);
const processLayerStatus: 'pass' | 'degraded' | 'fail' | undefined = report.layers.process?.status;

const proposal: NormalizedHarnessProposalForEffect = {
  id: 'typed-proposal',
  type: 'effect',
  effect: 'memory.write',
  scope: 'workspace:typed',
  payload: { ok: true },
  idempotency_key: 'typed-proposal-once',
};

const contract: HarnessContract = {
  id: 'typed-contract',
  goal_id: 'typed-goal',
  proposed_by: 'worker-1',
  verifier_id: 'verifier-1',
  scope: 'workspace:typed',
  expires_at: '2026-08-06T13:00:00.000Z',
  autonomy_ceiling: 1,
  success_criteria: [],
  effect_allowlist: [{ effect: 'memory.write', scope: 'workspace:typed' }],
};

const goal: HarnessGoal = {
  id: 'typed-goal',
  deployment_id: 'typed-harness',
  proposed_by: 'worker-1',
  verifier_id: 'verifier-1',
  scope: 'workspace:typed',
  expires_at: '2026-08-06T13:00:00.000Z',
  operator_dial: 1,
  contract,
  proposals: [proposal],
  verifiers: [],
  adapters: [{ id: 'memory', effect: 'memory.write', scopes: ['workspace:typed'] }],
};

const verifier: HarnessVerifier = {
  id: 'verifier-1',
  scopes: ['workspace:typed'],
  active: true,
  trust_ceiling: 1,
  verify({ proposal: verifiedProposal, state, contract_hash }) {
    const typedState: HarnessSerializableState = state;
    const effect: string = verifiedProposal.effect;
    return {
      passed: effect === 'memory.write' && typedState.sequence >= 0,
      trust: 1,
      contract_hash,
      evidence_hash: 'typed-evidence',
      observed_at: checkedAt,
      expires_at: '2026-08-06T12:01:00.000Z',
      produced_by: 'verifier-1',
    };
  },
};

const memorySink: unknown[] = [];
const memoryAdapter = createMemoryEffectAdapter({ id: 'memory', effect: 'memory.write', scopes: ['workspace:typed'], sink: memorySink });
const customAdapter = createEffectAdapter({
  id: 'custom-memory',
  effect: 'memory.write',
  scopes: ['workspace:typed'],
  execute({ proposal: normalizedProposal, capability }) {
    return { proposal_id: normalizedProposal.id, capability_id: capability.id };
  },
});

const harness = new HarnessEngine({
  deployment_id: 'typed-harness',
  goal,
  worker: proposalOnlyWorker({ id: 'worker-1', contract, proposals: [proposal] }),
  verifiers: [verifier],
  adapters: [memoryAdapter, customAdapter],
  store: new MemoryEventStore(),
  now: checkedAt,
  operator_dial: 1,
});
const harnessHealth = harness.runtimeHealth([{ layer: 'execution', reason_code: 'governance_gate_failed', summary: 'typed issue' }]);
const harnessState: HarnessSerializableState = harness.state();
const runOncePromise: Promise<HarnessRunOnceResult> = harness.runOnce();
const executionPromise: Promise<HarnessCapabilityExecutionResult> = harness.executeCapability({
  capability: {
    id: 'cap-typed',
    token: 'tok_typed',
    token_hash: 'hash',
    contract_id: 'typed-contract',
    contract_hash: 'contract-hash',
    proposal_hash: 'proposal-hash',
    proposal_id: proposal.id,
    verified_by: 'verifier-1',
    effect: proposal.effect,
    scope: proposal.scope,
    one_time: true,
    expires_at: '2026-08-06T12:01:00.000Z',
    idempotency_key: proposal.idempotency_key,
    authority: 1,
    operator_dial: 1,
    contract_autonomy_ceiling: 1,
    verdict_trust: 1,
    verifier_trust_ceiling: 1,
  },
  adapter_id: 'memory',
  proposal,
});

const escalation: HarnessProposal = {
  id: 'typed-escalation',
  type: 'escalation',
  reason: 'human review required',
  summary: 'effect APIs must not accept escalation proposals',
  idempotency_key: 'typed-escalation-once',
};
// @ts-expect-error Effect-only verification must reject escalation proposals at compile time.
void harness.recordProposalVerification(escalation);
// @ts-expect-error Effect-only issuance must reject escalation proposals at compile time.
void harness.issueCapability(escalation);

const createdHarness = createHarnessFromGoal(goal);
const createdState: HarnessSerializableState = createdHarness.state();

const browserPort: ProposalPort = createBrowserWorkerProposalPort({
  request() {
    return { proposals: [proposal] };
  },
});
const alertKey = operationalAlertIdempotencyKey({
  scope: 'ops:oncall',
  payload: { severity: 'critical', message: 'typed alert', context: { deployment: 'typed' } },
});
const alert: OperationalAlert = { severity: 'critical', message: 'typed alert', context: { alertKey } };
const businessAdapter = createGatedBusinessConnector({
  effect: 'memory.write',
  scopes: ['workspace:typed'],
  execute({ proposal: gatedProposal, capability }) {
    return { effect: gatedProposal.effect, capability: capability.id };
  },
});
const alertAdapter = createOperationalAlertConnector({
  deliver({ alert: deliveredAlert, idempotency_key }) {
    return { severity: deliveredAlert.severity, idempotency_key };
  },
});
const postgres: PostgresStatePort = createPostgresStatePort({
  client: {
    async query(input) {
      const values: unknown[] = input.values;
      return { rows: [{ state: values[0], version: 1 }] };
    },
  },
});
const redis: RedisQueuePort = createRedisQueuePort({
  client: {
    async sendCommand(command, args) {
      return command === 'SET' || args.length > 0 ? 'OK' : 0;
    },
  },
});
const evidenceSink = createS3ReceiptEvidenceSink({
  bucket: 'typed-bucket',
  client: {
    async putObject(input) {
      return input;
    },
  },
});

const contractElement = <ContractCard contract={contract} />;
const approvalElement = <ApprovalPanel proposal={proposal} approvals={[{ actor: 'verifier-1', status: 'approved' }]} />;
const receiptElement = <ReceiptTimeline receipts={[{ id: 'receipt-1', receipt_hash: 'hash', status: 'pass' }]} />;
const governanceReport: GovernanceRuntimeHealthReport = harnessHealth.report;
const healthElement = <RuntimeHealthPanel report={governanceReport} />;
const overrideElement = <OverrideControl acknowledgement onAcknowledgementChange={(checked: boolean) => checked} />;

const manifest: readonly string[] = TEMPLATE_MANIFEST;
const scaffoldResult: ScaffoldResult = {
  targetDir: '/tmp/frontier-typed',
  projectName: sanitizePackageName('Frontier Typed'),
  files: [...manifest],
};
const nextSteps: string = formatNextSteps(scaffoldResult);

const auditVersion: string = AUDIT_PACKAGE_VERSION;
const auditSchema: 'frontier.audit.packet.v1' = AUDIT_PACKET_SCHEMA_VERSION;
const auditRunner: (options?: AuditRunOptions) => AuditRunResult = runAudit;
const auditVerifier: (options: AuditVerifyOptions) => AuditVerifyResult = verifyAudit;

const chaosReportPromise: Promise<ChaosReport> = runChaosCorpus(loadChaosCorpus());
const liveChaosPlan = loadLiveDeploymentChaosPlan();

void [
  alert,
  alertAdapter,
  auditRunner,
  auditSchema,
  auditVerifier,
  auditVersion,
  browserPort,
  businessAdapter,
  contractElement,
  createdState,
  evidenceSink,
  executionPromise,
  exitCode,
  governanceReport,
  harnessState,
  healthElement,
  liveChaosPlan,
  nextSteps,
  overrideElement,
  postgres,
  processLayerStatus,
  redis,
  receiptElement,
  report,
  runOncePromise,
  approvalElement,
  chaosReportPromise,
];
