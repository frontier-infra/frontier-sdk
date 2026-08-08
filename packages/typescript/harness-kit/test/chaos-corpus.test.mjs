import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadChaosCorpus, loadLiveDeploymentChaosPlan, runChaosCorpus } from '../fixtures/run-chaos.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('typed chaos-fixtures subpath publishes its runtime and declaration together', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const exported = manifest.exports['./chaos-fixtures'];
  assert.deepEqual(exported, {
    types: './fixtures/run-chaos.d.ts',
    import: './fixtures/run-chaos.mjs',
  });
  assert.equal(fs.existsSync(path.join(packageRoot, exported.types)), true);
  assert.equal(fs.existsSync(path.join(packageRoot, exported.import)), true);
});

test('every simulated standard failure fixture has a deterministic passing execution result', async () => {
  const corpus = loadChaosCorpus();
  const report = await runChaosCorpus(corpus);

  assert.equal(corpus.schema_version, 'frontier.harness.chaos-corpus.v1');
  assert.equal(corpus.evidence_scope, 'simulated_package');
  assert.equal(report.status, 'PASS', JSON.stringify(report, null, 2));
  assert.equal(report.results.length, corpus.fixtures.length);
  assert.equal(report.results.every((result) => result.status === 'PASS'), true);
  assert.equal(new Set(report.results.map((result) => result.id)).size, corpus.fixtures.length);
});

test('live deployment chaos plan never masquerades as package evidence', () => {
  const plan = loadLiveDeploymentChaosPlan();
  assert.equal(plan.evidence_scope, 'live_deployment');
  assert.equal(plan.overall_status, 'NOT_RUN');
  assert.equal(plan.experiments.length > 0, true);
  assert.equal(plan.experiments.every((experiment) => experiment.status === 'NOT_RUN'), true);
});
