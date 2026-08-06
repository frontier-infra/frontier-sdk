# Frontier Audit Plugin Evals

These evals are the marketplace-reviewer evidence set for the `frontier-audit` plugin. They prove the plugin is an adoption/bootstrap layer for the pinned `@frontier-infra/audit` SDK, not a prompt-only explanation that leaves the user with commands.

Run from the plugin root:

```sh
node evals/run-evals.mjs
```

The runner writes all temporary installs, SDK tarballs, keys, and evidence packets under a temporary output directory. Set `FRONTIER_AUDIT_EVAL_OUT=/absolute/path` to keep the report and generated artifacts. The default SDK source is the bundled artifact pinned in `assets/sdk-lock.json`; local tarball inputs remain available as explicit overrides.

The sanitized, distribution-safe result from the release-candidate run is recorded at
`evals/results/reviewer-results.json`. It omits private keys, transient absolute paths, and temporary
artifacts while retaining the tested artifact hash, canonical commits, per-case verdicts, and claim
boundary.

## Case Coverage

1. `skill_activation_contract` verifies that the skill metadata and instructions activate `audit-and-attest`, run SDK inspection first, and resume through `run` or `ensure-run`.
2. `arbitrary_cwd_keeps_target_repo_separate` verifies that the bundled bootstrap can run from any cwd while keeping the audited repo explicit.
3. `missing_sdk_reports_install_action` verifies that a missing SDK returns a precise bundled artifact install action instead of a generic failure.
4. `install_requires_explicit_authorization` verifies that SDK installation is blocked without explicit operator approval.
5. `approved_local_tarball_installs_and_records_provenance` verifies that an approved local tarball install records provenance and resolves as ready.
6. `ensure_run_installs_and_executes_sdk` verifies that the agent can install and continue the original SDK command in one flow.
7. `tarball_hash_mismatch_blocks_install` verifies supply-chain fail-closed behavior for mismatched tarball hashes.
8. `registry_blocked_when_integrity_null` verifies that registry installs are blocked until the SDK lock pins published integrity.
9. `inline_signing_key_rejected` verifies that signing key material cannot be supplied inline, including after `--`.
10. `successful_signed_audit_verifies` installs the bundled SDK, runs a signed audit against a portable Git fixture, and verifies the detached AAR offline.
11. `static_audit_does_not_claim_machine_l3` verifies the generated evidence remains honest: `full_conformance_claimed=false`, `live_checks_executed=false`, and live checks remain `NOT_RUN`.

## Real SDK Inputs

The signed-audit eval is portable. It uses the pinned SDK tarball bundled with the plugin, creates a
temporary Git-backed Machine-L2 fixture, and generates a disposable Ed25519 JWK/DID pair locally.
It does not depend on sibling Frontier Infra repositories or network access. Use
`FRONTIER_AUDIT_SDK_REPO` only to test a freshly packed SDK checkout instead of the bundled release
artifact.

Override these with:

```sh
FRONTIER_AUDIT_SDK_REPO=/path/to/frontier-sdk \
FRONTIER_AUDIT_TARGET_REPO=/path/to/a/git/repo \
node evals/run-evals.mjs
```

To test an already-built package, use:

```sh
FRONTIER_AUDIT_SDK_TARBALL=/path/to/frontier-infra-audit-0.1.0-rc.1.tgz \
FRONTIER_AUDIT_SDK_SHA256=<sha256> \
node evals/run-evals.mjs
```
