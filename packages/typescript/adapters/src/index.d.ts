import type { HarnessAdapter, HarnessCapability, HarnessProposal, NormalizedHarnessProposalForEffect } from '@frontier-infra/harness-kit';

export const ADAPTERS_PACKAGE_VERSION: '0.1.0';
export const DEFAULT_TIMEOUT_MS: 30000;
export const DEFAULT_MAX_RESPONSE_BYTES: 1000000;
export const DEFAULT_MAX_PROPOSAL_BYTES: 64000;
export const DEFAULT_MAX_RECEIPT_BYTES: 1000000;
export const DEFAULT_MAX_ALERT_MESSAGE_BYTES: 4096;
export const DEFAULT_MAX_ALERT_CONTEXT_BYTES: 16384;
export const OPERATIONAL_ALERT_EFFECT: 'operations.alert.deliver';
export const OPERATIONAL_ALERT_SEVERITIES: readonly ['info', 'warning', 'critical'];

export class AdapterError extends Error {
  code: string;
  details: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>);
  toJSON(): { name: string; code: string; message: string; details: Record<string, unknown> };
}

export interface ProposalPort {
  id: string;
  kind: 'proposal-port';
  provider: string;
  mode?: string;
  baseUrl?: string;
  propose(input?: ProposalPortInput, options?: { signal?: AbortSignal }): Promise<HarnessProposal[]>;
}

export interface FetchAdapterOptions {
  id?: string;
  baseUrl?: string;
  apiKey?: string;
  fetch?: typeof fetch;
  model: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxProposalBytes?: number;
  headers?: Record<string, string | undefined>;
}

export interface ProposalPortInput {
  prompt?: string;
  input?: unknown;
  messages?: unknown[];
  instructions?: string;
  metadata?: Record<string, unknown>;
  temperature?: number;
  max_tokens?: number;
  system?: string;
  [key: string]: unknown;
}

export function redactSecrets(value: unknown): unknown;
export function createOpenAICompatibleAdapter(options: FetchAdapterOptions & {
  mode?: 'responses' | 'chat';
  allowLocalHttp?: boolean;
  requireLocal?: boolean;
}): ProposalPort;
export function createLocalOpenAICompatibleAdapter(options: FetchAdapterOptions & {
  mode?: 'responses' | 'chat';
}): ProposalPort;
export function createAnthropicMessagesAdapter(options: FetchAdapterOptions & {
  anthropicVersion?: string;
  maxTokens?: number;
}): ProposalPort;
export function createBrowserWorkerProposalPort(options: {
  id?: string;
  request(input: Record<string, unknown>, options: { signal: AbortSignal }): Promise<unknown> | unknown;
  timeoutMs?: number;
  maxProposalBytes?: number;
}): ProposalPort;

export function createGatedBusinessConnector(options: {
  id?: string;
  effect: string;
  scopes?: string[];
  client?: unknown;
  timeoutMs?: number;
  execute(input: {
    client: unknown;
    proposal: NormalizedHarnessProposalForEffect;
    capability: Omit<HarnessCapability, 'token' | 'token_hash'>;
    signal: AbortSignal;
  }): Promise<unknown> | unknown;
}): HarnessAdapter;

export type OperationalAlertSeverity = typeof OPERATIONAL_ALERT_SEVERITIES[number];

export interface OperationalAlert {
  severity: OperationalAlertSeverity;
  message: string;
  context: unknown;
}

export interface OperationalAlertProposalInput {
  effect?: string;
  scope: string;
  payload: { severity: string; message: string; context?: unknown };
}

export function operationalAlertIdempotencyKey(input: OperationalAlertProposalInput, options?: {
  maxMessageBytes?: number;
  maxContextBytes?: number;
}): string;

export function createOperationalAlertConnector(options: {
  id?: string;
  effect?: string;
  scopes?: string[];
  client?: unknown;
  timeoutMs?: number;
  maxMessageBytes?: number;
  maxContextBytes?: number;
  deliver(input: {
    client: unknown;
    alert: OperationalAlert;
    capability: Omit<HarnessCapability, 'token' | 'token_hash'>;
    idempotency_key: string;
    signal: AbortSignal;
  }): Promise<unknown> | unknown;
}): HarnessAdapter;

export function createPostgresStatePort(options: {
  client: { query(input: { text: string; values: unknown[]; signal: AbortSignal; expectedVersion?: number }): Promise<{ rows?: Array<Record<string, unknown>> }> };
  table?: string;
  timeoutMs?: number;
}): PostgresStatePort;

export interface PostgresStatePort {
  readonly id: 'postgres-state';
  readonly kind: 'state-port';
  loadState(key: string, options?: { signal?: AbortSignal }): Promise<{ state: unknown; version: unknown } | null>;
  saveState(key: string, state: unknown, options?: { signal?: AbortSignal; expectedVersion?: number }): Promise<{ ok: true; version: unknown }>;
}

export function createRedisQueuePort(options: {
  client: {
    sendCommand?: (command: string, args: string[], options: { signal: AbortSignal }) => Promise<unknown>;
    command?: (command: string, args: string[], options: { signal: AbortSignal }) => Promise<unknown>;
  };
  keyPrefix?: string;
  timeoutMs?: number;
}): RedisQueuePort;

export interface RedisQueuePort {
  readonly id: 'redis-queue';
  readonly kind: 'queue-port';
  enqueue(queue: string, item: unknown, idempotencyKey: string, options?: { signal?: AbortSignal; ttlSeconds?: number }): Promise<{ ok: boolean; duplicate?: boolean; id: string }>;
  claimIdempotency(idempotencyKey: string, options?: { signal?: AbortSignal; ttlSeconds?: number }): Promise<{ ok: boolean }>;
  ack(queue: string, id: string, options?: { signal?: AbortSignal }): Promise<{ ok: boolean }>;
}

export interface ReceiptEvidenceSink {
  readonly id: string;
  readonly kind: 'evidence-port';
  putReceipt(key: string, receipt: unknown, options?: { signal?: AbortSignal }): Promise<{ ok: true; bytes: number; sha256: string }>;
}

export interface S3ReceiptEvidenceSinkOptions {
  client: {
    putObject?: (input: Record<string, unknown>) => Promise<unknown>;
    send?: (command: { type: 'PutObject'; input: Record<string, unknown>; signal: AbortSignal }) => Promise<unknown>;
  };
  bucket: string;
  timeoutMs?: number;
  maxReceiptBytes?: number;
}

export function createS3EvidenceReceiptPort(options: S3ReceiptEvidenceSinkOptions): ReceiptEvidenceSink;
export const createS3ReceiptEvidenceSink: typeof createS3EvidenceReceiptPort;

export interface NormalizedIdentityClaims {
  provider: 'clerk' | 'auth0' | 'workos';
  subject?: string;
  email?: string;
  email_verified: boolean;
  organization_id?: string;
  roles: string[];
}

export function normalizeClerkClaims(claims: Record<string, unknown>): NormalizedIdentityClaims;
export function normalizeAuth0Claims(claims: Record<string, unknown>): NormalizedIdentityClaims;
export function normalizeWorkOSClaims(claims: Record<string, unknown>): NormalizedIdentityClaims;
export const identityClaimExamples: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
