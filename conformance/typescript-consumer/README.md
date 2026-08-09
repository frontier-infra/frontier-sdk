# TypeScript Consumer Conformance

Strict external TypeScript coverage for the public package boundaries:

- `@frontier-infra/protocol`
- `@frontier-infra/harness-kit`
- `@frontier-infra/harness-kit/chaos-fixtures`
- `@frontier-infra/adapters`
- `@frontier-infra/governance-react`
- `@frontier-infra/create-frontier-app`
- `@frontier-infra/audit`

The verifier packs all six packages, installs only those tarballs into a fresh
temporary consumer, and runs a pinned strict compiler against every supported
public import:

```bash
npm test
```
