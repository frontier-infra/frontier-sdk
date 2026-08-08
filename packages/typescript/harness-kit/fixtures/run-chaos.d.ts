export type ChaosEvidenceScope = 'simulated_package';
export type ChaosFixtureStatus = 'PASS' | 'FAIL' | 'NOT_RUN';

export interface ChaosFixtureExpected {
  outcome: string;
  can_mutate?: boolean;
  active_effects?: number;
  reason_includes?: string;
  required_event?: string;
  forbidden_event?: string;
  committed_event_count?: number;
}

export interface ChaosFixtureDefinition {
  id: string;
  category: 'governance' | 'ordering' | 'capability' | 'connector' | 'budget' | 'operator-control' | 'durability';
  scenario: string;
  expected: ChaosFixtureExpected;
}

export interface ChaosCorpus {
  schema_version: 'frontier.harness.chaos-corpus.v1';
  corpus_id: string;
  evidence_scope: ChaosEvidenceScope;
  disclaimer: string;
  fixtures: ChaosFixtureDefinition[];
}

export interface LiveDeploymentChaosExperiment {
  id: string;
  status: 'NOT_RUN';
  requires: string;
}

export interface LiveDeploymentChaosPlan {
  schema_version: 'frontier.harness.live-chaos-plan.v1';
  plan_id: string;
  evidence_scope: 'live_deployment';
  overall_status: 'NOT_RUN';
  disclaimer: string;
  experiments: LiveDeploymentChaosExperiment[];
}

export interface ChaosFixtureActual {
  outcome: string;
  events: string[];
  reason?: string;
  can_mutate?: boolean;
  active_effects?: number;
}

export interface ChaosFixtureResult {
  id: string;
  status: ChaosFixtureStatus;
  actual?: ChaosFixtureActual;
  failures: string[];
}

export interface ChaosReport {
  schema_version: 'frontier.harness.chaos-report.v1';
  corpus_id: string;
  evidence_scope: ChaosEvidenceScope;
  status: 'PASS' | 'FAIL';
  results: ChaosFixtureResult[];
}

export function loadChaosCorpus(): ChaosCorpus;
export function loadLiveDeploymentChaosPlan(): LiveDeploymentChaosPlan;
export function runChaosCorpus(corpus?: ChaosCorpus): Promise<ChaosReport>;
