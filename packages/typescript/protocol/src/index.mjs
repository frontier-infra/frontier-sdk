export const PROTOCOL_PACKAGE_VERSION = '0.1.0';
export const RUNTIME_HEALTH_SCHEMA_VERSION = 'frontier.machine.health.v1';
export const RUNTIME_HEALTH_LAYERS = Object.freeze(['process', 'scheduler', 'execution', 'governance']);
export const RUNTIME_HEALTH_STATUS_PRECEDENCE = Object.freeze([
  'halted',
  'blocked',
  'propose_only',
  'degraded',
  'pass',
]);

const allowedTopLevelFields = new Set(['schema_version', 'deployment_id', 'checked_at', 'layers', 'aggregate_policy']);
const proposeOnlyReasons = new Set(['missing_verifier', 'stale_verifier', 'unratified_contract']);
const haltedReasons = new Set(['active_override', 'no_ack_halt']);
const blockedReasons = new Set(['auth_failed', 'credit_exhausted', 'scheduler_stalled', 'worker_unavailable']);
const allowedReasonCodes = new Set([
  ...proposeOnlyReasons,
  ...haltedReasons,
  ...blockedReasons,
  'governance_gate_failed',
]);

function parseTimestamp(value, path, errors) {
  if (typeof value !== 'string') {
    errors.push(`${path} must be an ISO timestamp string`);
    return null;
  }
  const millis = Date.parse(value);
  if (Number.isNaN(millis)) {
    errors.push(`${path} must be a valid ISO timestamp`);
    return null;
  }
  return millis;
}

function classifyIssue({ buckets, critical, layerName, message, reasonCode }) {
  const rendered = `${layerName}: ${message}`;
  if (haltedReasons.has(reasonCode)) {
    buckets.halted.push(`${rendered} (${reasonCode})`);
    return 'fail';
  }
  if (blockedReasons.has(reasonCode)) {
    buckets.blockers.push(`${rendered} (${reasonCode})`);
    return 'fail';
  }
  if (proposeOnlyReasons.has(reasonCode)) {
    buckets.proposeOnly.push(`${rendered} (${reasonCode})`);
    return 'fail';
  }
  if (critical) {
    buckets.blockers.push(`${rendered}${reasonCode ? ` (${reasonCode})` : ''}`);
    return 'fail';
  }
  buckets.degraded.push(rendered);
  return 'degraded';
}

function emptyInvalidReport(errors) {
  return {
    status: 'invalid',
    schema_version: null,
    aggregate: 'invalid',
    can_mutate: false,
    deployment_id: null,
    checked_at: null,
    layers: {},
    errors,
    failures: [],
    blockers: [],
    propose_only: [],
    halted: [],
    degraded: [],
    rule: 'process, scheduler, execution, and governance must all pass fresh critical checks; can_mutate is true on pass or degraded',
  };
}

