# Frontier Audit for Codex

Frontier Audit is the Codex adoption layer for the installable `@frontier-infra/audit` SDK. It
turns requests such as “audit and attest this repository” into an executable, evidence-producing
workflow instead of returning a list of commands.

## How Codex knows to obtain the SDK

Codex discovers the `audit-and-attest` skill from the plugin manifest and matches its description
to repository audit, conformance, and attestation requests. The skill requires a bootstrap check
before any audit:

1. Inspect the durable Frontier Audit cache without network access.
2. If the exact locked SDK is ready and its installed files match the recorded manifest, run it.
3. Otherwise, show the package, version, bundled artifact path, SHA-256, install location, and target repository.
4. Obtain explicit approval before installing executable SDK code.
5. Verify the artifact and installed package, then resume the original audit in the same command.

The target repository is never used as the default install location. Project-local installation is
available only when the operator explicitly selects it, and even then the SDK is confined to
`.frontier-audit/sdk-install` inside the target repository.

The default SDK source is the bundled audited artifact
`assets/frontier-infra-audit-0.1.0-rc.2.tgz`, pinned in `assets/sdk-lock.json` with SHA-256
`ee9955d2ab3d9f4267937ce029a2e4a403cbd21c3604e23e2cfd07f73dfd95ce`. Registry installation is
available only through the explicit `--source registry` lane and remains blocked until the lock pins
published integrity and publisher provenance.

For this release-candidate bundle, the trust root is the exact installed plugin distribution the
operator approved. The bootstrap verifies the lock, SDK tarball, and installed package tree. The
SDK then verifies its scorer/AAR snapshot lock. This is an integrity chain; publisher authenticity
is `NOT_VERIFIED_BY_BOOTSTRAP`. The plugin does not use the vague phrase “provenance verified” as a
substitute for naming that boundary.

## What the executable path proves

The SDK binds evidence to the target Git commit and dirty-tree state, runs the canonical The Machine
static kit, emits JSON and Markdown evidence, and can sign the evidence commitment with an
operator-provided local key path. It immediately performs offline cryptographic verification using
the supplied DID document.

This does **not** prove Machine-L3. Live chaos, replay, recovery, and operator-path rows remain
`NOT_RUN` until they are executed against a real deployment. The signature proves integrity and
authorship of the recorded claim; organizational independence is a separate property.

The receipt stamps the exact SDK version and scorer-policy SHA-256. AAR L2 means
`verifier.id != subject`: structural verifier separation. The separately signed
`verifier.independence` field defaults to `same_principal`, so the normal local path is an
organizational attestation, not third-party audit-grade. Deterministic scoring makes receipts
comparable; it does not create a separate owner.

## Product boundary

- The Machine owns conformance semantics.
- Agents Control Plane owns AAR signing and verification semantics.
- `@frontier-infra/audit` owns the executable local audit packet.
- This plugin owns Codex skill activation, safe SDK bootstrap, and adoption guidance.

The SDK is model- and harness-agnostic. The Codex plugin is one adapter over that SDK, not its
canonical implementation.

## Development verification

```bash
npm run validate
```

The validator checks the plugin manifest and bootstrap contract; the tests exercise authorization,
provenance, cache integrity, install-and-resume behavior, and signing-key boundaries.
