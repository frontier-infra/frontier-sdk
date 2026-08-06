import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { evaluateRuntimeHealth, runtimeHealthExitCode } from '../src/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const fixtures = path.join(root, 'conformance/runtime-health');
const expected = {
  'healthy.json': ['pass', true, 0],
  'process-only.json': ['blocked', false, 2],
  'provider-credit-auth-failure.json': ['blocked', false, 2],
  'governance-dead.json': ['propose_only', false, 2],
  'operator-halt.json': ['halted', false, 2],
  'mixed-blocker-propose-only.json': ['blocked', false, 2],
  'degraded-optional-check.json': ['degraded', true, 0],
  'invalid-structural-evidence.json': ['invalid', false, 1],
};

for (const [fixture, [status, canMutate, exitCode]] of Object.entries(expected)) {
  test(`evaluates ${fixture}`, () => {
    const contract = JSON.parse(fs.readFileSync(path.join(fixtures, fixture), 'utf8'));
    const report = evaluateRuntimeHealth(contract);
    assert.equal(report.status, status);
    assert.equal(report.can_mutate, canMutate);
    assert.equal(runtimeHealthExitCode(report), exitCode);
  });
}

test('rejects malformed and impossible evidence', () => {
  const healthy = JSON.parse(fs.readFileSync(path.join(fixtures, 'healthy.json'), 'utf8'));
  const cases = {
    missing_summary: (contract) => { delete contract.layers.process.checks[0].summary; },
    missing_stale_after_seconds: (contract) => { delete contract.layers.scheduler.checks[0].stale_after_seconds; },
    invalid_reason_code: (contract) => { contract.layers.execution.checks[0].reason_code = 'provider_says_ok'; },
    extra_top_level: (contract) => { contract.provider = 'not-authoritative'; },
    extra_layer: (contract) => { contract.layers.provider = structuredClone(contract.layers.execution); },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const contract = structuredClone(healthy);
    mutate(contract);
    const report = evaluateRuntimeHealth(contract);
    assert.equal(report.status, 'invalid', name);
    assert.equal(report.can_mutate, false, name);
  }

  const future = structuredClone(healthy);
  future.layers.governance.checks[0].observed_at = '2026-08-05T12:01:00Z';
  const futureReport = evaluateRuntimeHealth(future);
  assert.equal(futureReport.status, 'blocked');
  assert.equal(futureReport.can_mutate, false);
});
