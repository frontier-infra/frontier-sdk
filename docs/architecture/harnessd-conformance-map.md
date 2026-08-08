# Harness-kit to Rust `harnessd` conformance map

Status: Frontier Foundation `0.1.0-rc.1` extraction map  
Rust evidence inspected at: `conductor-harness` `497c7de`  
Rust modification performed by this milestone: none

## Purpose

This document maps the public `@frontier-infra/harness-kit` semantics to the
existing private Rust engine used by Journeyman. It is an extraction and
compatibility map, not a claim that the two implementations are equivalent and
not a plan to rewrite the Rust engine.

The public kit is a reusable, proposal-first construction library. `harnessd` is
an existing product engine with operational history. Where the Rust engine is
stronger, Journeyman keeps that behavior. Where semantics differ, the difference
stays explicit until a later deployment milestone proves a safe integration.

## Evidence baseline

The inspected Rust history is:

- `main`: `24cb346` (`w5-done`)
- W6 implementation: `1fee944`, committed and pushed but not tagged `w6-done`
- submit/idempotency branch: `e80fbf9`
- management CLI release commit: `e2bfd64`, target of annotated tag `v0.1.0`
- current installer branch: `497c7de`, one private-release authentication fix
  after the `v0.1.0` artifact

The known 48-hour soak acceptance remains unproven; the recorded analyzer run
failed because of observation gaps during laptop sleep. This map does not turn
implementation history into acceptance evidence.

## Semantic map

| Harness-kit semantic | Existing Rust mechanism | Classification | RC boundary |
| --- | --- | --- | --- |
| Structured proposal before effect | Items produce stored proposals and actions; proposal/action persistence is transactional. | Strong match | Preserve the Rust record model; translate only at a future product boundary. |
| Deterministic fail-closed gate | Pure gate checks kill switch, tool enablement, secret presence, agent/action-family trust, and agent/tool/class permissions; first denial wins. | Strong match | Do not replace with model judgment. |
| Durable state | SQLite schema and migrations persist work, actions, policy, grades, and audit records. | Strong match | SQLite remains the product authority until a separate migration is approved. |
| Idempotent intake | Submit deduplicates on `(agent, idempotency_key)`. | Strong match | Preserve the compound key and its API behavior. |
| Single-winner effect claim | Atomic `proposed -> approved` transition prevents concurrent double execution. | Strong match with crash caveat | A crash after claim can leave an ambiguous `approved` action; do not call this equivalent to the kit's terminal reservation lifecycle. |
| Effect success is grounded | Connector success requires exit code zero and parsed `ok: true`; other outcomes fail. | Strong match | Keep connector result validation deterministic. |
| Operator override | Global kill switch, owner-only one-rung promotion, manager demotion, and a fused-off Autopilot mode. | Strong match | Promotion policy remains product-specific. |
| Human evidence | Append-only human grades and audited mutations. | Partial | Grades are valuable product evidence but are not a verifier-registry attestation. |
| Expiring human exception | Ask-on-miss creates an exact-action approval link with ten-minute TTL and allow-once/always/deny/expire outcomes. | Partial | `allow-once` is the nearest analogue to a capability, but it is not a portable adapter-consumed effect capability. |
| Contract proposal, independent ratification, immutable hash, expiry, revocation | No public role-contract/ratification lifecycle with the same semantics. | Gap | Do not synthesize equivalence from items, roles, or approval UI. |
| Verifier registry, scope, freshness, and numeric trust ceiling | Human users/roles and accumulated grades exist; no separate scoped verifier registry. | Gap | Product evidence cannot mint Frontier authority without an explicit future mapping. |
| One-time scoped expiring capability issued to an opaque adapter | Daemon gates and then invokes a credential/environment-bearing connector subprocess directly. | Material gap | Credentials are outside the model, but non-bypass capability enforcement is not proven. No effect-capability claim is made. |
| Reservation/commit/fail lifecycle with ambiguous outcome isolation | Atomic claim and connector result handling exist, but post-claim crash recovery can remain ambiguous. | Partial/gap | A later deployment must add or prove terminal recovery before equivalence. |
| Budgets and terminal quarantine | No general harness-kit budget/quarantine model was found. | Gap | Do not infer it from retries or failed task status. |
| Hash-linked or signed receipt chain | SQLite audit rows have monotonic sequence, transactional mutation coupling, and result digests; they are not a Frontier receipt chain or signed AAR. | Partial | Keep current audit evidence and label it honestly. |
| Provider, identity, storage, queue, receipt, and alert ports | Runtime-agnostic Submit API, local sessions/roles, SQLite, Telegram notification, and AOS connector conventions exist without the kit's formal port interfaces. | Partial | Do not refactor proven Rust solely for interface symmetry. |
| Read versus effect separation | Reads pass when a tool is enabled; the approval UI skips read actions rather than executing them. | Partial | Read permission never implies mutation permission, but formal context envelopes are future work. |

## Compatibility rules for future adoption

1. The Rust engine remains authoritative for existing Journeyman deployments.
2. A TypeScript package test cannot certify Rust runtime equivalence.
3. No adapter receives an equivalence label until bypass, replay, expiry, crash,
   and ambiguous-result experiments pass against the live boundary.
4. Existing SQLite records are never rewritten merely to resemble the public kit.
5. A future integration may translate contracts, evidence, decisions, and receipts
   at an API boundary; it must not create two competing state authorities.
6. The first live governed effect belongs to the next Conductor milestone, not
   this release candidate.

## RC conclusion

`harnessd` already contains several strong operational analogues, especially its
deterministic gate, durable SQLite state, intake idempotency, atomic effect claim,
operator controls, and grounded connector result handling. It does not currently
implement the public kit's complete contract/ratification, verifier-registry,
capability, reservation-recovery, budget/quarantine, or receipt semantics.

Therefore the correct RC claim is **mapped, not integrated**. No Rust code was
changed and no live effect conformance was claimed.
