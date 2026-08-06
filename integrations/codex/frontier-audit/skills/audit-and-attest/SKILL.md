---
name: audit-and-attest
description: Bootstrap and run the installable Frontier Audit SDK for repository or harness audits, with mandatory local SDK inspection, explicit install authorization, version/provenance verification, and SDK-owned audit/attestation execution.
---

# Audit and attest

Use this skill to adopt `@frontier-infra/audit`, not to redefine Frontier Audit scoring, AAR receipts, or conformance semantics. The SDK owns audit logic and attestation output; this plugin owns safe local bootstrap and operator flow.

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

4. If the SDK is missing, wrong-versioned, or provenance is unverified, explain the exact package, version, bundled artifact path, SHA-256, install location, and target repository from the inspector output. Ask for explicit authorization to install `@frontier-infra/audit@0.1.0-rc.1` from the pinned bundled source in `assets/sdk-lock.json`.

5. Until `assets/sdk-lock.json` contains published registry integrity, do not perform registry installs. After approval, use the bundled artifact by default, then verify and resume the audit in one command:

```sh
node "$PLUGIN_ROOT/scripts/bootstrap-sdk.mjs" ensure-run \
  --project-root "$TARGET_REPO" \
  --approve-install \
  -- <sdk audit arguments>
```

6. Use `--tarball /absolute/path/to/frontier-audit-0.1.0-rc.1.tgz --expected-sha256 <sha256>` only as an explicit override. Use `--source registry` only to test or intentionally select the registry lane; it remains blocked while published integrity is null. Use `--location project` only when the user explicitly requests a project-local SDK install; it installs under `.frontier-audit/sdk-install`, not the repository root. The default is the platform cache, outside the target repository.

## Authorization and execution rules

1. Never install on `inspect`; it is read-only and must not use the network.
2. Never install without explicit user approval for the pinned package/version/source/location.
3. Never hand back commands when running in Codex with shell access; execute the approved bootstrap and continue the audit.
4. In ChatGPT without shell access, explain the same inspection/install/resume sequence or use a future trusted MCP if one exists.
5. Do not accept signing key content in chat or flags. Accept only an existing local key path. Pass it to the SDK as `--sign-key <path>`. If no key path is supplied, report unsigned attestation as `NOT_RUN`; that is not a bootstrap failure.
6. Do not treat unsigned as failed unless the user or audit policy requires a signature.

## Bundled resources

1. `scripts/bootstrap-sdk.mjs` performs inspect, install, resolve, and run behavior.
2. `assets/sdk-lock.json` pins the release-candidate SDK coordinates, bundled artifact path/SHA, and records that published registry integrity is not yet claimed.
