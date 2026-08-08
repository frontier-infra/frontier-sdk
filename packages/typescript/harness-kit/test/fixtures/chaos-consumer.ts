import {
  loadChaosCorpus,
  loadLiveDeploymentChaosPlan,
  runChaosCorpus,
  type ChaosCorpus,
  type ChaosFixtureResult,
  type ChaosReport,
} from '@frontier-infra/harness-kit/chaos-fixtures';

const corpus: ChaosCorpus = loadChaosCorpus();
const livePlan = loadLiveDeploymentChaosPlan();
const report: ChaosReport = await runChaosCorpus(corpus);
const first: ChaosFixtureResult | undefined = report.results[0];

if (report.evidence_scope !== 'simulated_package') throw new Error('unexpected evidence scope');
if (livePlan.overall_status !== 'NOT_RUN') throw new Error('live evidence must remain NOT_RUN');
if (first?.status === 'NOT_RUN') throw new Error(`fixture ${first.id} did not run`);
