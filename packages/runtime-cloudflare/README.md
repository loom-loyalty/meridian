# @loom-loyalty/meridian-runtime-cloudflare

Cloudflare Workers + Durable Objects reference runtime for the
[Meridian protocol](../../specs/core/RUNTIME-SPEC.md).

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/loom-loyalty/meridian/tree/main/examples/cf-hyperdrive-postgres)

One-click deploy drops the `cf-hyperdrive-postgres` example onto
your account. After the deploy lands, follow
[DEPLOY.md](../../examples/cf-hyperdrive-postgres/DEPLOY.md) for the
Hyperdrive + Postgres binding setup (~5 minutes). For a bare-minimum
scaffold without Postgres, run `pnpm dlx @loom-loyalty/meridian-cli init`
instead.

## Status

**v0.1, pre-1.0.** All six stable runtime primitives (lifecycle,
state, scheduling, transport, resources, observability) are
implemented, covered by the conformance suite, and verified on real
Cloudflare Workers by the [E2E (Cloudflare) workflow](../../.github/workflows/e2e-cloudflare.yml)
on every push to `main`.

M4 shipped: bearer auth, `/admin/*` routes, AgentCard `securitySchemes`,
the `meridian` CLI. M6 shipped: opt-in multi-tenancy hooks (see
[Tenancy](#tenancy) below).

Adopters who deploy without configuring `auth: { bearer }` or a
reverse proxy should keep the worker URL private or put it behind
Cloudflare Access.

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

## Tenancy

Multi-tenancy is opt-in. When `createMeridianWorker` is called
without a `tenancy` config, the worker runs single-tenant — all
agents share one global namespace, matching pre-M6 behavior. When
`tenancy.authorizer` is set, every request is mapped to a `tenantId`
and the runtime scopes storage + listings per tenant.

```ts
import {
  createMeridianWorker,
  type TenantAuthorizer,
} from "@loom-loyalty/meridian-runtime-cloudflare";

class JwtTenantAuthorizer implements TenantAuthorizer {
  async resolveTenantId(req: Request): Promise<string> {
    const token = req.headers.get("authorization")?.replace(/^Bearer /i, "");
    const { tid } = await verifyJwt(token);
    return tid;
  }
}

export default createMeridianWorker({
  agents: [...],
  tenancy: { authorizer: new JwtTenantAuthorizer() },
});
```

### Server-enforced isolation invariants (when tenancy is on)

1. **DO namespacing.** `env.AGENT.idFromName("${tenantId}::${agentId}")`
   — same `agentId` under two tenants maps to two distinct DOs with
   their own SQLite storage, alarm schedules, and inbox state.
2. **Registry scoping.** Each tenant gets its own `RegistryDurableObject`
   shard keyed `${tenantId}::default`. `registry.list()` returns
   zero cross-tenant leakage by construction.
3. **Cross-agent send containment.** When agent A sends to "B", the
   target DO is resolved under A's own `tenantId` (stored in meta at
   spawn). Sending into another tenant's namespace is impossible
   from adopter code.
4. **Broadcast containment.** Same as (2) — broadcasts query the
   sender's tenant-scoped registry and fan out only to agents
   registered there.
5. **Admin route scoping.** `GET /admin/domains` + `GET /admin/agents/:id`
   resolve `tenantId` via the authorizer before reading. A
   tenant-B caller asking about tenant-A's agent gets 404
   `MRD-CF-LC-002`.
6. **Spawn body cannot spoof tenant.** The worker forces the
   authorizer-resolved `tenantId` onto the spawn config; any value
   an adopter tries to stuff into the request body is ignored.
7. **Handle carries `tenantId`.** Multi-tenant `AgentHandle` responses
   include `tenantId`. Single-tenant handles omit it.

### Out of scope for v0.1

These belong to multi-tenant operators (Shuttle and similar) and are
intentionally NOT in the reference runtime:

- Tenant provisioning flow (who creates a tenant, how billing
  activates)
- Cross-region routing
- Spawn-bomb rate limiting per tenant
- Tenant-level backup/export
- Aggregate `TenantLimits.maxCostUsd` caps across agents
  (per-agent `ResourceLimits` already enforced; tenant aggregation
  lands in v0.1.5)

### Hyperdrive caveat

If multi-tenant agents share a single Hyperdrive binding, they
share connection pool state. For strict per-tenant isolation on the
DB side, provision a Hyperdrive per tenant or gate DB access through
a per-tenant credential broker (see `packages/integration-proxy`
roadmap entry).

## License

Apache 2.0.
