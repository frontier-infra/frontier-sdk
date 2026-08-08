# @frontier-infra/harness-kit

First publishable vertical slice for a Frontier harness deployment.

This package is deliberately small and dependency-light. It provides:

- proposal-only worker execution
- independent scoped verifier ratification
- deterministic event-sourced state with idempotency
- capability-gated effect adapters
- runtime health reduction through `@frontier-infra/protocol`
- halt, override, retry, and quarantine controls
- an autonomy gate that requires `min(operator_dial, contract.autonomy_ceiling,
  verifier verdict trust, verifier.trust_ceiling) === 1` before any capability
  is issued
- hash-chained receipts labeled `L3` and `unsigned`

The receipts are fabrication-evident local records only. They are not AAR L4
signed receipts and must not be presented as such.

Effect adapters are opaque descriptors created by `createEffectAdapter()` (or
`createMemoryEffectAdapter()` for tests). The executor closure is stored in a
module-private registry, not on the public adapter object.

`HarnessEngine.executeCapability()` is the only effect execution path:

1. It resolves an actually registered opaque adapter by `adapter_id`.
2. It privately reserves a scoped, one-time lease; the event log stores only the
   lease-secret hash.
3. It invokes the private adapter executor.
4. It privately records success, or records connector failure.

Completion and failure require the lease secret plus the same adapter identity that
created the reservation. Expired reservations are terminal failures for that
capability, so callers must issue a new capability after a stale lease.

There is intentionally no one-call consume/commit helper: receipts must never
claim an effect committed before the connector has actually executed. There is
also no public reserve/complete/fail lifecycle API.

The JSONL event store uses a sibling lockfile, reloads and validates the current
log under that lock, appends the next envelope, and fsyncs the write. Stale locks
are recovered only on a single host when the recorded owner pid is gone and the
lock is older than the bounded stale window; live or ambiguous locks fail closed.

```sh
frontier-harness run goal.json --once
```

The CLI reads a goal JSON document, ratifies the included contract when an
independent verifier is configured, runs a proposal-only worker, and writes the
append-only, fsynced event chain to `.frontier-harness/events.jsonl` next to the
goal file.

Defaults are deliberately propose-only: `contract.autonomy_ceiling`,
`verifier.trust_ceiling`, and `operator_dial` all default to `0`. Operators can
raise the dial with `setOperatorDial()`, which records a receipt-backed
`operator_dial_set` event, but capabilities are still blocked unless the contract,
verifier ceiling, and evidence-bound verifier verdict all reach `1`.

Unsigned L3 receipts are hash-chain and semantic-replay checked on load, including
capability and reservation lifecycle preconditions. They are still local,
unsigned records: they make tampering and lifecycle forgery detectable by this
store, but they are not AAR L4 signatures and do not prove who wrote the log.

## Standard failure and chaos fixtures

The package ships a versioned, machine-readable corpus at
`fixtures/chaos-corpus.v1.json`. It covers missing and inert verifiers,
self-ratification, duplicate and reordered inputs, forged, expired, wrong-scope,
and replayed capabilities, ambiguous connector outcomes, retry quarantine,
operator halt, restart with a stale reservation, and tampered lifecycle logs.

Run every deterministic package simulation with:

```sh
npm run test:chaos
```

The runner emits `frontier.harness.chaos-report.v1` and fails unless every
fixture matches its declared outcome, event/receipt consequences, and applicable
runtime-health expectation. Applications can import it from
`@frontier-infra/harness-kit/chaos-fixtures`; that subpath ships declarations for
the corpus, live plan, individual results, and complete report. Maintainers can
run the strict NodeNext consumer regression with `npm run test:types`.

These are **simulated package fixtures**, not proof of live deployment behavior.
`fixtures/live-deployment-chaos.v1.json` lists the PostgreSQL, Redis, S3,
identity-provider, model-provider, browser-worker, connector, and multi-replica
experiments still required of a concrete deployment. Every one is deliberately
marked `NOT_RUN` until that deployment produces its own evidence.
