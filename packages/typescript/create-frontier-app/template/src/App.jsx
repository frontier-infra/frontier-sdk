import {
  ApprovalPanel,
  ContractCard,
  ReceiptTimeline,
  RuntimeHealthPanel,
} from '@frontier-infra/governance-react';
import '@frontier-infra/governance-react/style.css';
import React from 'react';
import { useEffect, useState } from 'react';

const apiBase = import.meta.env.VITE_API_BASE || '';

export default function App() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);

  async function loadStatus() {
    setError(null);
    const response = await fetch(`${apiBase}/api/frontier/status`);
    if (!response.ok) throw new Error(`status request failed: ${response.status}`);
    setStatus(await response.json());
  }

  async function runOnce() {
    setRunning(true);
    setError(null);
    try {
      const response = await fetch(`${apiBase}/api/frontier/run-once`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ intent: 'run_once' }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || `run failed: ${response.status}`);
      setStatus(body.status);
    } catch (runError) {
      setError(runError.message);
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => {
    loadStatus()
      .catch((loadError) => setError(loadError.message))
      .finally(() => setLoading(false));
  }, []);

  const contract = status?.contract;
  const health = status?.health;
  const receipts = status?.receipts ?? [];

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Frontier Infra starter</p>
          <h1>__PROJECT_NAME__</h1>
          <a className="agent-link" href="/.agent" rel="alternate agent-view" type="text/agent-view; version=1">Agent view</a>
        </div>
        <button type="button" onClick={loadStatus}>Refresh</button>
      </header>

      {error ? <p className="error" role="alert">{error}</p> : null}
      {loading ? <p>Loading governance state...</p> : null}

      <section className="dashboard-grid" aria-label="Governance dashboard">
        <ContractCard contract={contract} />
        <RuntimeHealthPanel report={health} />
        <ApprovalPanel
          title="Run worker once"
          proposal={{ id: 'demo-write', effect: 'memory.write', scope: 'workspace:demo' }}
          status="proposal-only"
          approvals={[]}
          onApprove={health?.can_mutate ? runOnce : undefined}
          approveLabel={running ? 'Running...' : 'Run through gate'}
          disabled={running || !health?.can_mutate}
        />
      </section>

      <section className="notice-band" aria-label="Proposal-only status">
        <strong>Proposal-only starter.</strong>
        <span>{health?.propose_only?.[0] || 'A real verifier callback is not configured in the generated app.'}</span>
      </section>

      <ReceiptTimeline receipts={receipts} />
    </main>
  );
}
