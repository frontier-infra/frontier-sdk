# frontier-audit (Codex plugin)

Score a repository against The Machine's conformance kit and optionally issue a
signed AAR evidence receipt.

One skill: `audit-and-attest`. It runs the published `@frontier-infra/audit`
CLI via `npx` — no bundled tarball, no bootstrap. The evidence packet records
the exact CLI version that produced it. Canonical CLI source:
`frontier-sdk/packages/typescript/audit`.

Requirements: Node >= 20, Python 3 (for The Machine static kit).

MIT.
