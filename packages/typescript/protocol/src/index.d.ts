export type RuntimeHealthCheckStatus = 'pass' | 'fail' | 'unknown';
export type RuntimeHealthAggregateStatus = 'pass' | 'degraded' | 'propose_only' | 'blocked' | 'halted' | 'invalid';
export type RuntimeHealthLayerName = 'process' | 'scheduler' | 'execution' | 'governance';

export interface RuntimeHealthCheck {
  id: string;
  status: RuntimeHealthCheckStatus;
  critical?: boolean;
  reason_code?: string;
  degradation_code?: string;
  observed_at: string;
  stale_after_seconds: number;
  summary: string;
  evidence?: string;
  [key: string]: unknown;
}

export interface RuntimeHealthLayer {
  purpose?: string;
  checks: RuntimeHealthCheck[];
  [key: string]: unknown;
}

export interface RuntimeHealthContract {
  schema_version: 'frontier.machine.health.v1';
  deployment_id: string;
  checked_at: string;
  layers: Record<RuntimeHealthLayerName, RuntimeHealthLayer>;
  aggregate_policy?: {
    status?: 'fail_closed';
    rule?: string;
    warning?: string;
    [key: string]: unknown;
  };
}

export interface RuntimeHealthLayerResult {
  status: 'pass' | 'degraded' | 'fail';
  failures: string[];
}

export interface RuntimeHealthReport {
  status: RuntimeHealthAggregateStatus;
  schema_version: string | null;
  aggregate: RuntimeHealthAggregateStatus;
  can_mutate: boolean;
  deployment_id: string | null;
  checked_at: string | null;
  layers: Partial<Record<RuntimeHealthLayerName, RuntimeHealthLayerResult>>;
  errors: string[];
  failures: string[];
  blockers: string[];
  propose_only: string[];
  halted: string[];
  degraded: string[];
  rule: string;
}

export const PROTOCOL_PACKAGE_VERSION: '0.1.0';
export const RUNTIME_HEALTH_SCHEMA_VERSION: 'frontier.machine.health.v1';
export const RUNTIME_HEALTH_LAYERS: readonly RuntimeHealthLayerName[];
export const RUNTIME_HEALTH_STATUS_PRECEDENCE: readonly ['halted', 'blocked', 'propose_only', 'degraded', 'pass'];
export function evaluateRuntimeHealth(contract: unknown): RuntimeHealthReport;
export function runtimeHealthExitCode(report: RuntimeHealthReport): 0 | 1 | 2;
