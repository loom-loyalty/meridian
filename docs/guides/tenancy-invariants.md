# Tenancy invariants

Multi-tenancy is opt-in. When `createMeridianWorker({tenancy})` is
configured, the runtime enforces seven isolation guarantees on every
server-side operation. This page is the full list — if tenancy is
on and something leaks, one of these is broken and it's a bug.

## Turning it on

```ts
import {
  createMeridianWorker,
  type TenantAuthorizer,
} from "@loom-loyalty/meridian-runtime-cloudflare";

class JwtTenantAuthorizer implements TenantAuthorizer {
  async resolveTenantId(req: Request): Promise<string> {
    const token = req.headers.get("authorization")
      ?.replace(/^Bearer /i, "");
    const { tid } = await verifyJwt(token);
    return tid;
  }
}

export default createMeridianWorker({
  agents: [...],
  auth: { bearer: env.MERIDIAN_SIGNING_KEY },
  tenancy: { authorizer: new JwtTenantAuthorizer() },
});
```

Single-tenant deploys leave `tenancy` undefined. Everything below
applies only when it's set.

## The invariants

### 1. DO namespacing — `env.AGENT.idFromName(`${tenantId}::${agentId}`)`

Same `agentId` under two tenants maps to two distinct Durable
Objects with their own SQLite storage, alarm schedules, and mailbox.

**Contract test:** `test/tenancy.test.ts` → "same agent id under two
tenants maps to distinct DOs".

**What you can rely on:** state writes in tenant-A's `hello` can
never appear in tenant-B's `hello`. The isolation is at the CF DO
level, not a Meridian-enforced prefix — we inherit Cloudflare's
per-DO storage guarantee.

### 2. Registry scoping — `env.REGISTRY.idFromName(`${tenantId}::default`)`

Each tenant gets its own `RegistryDurableObject` shard. `registry.list()`
returns only agents in the caller's tenant.

**Contract test:** `test/tenancy.test.ts` → "admin/domains only lists
the caller's tenant agents".

**What you can rely on:** `GET /admin/domains` with tenant-A's auth
will never return tenant-B's agent ids — even when both tenants have
the same agent id registered.

### 3. Cross-agent send containment

When agent A in tenant X calls `ctx.transport.send("B", payload)`,
the target DO resolves to tenant X's B, never another tenant's B.
The sender's tenantId comes from its own meta (stored at spawn);
adopter code never touches it directly.

**Contract:** `src/primitives/cf-transport.ts` → `scopedAgentName`
uses `getTenantId()` which reads the sender's meta.

**What you can rely on:** agents CANNOT address other tenants' agents
from adopter code. Even if an agent knows another tenant's id,
`send("B")` lands on its own tenant's B (or a non-existent DO).

### 4. Broadcast containment

`ctx.transport.broadcast(selector, payload)` queries only the
sender's tenant-scoped registry shard. Fan-out is bounded by that
shard; zero cross-tenant delivery.

**Contract test:** `test/tenancy.test.ts` implicitly covers this
via registry isolation; in-flight broadcast tests run under the
same tenant.

### 5. Admin route scoping

`/admin/*` routes call `tenancy.authorizer.resolveTenantId(req)`
before any registry / DO access. Every admin handler operates in
the caller's tenant.

