---
name: audit-and-attest
description: Score and attest a repository or AI harness with the deterministic Frontier Audit SDK. Use when Codex is asked to audit governance, check Frontier or Machine conformance, produce evidence, issue or verify an AAR receipt, or compare a harness against pinned scoring rules. Inspect and safely obtain the exact SDK before running it.
---

# Audit and attest

Run `@frontier-infra/audit`; do not recreate its scoring logic in Markdown. The versioned SDK owns audit semantics and attestation output. This plugin owns safe local bootstrap and operator flow.

## Mandatory workflow

1. Resolve the installed plugin root from this `SKILL.md` file, and keep the target repository separate. Do not assume the current working directory is the plugin root.

```sh
SKILL_MD="/absolute/path/to/frontier-audit/skills/audit-and-attest/SKILL.md"
PLUGIN_ROOT="$(cd "$(dirname "$SKILL_MD")/../.." && pwd)"
TARGET_REPO="$(pwd)"
```

2. Run the bundled inspector first with an absolute bootstrap path:

```sh
node "$PLUGIN_ROOT/scripts/bootstrap-sdk.mjs" inspect --project-root "$TARGET_REPO" --json
```

3. If the SDK is `ready`, immediately resume the original audit by running:

```sh
node "$PLUGIN_ROOT/scripts/bootstrap-sdk.mjs" run --project-root "$TARGET_REPO" -- <sdk audit arguments>
```

4. If the SDK is missing, wrong-versioned, or its integrity chain is unverified, explain the exact package, version, bundled artifact path, SHA-256, install location, target repository, selected trust-anchor root, assurance level, and publisher-authenticity status from the inspector output. Ask for explicit authorization to install `@frontier-infra/audit@0.1.0-rc.2` from the pinned bundled source in `assets/sdk-lock.json`.

5. Until `assets/sdk-lock.json` contains published registry integrity, do not perform registry installs. After approval, use the bundled artifact by default, then verify and resume the audit in one command:

```sh
node "$PLUGIN_ROOT/scripts/bootstrap-sdk.mjs" ensure-run \
  --project-root "$TARGET_REPO" \
  --approve-install \
  -- <sdk audit arguments>
```

6. Use `--tarball /absolute/path/to/frontier-audit-0.1.0-rc.2.tgz --expected-sha256 <sha256>` only as an explicit override. Use `--source registry` only to test or intentionally select the registry lane; it remains blocked while published integrity and publisher provenance are null. Use `--location project` only when the user explicitly requests a project-local SDK install; it installs under `.frontier-audit/sdk-install`, not the repository root. The default is the platform cache, outside the target repository.

## Authorization and execution rules

1. Never install on `inspect`; it is read-only and must not use the network.
2. Never install without explicit user approval for the pinned package/version/source/location.
3. Never hand back commands when running in Codex with shell access; execute the approved bootstrap and continue the audit.
4. In ChatGPT without shell access, explain the same inspection/install/resume sequence or use a future trusted MCP if one exists.
5. Do not accept signing key content in chat or flags. Accept only an existing local key path. Pass it to the SDK as `--sign-key <path>`. If no key path is supplied, report unsigned attestation as `NOT_RUN`; that is not a bootstrap failure.
6. Do not treat unsigned as failed unless the user or audit policy requires a signature.

## Receipt and trust reporting

1. Report the exact `verifier.model` and `verifier.policy_sha256` from a signed AAR so the scoring procedure is comparable over time.
2. Call `verifier.id != subject` **structural verifier separation**, never organizational independence.
3. Report `verifier.independence` separately. The default `same_principal` is an organizational attestation and is not third-party audit-grade. A deterministic scorer, separate process, or separate key does not change that fact.
4. Use `--verifier-independence separate_principal|third_party` only when the signing operator explicitly supplies that relationship, the audited `--subject` DID, and its `--principal` DID. The SDK requires the principal to differ from the verifier DID. Treat the result as a signed disclosure evaluated by consumer policy, not as independently proven ownership.
5. For bundled installs, say the trust root is the operator-approved plugin distribution and the bootstrap proves an integrity chain from lock to tarball to installed tree. Also say publisher authenticity is `NOT_VERIFIED_BY_BOOTSTRAP`.
6. Do not use the unqualified phrase “provenance verified.” Name the exact integrity or identity assertion that passed.

## Bundled resources

1. `scripts/bootstrap-sdk.mjs` performs inspect, install, resolve, and run behavior.
2. `assets/sdk-lock.json` pins the release-candidate SDK coordinates, bundled artifact path/SHA, and the explicit bundle, local-tarball, and future registry trust anchors.
