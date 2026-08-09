import type { RuntimeHealthContract, RuntimeHealthReport } from '@frontier-infra/protocol';

export type HarnessReceiptLevel = 'L3';
export type HarnessReceiptSignature = 'unsigned';
export type HarnessProposalType = 'effect' | 'escalation';
export type HarnessContractStatus = 'proposed' | 'ratified' | 'rejected';
export type HarnessReservationStatus = 'active' | 'completed' | 'failed';
export type HarnessCapabilityExecutionStatus = 'committed' | 'duplicate' | 'rejected' | 'ambiguous';
export type HarnessRunResultStatus = HarnessCapabilityExecutionStatus | 'quarantined' | 'deferred' | 'escalated' | 'failed' | 'propose_only';

export interface HarnessGoal {
  id: string;
  deployment_id?: string;
  proposed_by?: string;
  worker_id?: string;
  verifier_id?: string;
  proposal_verifier_id?: string;
  scope?: string;
  expires_at?: string;
  now?: string;
  contract?: Partial<HarnessContract> & { id: string };
  proposals?: HarnessProposal[];
  verifiers?: HarnessVerifier[];
  adapters?: MemoryEffectAdapterOptions[];
  budgets?: Partial<HarnessBudgets>;
  operator_dial?: number;
  [key: string]: unknown;
}

export interface HarnessContract {
  id: string;
  goal_id: string;
  proposed_by: string;
  verifier_id: string;
  scope: string;
  expires_at: string;
  autonomy_ceiling: number;
  success_criteria: unknown[];
  effect_allowlist: Array<{ effect: string; scope?: string }>;
}

export interface HarnessVerifier {
  id: string;
  scopes?: string[];
  active?: boolean;
  trust_ceiling?: number;
  verify?: (context: ProposalVerificationContext) => Promise<ProposalVerificationVerdict> | ProposalVerificationVerdict;
  verifyAttestation?: (verdict: unknown, context: ProposalVerificationContext) => Promise<ProposalVerificationVerdict> | ProposalVerificationVerdict;
}

export interface ProposalVerificationContext {
  proposal: NormalizedHarnessProposalForEffect;
  proposal_hash: string;
  contract: HarnessContract;
  contract_hash: string;
  goal: HarnessGoal;
  state: HarnessSerializableState;
}

export interface ProposalVerificationVerdict {
  passed: boolean;
  trust: number;
  evidence_hash?: string;
  evidence_refs?: string[];
  proposal_hash?: string;
  contract_hash?: string;
  observed_at?: string;
  expires_at?: string;
  produced_by?: string;
  reason?: string;
}

export interface HarnessBudgets {
  attempts_per_proposal: number;
  wall_ms: number;
  concurrency: number;
}

export interface HarnessProposal {
  id?: string;
  type?: HarnessProposalType;
  effect?: string;
  scope?: string;
  payload?: unknown;
  reason?: string;
  summary?: string;
  idempotency_key?: string;
}

/** Input accepted by effect-only verification, capability, and execution APIs. */
export interface HarnessEffectProposalInput extends HarnessProposal {
  type?: 'effect';
  effect: string;
  scope: string;
  payload: unknown;
  idempotency_key: string;
}

export interface NormalizedHarnessEffectProposal {
  id: string;
  type: 'effect';
  effect: string;
  scope: string;
  payload: unknown;
  idempotency_key: string;
}

export interface NormalizedHarnessEscalationProposal {
  id: string;
  type: 'escalation';
  reason: string;
  summary: string;
  idempotency_key: string;
}

export type NormalizedHarnessProposal = NormalizedHarnessEffectProposal | NormalizedHarnessEscalationProposal;
export type NormalizedHarnessProposalForEffect = NormalizedHarnessEffectProposal;

export interface HarnessCapability {
  id: string;
  token: string;
  token_hash: string;
  contract_id: string;
  contract_hash: string;
  proposal_hash: string;
  proposal_id: string;
  verified_by: string;
  effect: string;
  scope: string;
  one_time: boolean;
  expires_at: string;
  idempotency_key: string;
  authority: number;
  operator_dial: number;
  contract_autonomy_ceiling: number;
  verdict_trust: number;
  verifier_trust_ceiling: number;
}

export interface HarnessReservation {
  id: string;
  capability_id: string;
  proposal_id?: string;
  adapter_id: string;
  effect: string;
  scope: string;
  idempotency_key: string;
  lease_expires_at: string;
  lease_secret?: string;
  lease_secret_hash?: string;
}

export interface HarnessReceipt {
  schema_version: string;
  level: HarnessReceiptLevel;
  signature: HarnessReceiptSignature;
  previous_hash: string | null;
  event_hash: string;
  receipt_hash: string;
  warning: string;
}

export interface HarnessEventEnvelope {
  schema_version: string;
  sequence: number;
  input_sequence?: number;
  event: Record<string, unknown>;
  receipt: HarnessReceipt;
}

export interface MemoryEffectAdapterOptions {
  id?: string;
  effect: string;
  scopes?: string[];
  failTimes?: number;
  sink?: unknown[];
}

