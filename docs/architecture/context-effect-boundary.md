# Context and effect boundary

Status: roadmap constraint. This document does not add a connector integration or authorize a
new release claim.

## Sovereignty rule

Frontier does not need to rebuild the commodity connector ecosystem. Existing connector
frameworks may supply approved context on the read plane. They never grant permission to mutate
a business system.

Every mutation stays on the separate Frontier effect path:

1. A worker records a structured proposal under a ratified role contract.
2. The deterministic gateway evaluates role/effect policy and current independent evidence.
3. The gateway denies, escalates, or issues a one-time, scoped, expiring capability.
4. A registered opaque effect adapter is the only holder of the live write credential and invokes
   its private executor.
5. The harness records the reservation, outcome, and hash-linked receipt. Ambiguous downstream
   outcomes are never described as committed.

An MCP server, Singer tap, Airbyte source, browser session, or similar connector is not evidence of
write authority. Public method shape alone cannot prove that third-party code is read-only; the
deployment must also enforce read-only credentials, sandboxing, egress policy, and budgets.

## Current implementation

The current release already enforces the effect boundary:

- model and browser adapters are proposal-only;
- effect executors are held in a module-private registry and exposed as opaque descriptors;
- capability issuance is bound to the recorded proposal, ratified contract, scoped independent
  verifier evidence, operator dial, contract autonomy ceiling, and verifier trust ceilings;
- reservation and completion methods are private to the harness;
- Journeyman ships with every autonomy input at zero and no business effect adapter.

The deliberate future gap is an explicit read-context contract. Context is not yet captured as a
durable, provenance-bound snapshot that proposals can reference.

## Future optional read-side seam

The standards should define provider-neutral context semantics without depending on Singer:

```ts
interface ContextProvider {
  readonly id: string;
  readonly kind: 'context-provider';
  read(query: ContextQuery, options: {
    signal: AbortSignal;
    budget: ReadBudget;
  }): AsyncIterable<ContextEnvelope>;
}

interface ContextEnvelope {
  provider_id: string;
  source_scope: string;
  captured_at: string;
  schema_hash: string;
  cursor_before?: unknown;
  cursor_after?: unknown;
  records_hash: string;
  evidence_refs: string[];
  side_effect_class: 'none';
}
```

A future `@frontier-infra/adapter-singer-context` may implement that port as an optional,
isolated subprocess or container. It must:

- admit only pinned `tap-*` extractor artifacts from an approved manifest;
- never invoke targets, loaders, Meltano pipelines, utilities, or arbitrary commands;
- parse bounded Singer `SCHEMA`, `RECORD`, and `STATE` messages without piping to a target;
- use read-only source credentials, an egress allowlist, immutable package digests, and strict
  time/record/byte budgets;
- treat records as untrusted context, not verifier evidence;
- persist provenance, schema, cursor, freshness, and content hashes and bind the snapshot hash to
  any dependent proposal;
- reject sources that cannot provide genuinely read-only credentials.

## Meltano and Singer feasibility

Meltano is a plausible optional source for the future read plane. Its documentation separates
extractor taps from loader targets, provides plugin lock artifacts and variants, and the Singer SDK
supplies authentication, pagination, schema, incremental state, and testing scaffolding.

Licensing must be admitted per artifact:

- [Meltano core](https://github.com/meltano/meltano) is MIT.
- [Meltano Hub](https://github.com/meltano/hub) and the
  [Meltano Singer SDK](https://github.com/meltano/sdk) are Apache-2.0.
- Hub entries are independently maintained packages and do not inherit a blanket Hub license.
  Examples currently include Apache-2.0 taps, AGPL-3.0 taps, and Elastic License 2.0 taps.

An admission record must therefore pin repository and artifact digests, SPDX or reviewed license,
transitive dependencies, maintainer/source provenance, update policy, and the approved read scopes.

## Layer ownership

- Standards own context, proposal, policy, capability, and receipt semantics.
- Harness kit owns the future context port and snapshot binding, plus the existing deterministic
  gateway, capability issuer, opaque effect adapter contract, simulation, and fixtures.
- Optional adapter packages own third-party read runners and governed business connectors; their
  credentials remain physically separate.
- Journeyman owns role-pack authoring, guided interviews, approved source selection, provenance and
  freshness UI, approvals, and graduated autonomy.
- Conductor is the first intended deployment of an approved read catalog beside separately
  configured governed effect adapters.

No Meltano or Singer runtime is part of the current release.
