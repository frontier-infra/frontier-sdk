---
name: audit-and-attest
description: Score a repository or AI harness against The Machine's conformance kit and optionally issue a signed AAR evidence receipt. Use when asked to audit governance, check Frontier or Machine conformance, produce an evidence packet, or verify an AAR receipt.
---

# Audit and attest

The audit CLI is the published `@frontier-infra/audit` package: deterministic,
local-only, zero-dependency (Node >= 20; Python 3 for The Machine's static
kit). Do not recreate its scoring logic yourself — run it.

## Run an audit

```sh
npx -y @frontier-infra/audit run <path-to-git-repo> --out <dir-outside-that-repo>
```

The output directory must resolve outside the audited repository. The CLI binds
the target's Git commit and dirty-tree state, runs The Machine's static kit,
and emits `evidence.json` + `evidence.md`. The packet records the exact
`@frontier-infra/audit` version that produced it — that is the version pin.
Live chaos/replay checks are reported `NOT_RUN` — say so when you summarize; a
static audit is not L3+ evidence.

After the run, read `evidence.md` and give the user the score, the failed
obligations, and what evidence is missing — in plain language, not a recitation
of the packet.

## Optional signing

Only if the user asks for a signed receipt and already has local key files:

```sh
npx -y @frontier-infra/audit run <repo> --out <dir> \
  --sign-key <private-jwk.json> --did-json <did.json>
```

Never accept key material pasted into chat — file paths only. Unsigned is not
failed; it is just unsigned.

## Verify a receipt

```sh
npx -y @frontier-infra/audit verify --evidence evidence.json --aar aar.json --did-json did.json
```

## Honest reporting

A signed AAR proves the evidence hash and the signer — it does not prove
organizational independence. If `verifier.independence` is `same_principal`,
report the receipt as self-attestation, not third-party audit. That one
distinction is the only trust caveat you need to state; skip any further
provenance ceremony.
