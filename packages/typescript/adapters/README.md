# @frontier-infra/adapters

Dependency-injected adapter ports for Frontier harness deployments.

This package deliberately ships no provider SDK dependencies. Network providers accept a
`fetch` implementation, storage ports accept existing clients, and effect connectors accept
business clients plus an `execute` callback. Secrets stay in closures or injected clients and
are redacted from adapter errors.

## Proposal-Only Providers

```js
import { createOpenAICompatibleAdapter } from '@frontier-infra/adapters';

const model = createOpenAICompatibleAdapter({
  baseUrl: 'https://api.openai.com',
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-5',
  mode: 'responses',
});

const proposals = await model.propose({ prompt: 'Return JSON: {"proposals":[...]}' });
```

Supported proposal ports:

1. `createOpenAICompatibleAdapter` for OpenAI-compatible `/v1/responses` and
   `/v1/chat/completions` endpoints. Remote endpoints must be HTTPS. Local HTTP is allowed only
   when explicitly enabled and the host is localhost.
2. `createAnthropicMessagesAdapter` for Anthropic `/v1/messages`.
3. `createLocalOpenAICompatibleAdapter` for localhost OpenAI-compatible runtimes.
4. `createBrowserWorkerProposalPort` for browser or worker sandboxes.

These ports only expose `propose`. They never expose mutation methods.

## Capability-Gated Connectors

```js
import { createGatedBusinessConnector } from '@frontier-infra/adapters';
import { HarnessEngine } from '@frontier-infra/harness-kit';

const connector = createGatedBusinessConnector({
  id: 'crm-update',
  effect: 'crm.contact.update',
  scopes: ['workspace:alpha'],
  client: crmClient,
  async execute({ client, proposal, signal }) {
    return client.updateContact(proposal.payload, { signal });
  },
});

const harness = new HarnessEngine({
  deployment_id: 'frontier-harness',
  goal,
  worker,
  verifiers,
  adapters: [connector],
});

await harness.executeCapability({ proposal, capability, adapter_id: connector.id });
```

The connector has no public `apply`, `execute`, or `mutate` method. It is an opaque adapter
descriptor registered with `@frontier-infra/harness-kit`; the harness privately reserves a
one-time capability, calls the connector executor from its private registry, then completes or
fails the reservation. Missing, expired, wrong-scope, replayed, forged, or unregistered
capabilities fail before the business client is called. If the business call or completion
receipt fails after reservation, the harness returns an ambiguous outcome rather than recording a
false committed effect.

Operational alert delivery uses the same physical gate:

```js
import {
  createOperationalAlertConnector,
  operationalAlertIdempotencyKey,
} from '@frontier-infra/adapters';

const payload = { severity: 'warning', message: 'Queue depth is high', context: { depth: 42 } };
const proposal = {
  effect: 'operations.alert.deliver',
  scope: 'workspace:alpha',
  payload,
  idempotency_key: operationalAlertIdempotencyKey({ scope: 'workspace:alpha', payload }),
};

const alerts = createOperationalAlertConnector({
  scopes: ['workspace:alpha'],
  client: alertClient,
  async deliver({ client, alert, idempotency_key, signal }) {
    return client.publish(alert, { idempotencyKey: idempotency_key, signal });
  },
});
```

`createOperationalAlertConnector` returns only an opaque harness adapter. It exposes no public
`send`, `deliver`, `execute`, or `apply`; only `HarnessEngine.executeCapability` can reach the
private delivery closure after validating an issued, unexpired, one-time capability for the exact
effect and scope. Severity is normalized to `info`, `warning`, or `critical`; message/context size
limits fail closed; common credential material is redacted before delivery; and the canonical
idempotency helper binds normalized content to effect and scope.

## Storage And Identity Ports

Storage ports are dependency-injected interfaces, not SDK wrappers:

1. `createPostgresStatePort({ client })` expects `client.query`.
2. `createRedisQueuePort({ client })` expects `client.sendCommand` or `client.command`. Enqueue
   returns the idempotency key as the stable queue item `id`; `ack(queue, id)` atomically finds
   and removes that serialized envelope and returns `{ ok: false }` when it is absent.
3. `createS3ReceiptEvidenceSink({ client })` (also exported under the compatibility name
   `createS3EvidenceReceiptPort`) expects `client.putObject` or `client.send` and implements the
   explicit `ReceiptEvidenceSink.putReceipt(...)` port.
   Evidence bytes are preserved exactly. String and byte inputs must decode as valid UTF-8 JSON;
   all input shapes are inspected for forbidden raw secret fields before writing. The port adds
   SHA-256 metadata/checksum fields without mutating the receipt body.

Identity helpers normalize common claim shapes from Clerk, Auth0, and WorkOS into
`{ provider, subject, email, email_verified, organization_id, roles }`. The exported examples
are illustrative only and contain no secrets.

## Boundaries

All remote model endpoints must be HTTPS. Only localhost HTTP is permitted for local model
adapters. All provider calls accept `AbortSignal`, enforce timeouts, enforce response/proposal
size caps, and fail closed on malformed output or storage errors.

MIT.
