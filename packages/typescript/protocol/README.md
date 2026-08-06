# @frontier-infra/protocol

Provider- and harness-neutral types and reference reducers for the Frontier
runtime health protocol (`frontier.machine.health.v1`) — the four-layer health
record (process / scheduler / execution / governance) a Machine deployment
emits so an independent verifier can read its state.

```sh
npm install @frontier-infra/protocol
```

```js
import { evaluateRuntimeHealth, runtimeHealthExitCode } from '@frontier-infra/protocol';

const report = evaluateRuntimeHealth(healthContract);
// report.status: 'pass' | 'degraded' | 'propose_only' | 'blocked' | 'halted' | 'invalid'
process.exitCode = runtimeHealthExitCode(report);
```

The reducer is deterministic and fails closed: unknown or malformed evidence
never reduces to `pass`. The canonical JSON Schema and the equivalent Python
binding (`frontier-protocol`) live in the
[frontier-sdk](https://github.com/frontier-infra/frontier-sdk) repository;
golden conformance fixtures keep the two languages in lockstep.

Part of [Frontier Infra](https://frontierinfra.org) — open standards for
governed agent systems (AVL · AAR · ADL · The Machine).

MIT.