export interface HarnessWorker {
  id: string;
  proposeContract?: (goal: HarnessGoal) => HarnessContract | null;
  propose: (input: { goal: HarnessGoal; state: HarnessSerializableState; health: RuntimeHealthContract }) => Promise<HarnessProposal[]> | HarnessProposal[];
}

export interface HarnessAdapter {
  id: string;
  effect: string;
  scopes?: string[];
}

export interface HarnessContractState extends HarnessContract {
  status: HarnessContractStatus;
  hash: string;
  proposed_at: string;
  ratified_by: string | null;
  ratified_at?: string;
}

export type HarnessRecordedProposal = NormalizedHarnessProposal & {
  proposal_hash: string;
  worker_id: string;
  at: string;
};

export interface HarnessStoredCapability extends Omit<HarnessCapability, 'token'> {
  token?: undefined;
  consumed: boolean;
  reserved_by: string | null;
  failed: boolean;
}

export interface HarnessStoredReservation extends Omit<HarnessReservation, 'lease_secret'> {
  lease_secret?: undefined;
  lease_secret_hash: string;
  status: HarnessReservationStatus;
  failed_at?: string;
  completed_at?: string;
  reason?: string;
  result?: unknown;
}

export interface HarnessProposalVerificationRecord {
  proposal_id: string;
  proposal_hash: string;
  contract_hash: string;
  scope: string;
  effect: string;
  verifier_id: string;
  trust: number;
  observed_at: string;
  expires_at: string;
  status: 'pass';
}

export interface HarnessConsumedCapabilityRecord {
  idempotency_key: string;
  effect: string;
  scope: string;
  result: unknown;
  reservation_id: string;
}

export interface HarnessDeferredProposal {
  proposal_id: string;
  reason: string;
}

export interface HarnessHealthIssue {
  layer?: 'process' | 'scheduler' | 'execution' | 'governance';
  reason_code?: string;
  summary?: string;
  reason?: string;
  [key: string]: unknown;
}

export interface HarnessRejectedInput {
  reason: string;
  sequence?: number;
}

export interface HarnessRuntimeState {
  sequence: number;
  receipts: HarnessReceipt[];
  contracts: Map<string, HarnessContractState>;
  current_contract_id: string | null;
  contract_hash: string | null;
  proposals: Map<string, HarnessRecordedProposal>;
  capabilities: Map<string, HarnessStoredCapability>;
  reservations: Map<string, HarnessStoredReservation>;
  consumed_capabilities: Map<string, HarnessConsumedCapabilityRecord>;
  effects: Map<string, unknown>;
  proposal_verifications: Map<string, HarnessProposalVerificationRecord>;
  proposal_attempts: Map<string, number>;
  deferred_proposals: HarnessDeferredProposal[];
  quarantine: Set<string>;
  halted: boolean;
  halt_reason: string | null;
  override_active: boolean;
  override_reason: string | null;
  operator_dial: number;
  health_issues: HarnessHealthIssue[];
  duplicate_inputs: string[];
  rejected_inputs: HarnessRejectedInput[];
  active_effects: number;
}

export interface HarnessSerializableState {
  sequence: number;
  receipts: HarnessReceipt[];
  contracts: Record<string, HarnessContractState>;
  current_contract_id: string | null;
  contract_hash: string | null;
  proposals: Record<string, HarnessRecordedProposal>;
  capabilities: Record<string, HarnessStoredCapability>;
  reservations: Record<string, HarnessStoredReservation>;
  consumed_capabilities: Record<string, HarnessConsumedCapabilityRecord>;
  effects: Record<string, unknown>;
  proposal_verifications: Record<string, HarnessProposalVerificationRecord>;
  proposal_attempts: Record<string, number>;
  deferred_proposals: HarnessDeferredProposal[];
  quarantine: string[];
  halted: boolean;
  halt_reason: string | null;
  override_active: boolean;
  override_reason: string | null;
  operator_dial: number;
  health_issues: HarnessHealthIssue[];
  duplicate_inputs: string[];
  rejected_inputs: HarnessRejectedInput[];
  active_effects: number;
}

export interface HarnessRuntimeHealthResult {
  health: RuntimeHealthContract;
  report: RuntimeHealthReport;
}

export type HarnessCapabilityExecutionResult =
  | { status: 'committed'; result: unknown }
  | { status: 'duplicate'; result?: unknown }
  | { status: 'rejected'; reason: string }
  | {
      status: 'ambiguous';
      ambiguous: true;
      reason: string;
      error: { name: string; code?: string };
      reservation_result: { status: string; reason?: string; result?: unknown };
    };

export interface HarnessProposalRunResult {
  proposal_id: string;
  status: HarnessRunResultStatus;
  reason?: string;
  result?: unknown;
}

export interface HarnessRunOnceResult {
  status: RuntimeHealthReport['status'];
  report: RuntimeHealthReport;
  results: HarnessProposalRunResult[];
}

export class HarnessError extends Error {
  code: string;
  details: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>);
}

