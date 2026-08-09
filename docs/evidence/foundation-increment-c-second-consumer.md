# Foundation Increment C: second-consumer evidence

## Verdict

PASS for a local, offline, synthetic second-consumer proof. A standalone
consumer installed packed `@frontier-infra/protocol@0.1.0` and
`@frontier-infra/harness-kit@0.1.0` artifacts, imported only the public Harness
Kit entry point, and completed this chain:

```text
proposal-only worker
  → deterministic policy verdict
  → one-time capability
  → opaque local effect adapter
  → exact synthetic file effect
  → hash-linked Harness receipts
```

No public Harness API change was needed. This is Foundation Increment C
(`second-consumer readiness`), not the separate Shelvie product-roadmap
increment that earlier documents also called Increment C.

The ratified milestone contract binds its declared immutable fields with
SHA-256 `78b34ba66f428e45a3c3be81eddad8173be69b8907c3f41414692db0e3cb9909`
over recursively key-sorted JSON.

## Custody and source pins

| Evidence | Commit | Finding |
| --- | --- | --- |
| Increment A, Conductor Public compatibility slice | `c9c5b356b4ce08a1f73785316610f940bab4888b` | First domain-shaped local consumer; required wrapper preflights for two post-issuance checks. |
| Increment B, Harness Kit hardening | `407f61660e183e11a36e841f805814738e2ea616` | Added direct payload-hash and runtime-health rechecks without changing public APIs, types, schemas, or dependencies. |
| Increment C consumer | this Foundation commit | Neutral second consumer installed from tarballs and used the post-Increment-B public package boundary. |

Increment A remains owned by Conductor Public. Increment B and this proof remain
owned by Frontier Foundation/Harness Kit. No Conductor, Shelvie, Titanium, ADL,
AAR, deployment, or external-system source was modified for this increment.

The repository-wide gate found two stale adapter test assumptions after
Increment B: altered scope is now rejected first as a proposal-hash mismatch,
and a receipted governance rejection intentionally makes that Harness instance
fail closed for later mutation. The adapter tests now assert the stronger reason
and use a fresh Harness instance for their positive path. This changes tests
only; adapter runtime, Harness API, declarations, schemas, and dependencies are
unchanged.

## Black-box boundary

`conformance/second-consumer/verify.mjs` performs the package-boundary proof:

1. It scans `consumer.mjs` and rejects relative imports, `/src/` imports,
   additional Frontier package imports, or business-domain coupling.
2. It creates fresh protocol and Harness Kit tarballs with lifecycle scripts
   disabled.
3. It installs those tarballs into a temporary npm workspace using offline mode.
4. It confirms the installed Harness package contains no test directory.
5. It runs the copied consumer from that isolated workspace and validates the
   structured proof result.

The consumer imports Node standard-library modules plus only
`@frontier-infra/harness-kit`. It cannot resolve the SDK checkout through a
relative source path.

## Exact proof surface

The synthetic policy allows exactly:

| Field | Bound value |
| --- | --- |
| Effect | `local.synthetic-artifact.write.v1` |
| Scope | `local:frontier-second-consumer:artifact` |
| Adapter | `local-synthetic-artifact` |
| Target | `synthetic-artifact.json` |
| Record digest | `309fddaf9e340ac9fee14c577418c85a1602dfb60899dc402c7c9b7a172f1f3e` |
| Operation idempotency key | `second-consumer:fixture-001:write-once` |

The worker has no executor. The adapter's executor is private behind the opaque
object returned by `createEffectAdapter`; the public adapter object exposes no
`execute` method. The adapter independently rechecks the capability, target,
and record digest before exclusively creating a mode-`0600` file. The entire
effect directory must be empty before that create.

The deterministic verifier has a different identity from the worker and binds
its result to the proposal hash, contract hash, exact policy values, and fixture
digest. It is independent in runtime identity only; it is not a separately
operated organizational principal.

## Mechanical results

The isolated proof produced eight receipt envelopes on the positive path and a
single `effect_committed` event. `validateEnvelopeChain()` and
`validateSemanticReplay()` both passed. Capability consumption was confirmed in
the replayed Harness state, and replay returned `duplicate` without a second
adapter call.

| Case | Result | Effect count |
| --- | --- | --- |
| Exact authorized proposal | `committed` | 1 |
| Deterministic policy mismatch | `rejected` | 0 |
| Post-issuance proposal tamper | `rejected` | 0 |
| Capability replay | `duplicate` | remains 1 |
| Expired capability | `rejected` | 0 |
| Operator halt after issuance | `rejected` | 0 |

Focused command:

```sh
node conformance/second-consumer/verify.mjs
```

The proof output identifies itself as
`frontier.harness.second-consumer-proof.v1` with evidence class
`local_offline_synthetic`, and explicitly records that no external effect or
publication occurred.

Additional regression gates at the same source state:

| Gate | Result |
| --- | --- |
| Harness Kit package suite | PASS, 39/39 tests |
| Adapters package suite | PASS, 21/21 tests |
| Full Node suite | PASS, 98/98 tests; local AVL CLI path supplied explicitly |
| Python protocol suite | PASS, 2/2 tests |
| Strict NodeNext TypeScript consumer | PASS with TypeScript 5.9.3 |
| Standard package chaos corpus | PASS, 14/14 simulated failures |
| Generated consumer snapshot lock | PASS, 10 canonical files match |
| JavaScript syntax checks | PASS |
| Isolated diff/whitespace check | PASS |

## Explicit non-claims

- This is not a live deployment, production gateway, business connector, or
  customer-data test.
- The receipts are unsigned local Harness L3 receipts, not signed AAR L4
  attestations.
- Runtime verifier identity separation does not prove organizational or
  infrastructure independence.
- The proof does not establish network credential isolation, multi-process
  durability, external idempotency, or recovery from ambiguous remote effects.
- Nothing was published, pushed, tagged, deployed, scheduled, or connected to an
  external system.

## Next bounded step

The public surface is sufficient for a second local consumer, so there is no
evidence-backed API gap to widen now. The smallest next evidence increment is an
independent consumer-maintained CI job that pins released tarball digests and
runs this same neutral contract outside the SDK checkout. That step should wait
for explicit release/publishing custody; this increment does not start it.