export function evaluateRuntimeHealth(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    return emptyInvalidReport(['contract must be a JSON object']);
  }

  const errors = [];
  const failures = [];
  const buckets = { blockers: [], proposeOnly: [], halted: [], degraded: [] };
  const checkedAt = parseTimestamp(contract.checked_at, 'checked_at', errors);

  for (const field of Object.keys(contract)) {
    if (!allowedTopLevelFields.has(field)) errors.push(`unexpected top-level field ${field}`);
  }
  if (typeof contract.deployment_id !== 'string' || !contract.deployment_id.trim()) {
    errors.push('deployment_id must be a non-empty string');
  }
  if (contract.schema_version !== RUNTIME_HEALTH_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${RUNTIME_HEALTH_SCHEMA_VERSION}`);
  }
  if (!contract.layers || typeof contract.layers !== 'object' || Array.isArray(contract.layers)) {
    errors.push('layers must be an object');
  } else {
    for (const layerName of Object.keys(contract.layers)) {
      if (!RUNTIME_HEALTH_LAYERS.includes(layerName)) errors.push(`unexpected layer ${layerName}`);
    }
  }
  if (contract.aggregate_policy !== undefined) {
    if (!contract.aggregate_policy || typeof contract.aggregate_policy !== 'object' || Array.isArray(contract.aggregate_policy)) {
      errors.push('aggregate_policy must be an object');
    } else {
      if (contract.aggregate_policy.status !== undefined && contract.aggregate_policy.status !== 'fail_closed') {
        errors.push('aggregate_policy.status must be fail_closed');
      }
      for (const field of ['rule', 'warning']) {
        if (contract.aggregate_policy[field] !== undefined && typeof contract.aggregate_policy[field] !== 'string') {
          errors.push(`aggregate_policy.${field} must be a string`);
        }
      }
    }
  }

  const layerResults = {};
  for (const layerName of RUNTIME_HEALTH_LAYERS) {
    const layer = contract.layers?.[layerName];
    const layerFailures = [];
    let layerHardFailure = false;
    let layerDegraded = false;

    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) {
      layerFailures.push('missing layer');
      buckets.blockers.push(`${layerName}: missing layer`);
      layerResults[layerName] = { status: 'fail', failures: layerFailures };
      continue;
    }
    if (!Array.isArray(layer.checks) || layer.checks.length === 0) {
      layerFailures.push('no checks');
      buckets.blockers.push(`${layerName}: no checks`);
      layerResults[layerName] = { status: 'fail', failures: layerFailures };
      continue;
    }

    for (const [index, check] of layer.checks.entries()) {
      const prefix = `${layerName}.checks[${index}]`;
      const structuralFailure = (message) => {
        layerFailures.push(message);
        errors.push(message);
      };
      if (!check || typeof check !== 'object' || Array.isArray(check)) {
        structuralFailure(`${prefix} must be an object`);
        continue;
      }
      if (typeof check.id !== 'string' || !check.id.trim()) structuralFailure(`${prefix}.id missing`);
      if (!['pass', 'fail', 'unknown'].includes(check.status)) structuralFailure(`${prefix}.status must be pass, fail, or unknown`);
      if (check.critical !== undefined && typeof check.critical !== 'boolean') structuralFailure(`${prefix}.critical must be a boolean`);
      const critical = check.critical !== false;
      const reasonCode = typeof check.reason_code === 'string' ? check.reason_code : null;
      if (check.reason_code !== undefined && (!reasonCode || !allowedReasonCodes.has(reasonCode))) {
        structuralFailure(`${prefix}.reason_code is not recognized`);
      }
      if (check.degradation_code !== undefined && typeof check.degradation_code !== 'string') {
        structuralFailure(`${prefix}.degradation_code must be a string`);
      }
      if (check.evidence !== undefined && typeof check.evidence !== 'string') {
        structuralFailure(`${prefix}.evidence must be a string`);
      }

      const classify = (message) => {
        const classification = classifyIssue({ buckets, critical, layerName, message, reasonCode });
        layerHardFailure ||= classification === 'fail';
        layerDegraded ||= classification === 'degraded';
      };

      if (check.status === 'fail' || check.status === 'unknown') {
        const message = `${check.id ?? prefix} status ${check.status}`;
        layerFailures.push(message);
        classify(message);
      }

      const observedAt = parseTimestamp(check.observed_at, `${prefix}.observed_at`, errors);
      if (!Number.isInteger(check.stale_after_seconds) || check.stale_after_seconds < 1) {
        structuralFailure(`${prefix}.stale_after_seconds must be a positive integer`);
      } else if (checkedAt !== null && observedAt !== null) {
        const ageSeconds = Math.floor((checkedAt - observedAt) / 1000);
        if (ageSeconds < 0) {
          const message = `${check.id ?? prefix} observed_at is after checked_at`;
          layerFailures.push(message);
          classify(message);
        }
        if (ageSeconds > check.stale_after_seconds) {
          const message = `${check.id ?? prefix} stale by ${ageSeconds - check.stale_after_seconds}s`;
          layerFailures.push(message);
          classify(message);
        }
      }
      if (typeof check.summary !== 'string' || !check.summary.trim()) structuralFailure(`${prefix}.summary missing`);
    }

    for (const failure of layerFailures) failures.push(`${layerName}: ${failure}`);
    layerResults[layerName] = {
      status: layerHardFailure ? 'fail' : layerDegraded ? 'degraded' : layerFailures.length === 0 ? 'pass' : 'fail',
      failures: layerFailures,
    };
  }

  const status = errors.length > 0
    ? 'invalid'
    : buckets.halted.length > 0
      ? 'halted'
      : buckets.blockers.length > 0
        ? 'blocked'
        : buckets.proposeOnly.length > 0
          ? 'propose_only'
          : buckets.degraded.length > 0
            ? 'degraded'
            : 'pass';

  return {
    status,
    schema_version: contract.schema_version ?? null,
    aggregate: status === 'pass' ? 'pass' : status,
    can_mutate: status === 'pass' || status === 'degraded',
    deployment_id: contract.deployment_id ?? null,
    checked_at: contract.checked_at ?? null,
    layers: layerResults,
    errors,
    failures,
    blockers: buckets.blockers,
    propose_only: buckets.proposeOnly,
    halted: buckets.halted,
    degraded: buckets.degraded,
    rule: 'process, scheduler, execution, and governance must all pass fresh critical checks; can_mutate is true on pass or degraded',
  };
}

export function runtimeHealthExitCode(report) {
  if (report.status === 'pass' || report.status === 'degraded') return 0;
  if (['blocked', 'propose_only', 'halted'].includes(report.status)) return 2;
  return 1;
}