export class MemoryEventStore {
  constructor(events?: HarnessEventEnvelope[]);
  list(): HarnessEventEnvelope[];
  state(): HarnessRuntimeState;
  lastReceiptHash(): string | null;
  append(event: Record<string, unknown>, options?: { input_sequence?: number }): {
    duplicate?: boolean;
    rejected?: boolean;
    envelope: HarnessEventEnvelope;
  };
}

export interface JsonlEventStoreOptions {
  lockPath?: string;
  lockTimeoutMs?: number;
  lockStaleMs?: number;
}

export class JsonlEventStore extends MemoryEventStore {
  filePath: string;
  lockPath: string;
  lockTimeoutMs: number;
  lockStaleMs: number;
  constructor(filePath: string, options?: JsonlEventStoreOptions);
}

export class VerifierRegistry {
  constructor(verifiers?: HarnessVerifier[]);
  register(verifier: HarnessVerifier): HarnessVerifier;
  get(id: string): HarnessVerifier | null;
  canRatify(contract: HarnessContract, verifierId: string): { ok: true; verifier: HarnessVerifier } | { ok: false; reason_code: string; reason: string };
}

export class HarnessEngine {
  constructor(options: {
    deployment_id?: string;
    goal: HarnessGoal;
    worker?: HarnessWorker;
    verifiers?: HarnessVerifier[] | VerifierRegistry;
    adapters?: HarnessAdapter[];
    budgets?: Partial<HarnessBudgets>;
    store?: MemoryEventStore;
    now?: string | Date | (() => string | Date);
    operator_dial?: number;
    tokenSource?: () => string;
    elapsedSource?: () => number;
  });
  deployment_id: string;
  goal: HarnessGoal;
  store: MemoryEventStore;
  currentTime(): string;
  elapsedMs(): number;
  state(): HarnessSerializableState;
  setOperatorDial(operatorDial: number, reason?: string): { ok: true; operator_dial: number };
  proposeContract(contract?: HarnessContract | null): { contract: HarnessContract; contract_hash: string };
  ratifyContract(contractId?: string, verifierId?: string | null, contractSnapshot?: HarnessContract | null): { ok: boolean; reason?: string; verifier?: HarnessVerifier; contract_hash?: string };
  recordProposalVerification(proposal: HarnessEffectProposalInput, verifierId?: string | null, options?: {
    verdict?: unknown;
    observed_at?: string;
    expires_at?: string;
  }): Promise<{ ok: boolean; reason?: string; proposal_hash?: string; verifier?: HarnessVerifier; expires_at?: string; verdict?: ProposalVerificationVerdict }>;
  halt(reason?: string): void;
  override(reason?: string): void;
  clearOverride(reason?: string): void;
  runtimeHealth(extraIssues?: HarnessHealthIssue[]): HarnessRuntimeHealthResult;
  issueCapability(proposal: HarnessEffectProposalInput, options?: { expires_at?: string; one_time?: boolean; id?: string }): { ok: true; capability: HarnessCapability } | { ok: false; reason: string };
  executeCapability(input: {
    capability: HarnessCapability;
    adapter_id: string;
    proposal: HarnessEffectProposalInput;
    signal?: AbortSignal;
  }): Promise<HarnessCapabilityExecutionResult>;
  applyCapability(input: {
    capability: HarnessCapability;
    adapter_id: string;
    proposal: HarnessEffectProposalInput;
    signal?: AbortSignal;
  }): Promise<HarnessCapabilityExecutionResult>;
  runOnce(): Promise<HarnessRunOnceResult>;
}

export const HARNESS_KIT_VERSION: '0.1.0';
export const HARNESS_EVENT_SCHEMA_VERSION: 'frontier.harness.event.v1';
export const HARNESS_RECEIPT_SCHEMA_VERSION: 'frontier.harness.receipt.v1';
export const UNSIGNED_RECEIPT_LEVEL: 'L3';
export const UNSIGNED_RECEIPT_SIGNATURE: 'unsigned';
export const chaosFixtures: Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export function stableStringify(value: unknown): string;
export function sha256(value: unknown): string;
export function reduceHarnessEvents(events: HarnessEventEnvelope[]): HarnessRuntimeState;
export function validateEnvelopeChain(events: HarnessEventEnvelope[]): true;
export function validateSemanticReplay(events: HarnessEventEnvelope[]): true;
export function proposalOnlyWorker(options?: { id?: string; contract?: HarnessContract; proposals?: HarnessProposal[] }): HarnessWorker;
export function createEffectAdapter(options: { id?: string; effect: string; scopes?: string[]; execute: (input: { proposal: NormalizedHarnessProposalForEffect; capability: Omit<HarnessCapability, 'token' | 'token_hash'>; signal?: AbortSignal }) => Promise<unknown> | unknown }): HarnessAdapter;
export const createGatedAdapter: typeof createEffectAdapter;
export function createMemoryEffectAdapter(options: MemoryEffectAdapterOptions): HarnessAdapter;
export function createHarnessFromGoal(goal: HarnessGoal, options?: Record<string, unknown>): HarnessEngine;
