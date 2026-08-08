# Frontier SDK

Frontier SDK is the implementation family for building governed agent applications without
depending on a particular model provider, coding harness, or dashboard.

The standards remain canonical in their own repositories:

- AVL defines agent-readable views and ground-truth surfaces.
- AAR defines portable signed records and their evidence limits.
- ADL defines coding-worker contract and proof discipline.
- The Machine defines long-running harness obligations and conformance levels.

This repository owns shared protocol schemas, generated language types, deterministic reference
reducers, and cross-language conformance fixtures. It does not supersede those standards.

## Package layers

| Package | Purpose | Status |
| --- | --- | --- |
| `@frontier-infra/protocol` | JavaScript runtime, TypeScript declarations, health schema constants, and deterministic reference reducer | runnable scaffold |
| `@frontier-infra/audit` | Node CLI (`frontier-audit`) for local static audit evidence packets using locked The Machine kit + AAR snapshots | executable vertical slice |
| `@frontier-infra/harness-kit` | Deterministic governed-worker driver, durable event contracts, scoped verification, budgets, quarantine, override, opaque effect execution, and executable failure fixtures | executable reference slice |
| `@frontier-infra/adapters` | Proposal-only model/browser ports, PostgreSQL/Redis/S3 receipt and queue ports, identity normalizers, gate-enforced alerts, and opaque business connectors | executable reference adapters |
| `@frontier-infra/governance-react` | Accessible contract, approval, receipt, health, and override components | reusable UI kit |
| `@frontier-infra/create-frontier-app` | CLI that generates a same-origin, proposal-only governed-worker starter with local and production reference deployment manifests | executable starter |
| `frontier-protocol` | Python binding and equivalent deterministic reference reducer | runnable scaffold |
| `conformance/runtime-health` | Shared golden fixtures consumed by both language packages and downstream adapters | canonical fixture corpus |

These layers deliberately stop short of being Journeyman. The SDK owns portable protocol and
evidence semantics; the harness kit owns the reusable governed execution machinery; adapters own
translation but never authority; the starter assembles those pieces; products own workflow,
operations, and user experience. Empty packages are not published as architecture placeholders.

## Start a governed worker

```bash
npx @frontier-infra/create-frontier-app my-worker
cd my-worker
npm install
npm run dev
```

The generated worker starts in proposal-only mode. Installing the SDK or selecting a model never
enables effects. Mutation requires a ratified contract, independent verifier evidence, the
operator dial, the contract autonomy ceiling, and the verifier trust ceilings to agree at the
deterministic gate. The effective authority is the minimum of those inputs.

The harness package includes deterministic package-level chaos fixtures. Its separate live
deployment chaos plan is shipped as `NOT_RUN`; installing or testing the package does not turn
those planned experiments into deployment evidence.

Future connector work must preserve the documented
[context/effect boundary](docs/architecture/context-effect-boundary.md): commodity ecosystems may
supply approved read context, but only Frontier's capability-gated opaque adapters may perform
business effects.

## Contract ownership

`schemas/frontier.machine.health.v1.schema.json` is the canonical schema for the four-layer runtime
health record. `packages/typescript/protocol/src/index.mjs` and
`packages/python/frontier-protocol/src/frontier_protocol/runtime_health.py` are reference reducers.

Consumers may ship generated snapshots for offline use, but they must carry a protocol lock and
must not be edited independently. Run:

```bash
node scripts/sync-consumers.mjs ../plugins/frontier-infra
```

to refresh the Codex plugin snapshot.

The audit package also ships generated snapshots, but from the canonical standards it executes:

```bash
npm run sync:audit
npm run check:audit
```

`frontier-audit run <repo> --out <dir>` binds the target Git commit and dirty tree, verifies its
generated snapshot hashes, runs the canonical The Machine static kit locally, emits
`evidence.json` and `evidence.md`, and leaves live chaos/replay checks as `NOT_RUN`. The output
directory must resolve outside the audited Git repository, including symlinked paths. Detached AAR
signing is opt-in and requires both `--sign-key <private-jwk>` and
`--did-json <public-did-json>`; the CLI verifies immediately with that provided DID JSON, never
records the private key path in emitted artifacts, and never fetches keys or installs
dependencies. `frontier-audit verify --evidence evidence.json --aar aar.json --did-json did.json`
recomputes the evidence hash committed by the AAR before running offline signature verification.

Signed receipts identify `@frontier-infra/audit` by exact version and commit to the scorer snapshot
lock by SHA-256. AAR L2 proves structural verifier separation (`verifier.id != subject`), while
organizational independence is separately disclosed and defaults to `same_principal`.
Deterministic execution is reproducible; it is not a substitute for an external auditor.

## Codex integration

`integrations/codex/frontier-audit` is the thin Codex marketplace adapter for the audit SDK. It
runs the published `@frontier-infra/audit` CLI through `npx`. The evidence packet records the exact
CLI version and scorer snapshot lock. Host permissions govern package installation; the adapter
does not bundle a tarball, implement a second bootstrap trust system, or duplicate scoring and AAR
semantics in prompt text.

## Verify

```bash
npm run test:node
npm run test:python
npm run check:consumers -- ../plugins/frontier-infra
npm run check:audit
```

Passing these tests proves schema/reducer parity against the bundled fixtures. It does not certify
any deployment as Machine-L3.

## Release boundary

- Provider and harness adapters translate capabilities; they do not grant authority.
- Only a deterministic gate may authorize durable mutation.
- Unknown or malformed health evidence fails closed.
- A package version and schema version must be recorded in downstream receipts.
- Machine conformance levels require executed deployment evidence, not SDK installation.

MIT. See `LICENSE`.
