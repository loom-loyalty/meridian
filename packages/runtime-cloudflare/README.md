# @loom-loyalty/meridian-runtime-cloudflare

Cloudflare Workers + Durable Objects reference runtime for the
[Meridian protocol](../../specs/core/RUNTIME-SPEC.md).

## Status

**Pre-alpha, v0.1 development.** All six stable runtime primitives
(lifecycle, state, scheduling, transport, resources, observability)
are implemented and covered by an in-package conformance suite that
runs against both Miniflare and the in-memory `createTestRuntime()`.
Real-CF E2E runs ~70% green today — known flake classes tracked in
the workflow; a subset of scenarios skip on real-CF where they
require external orchestration (hibernation-replay, long-offline cron
coalescing).

Auth + admin + WebSocket transport + AgentCard `securitySchemes` land
in M4. Until then, **do not expose a deployed worker publicly** — put
it behind Cloudflare Access, an IP allowlist, or keep its URL
private.

## Install

```bash
pnpm add @loom-loyalty/meridian-runtime-cloudflare @loom-loyalty/meridian-types
```

## Minimum viable worker

```ts
// src/worker.ts
import {
  createMeridianWorker,
  defineAgent,
  AgentDurableObject,
  RegistryDurableObject,
} from "@loom-loyalty/meridian-runtime-cloudflare";

const monitor = defineAgent({
  id: "pg-query-optimizer-prod",
  domain: "infrastructure",
  async onSpawn(ctx) {
    await ctx.state.save("started-at", Date.now());
    // Kick off a periodic check.
    await ctx.schedule.cron("*/15 * * * *");
  },
  async onSchedule(ctx) {
    // Your scheduled work here — read Postgres, emit feedback, etc.
  },
});

export default createMeridianWorker({
  agents: [monitor],
  agentCard: {
    name: "infra-monitoring",
    description: "Meridian runtime for infrastructure monitoring agents",
  },
});

// Re-export DO classes so wrangler can bind them.
export { AgentDurableObject, RegistryDurableObject };
```

```toml
# wrangler.toml (see wrangler.toml.example for the full template)
name = "infra-monitoring"
main = "src/worker.ts"
compatibility_date = "2024-11-06"
compatibility_flags = ["nodejs_compat"]

[[durable_objects.bindings]]
name = "AGENT"
class_name = "AgentDurableObject"

[[durable_objects.bindings]]
name = "REGISTRY"
class_name = "RegistryDurableObject"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["AgentDurableObject", "RegistryDurableObject"]

[observability]
enabled = true
head_sampling_rate = 1.0
```

## HTTP surface exposed by `createMeridianWorker`

| Method | Path                           | Purpose                                                |
| ------ | ------------------------------ | ------------------------------------------------------ |
| GET    | `/`                            | Health check                                           |
| GET    | `/.well-known/agent-card.json` | A2A-shaped discovery (empty `securitySchemes` in v0.1) |
| POST   | `/agents/:id/spawn`            | `{domain}` → AgentHandle                               |
| GET    | `/agents/:id`                  | AgentHandle                                            |
| DELETE | `/agents/:id`                  | Terminate (204)                                        |
| POST   | `/agents/:id/messages`         | `{to, payload: base64}` → MessageReceipt               |
| POST   | `/agents/:id/broadcast`        | `{selector?, payload: base64}` → BroadcastReceipt      |
| GET    | `/agents/:id/inbox`            | Snapshot (does not clear)                              |
| POST   | `/agents/:id/inbox/drain`      | Pull-and-clear                                         |

Message payloads are `Uint8Array` on the wire protocol; the HTTP
surface base64-encodes them in JSON bodies / responses. Every `MRD-CF-*`
error surfaces as a JSON `{error: {code, category, message, retryable,
docUrl}}` with the matching HTTP status.

### Custom routes

Pass `config.routes` to add or shadow routes — useful for
monitoring endpoints or pre-M4 auth wrappers:

```ts
createMeridianWorker({
  agents: [monitor],
  routes: {
    "GET /healthz": (req, env) => new Response("ok"),
  },
});
```

## Adopter unit tests — `createTestRuntime()`

The in-memory runtime implements the same primitive contract as the
CF adapter. Adopter unit tests exercise agent hooks + business logic
with millisecond setup, no Miniflare boot:

```ts
import { createTestRuntime } from "@loom-loyalty/meridian-runtime-cloudflare/testing";

it("my agent emits feedback on schedule", async () => {
  const rt = createTestRuntime();
  const agent = rt.agent("my-agent");
  await agent.spawn({ id: "my-agent", domain: "test" });
  // ...
});
```

CI runs the conformance suite against both the Miniflare-backed
adapter and `createTestRuntime()` — divergence is a red build, so
adopters can trust that passing locally means passing on CF.

## License

Apache 2.0.