- `GET /admin/domains` — tenant-scoped list
- `GET /admin/agents/:id` — tenant-scoped inspect; cross-tenant
  access returns 404 `MRD-CF-LC-002` (the DO simply doesn't exist
  under this tenant's namespace)

**Contract test:** `test/tenancy.test.ts` →
"admin/agents/:id cross-tenant lookup returns 404 MRD-CF-LC-002".

### 6. Spawn body cannot spoof tenant

When a tenant-A caller POSTs to `/agents/hello/spawn`, the worker
FORCES the spawn config's `tenantId` to `"tenant-a"` regardless of
what the request body says. Even if an adopter sends
`{domain: "demo", tenantId: "tenant-b"}`, the authorizer-resolved
value wins.

**Contract:** `src/create-meridian-worker.ts` →
`spawnConfig.tenantId = tenant.tenantId` after body parse.

**What you can rely on:** HTTP clients can't write into another
tenant's namespace via spoofed body fields.

### 7. `AgentHandle.tenantId` is surfaced

Every handle response from a tenant-aware worker includes
`tenantId`. Clients can confirm which tenant they just operated on
without re-checking the request.

Single-tenant handles omit the field — matches the pre-M6 shape so
existing adopters see no type change.

## What's NOT in v0.1

Deliberate scope gaps. Shipping these was deferred to keep M6
shippable:

### Aggregate `TenantLimits`

Per-agent `ResourceLimits` (maxTokensTotal, maxCostUsd) already
enforce on every DO. A tenant-wide aggregate cap — "tenant-A can't
spend more than $X across all its agents combined" — lands in
v0.1.5 as `TenantLimits.maxCostUsd`.

**Workaround (v0.1):** Adopters wanting aggregate caps implement
them externally — query `GET /admin/agents/:id` per agent, sum
`usage.current.costUsdLifetime`, gate spawn via the
`TenantAuthorizer`.

### Analytics Engine `tenant_id` dimension

Metrics emitted via `ctx.obs.metric(name, value, tags)` don't auto-
tag `tenant_id` yet. Adopters can pass `tenantId` explicitly in the
`tags` arg if they need it in Analytics Engine.

Lands in v0.1.5 alongside the `AuthPlugin` interface.

### Hyperdrive per-tenant credentials

If multi-tenant agents share a single Hyperdrive binding, they share
the connection pool. For strict per-tenant DB isolation:

- Provision a Hyperdrive per tenant (requires adopter-side
  plumbing, see [Cloudflare Hyperdrive docs](https://developers.cloudflare.com/hyperdrive/))
- Or use the forthcoming `integration-proxy` for per-tenant
  credential brokering (roadmap entry)

### Cross-region routing, tenant provisioning, spawn-bomb rate

limiting, tenant-level backup/export

Multi-tenant operator concerns (Shuttle and similar). Meridian
runtime doesn't dictate how you provision tenants; that lives in
the operator's control plane.

## Operational debugging

**"tenant-B got a 404 trying to inspect tenant-A's agent"**
Working as intended. Cross-tenant inspect returns `MRD-CF-LC-002`
because the DO under tenant-B's namespace was never spawned.

**"my `send()` went to a DO that doesn't exist"**
Confirm the agent was spawned in the sender's tenant. If A sends to
"B" and B was only spawned under tenant-C, A's send resolves to
tenant-A's B, which is unspawned → `MRD-CF-LC-002` from the deliver.

**"registry.list() is empty for tenant-X but I just spawned agents"**
Check the authorizer — is `resolveTenantId(req)` returning a stable
value? If the token claim is missing or the JWT validation failed
silently, your request fell through to a different (empty) shard.

## Migration from single-tenant

If an existing single-tenant deploy needs to migrate to multi-tenant:

1. **Pick a "default" tenantId** for the migration target. Everything
   currently at `env.AGENT.idFromName(agentId)` needs to land at
   `env.AGENT.idFromName(`${tenantId}::${agentId}`)`.
2. **State migration:** DOs don't move automatically. Either:
   - Export via `agent.list({prefix: ""}) + agent.load(k)` per key,
     then re-import into the new tenant-scoped DO
   - Or accept a clean break (agents re-spawn fresh in the new
     namespace)
3. **Registry rebuild:** the new registry shard at
   `${tenantId}::default` starts empty. Re-spawning agents
   registers them in the new shard automatically.

Most adopters use option (2) — multi-tenant conversion usually
coincides with a product rebuild where clean-slate state is
acceptable.
