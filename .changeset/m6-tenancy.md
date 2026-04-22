---
"@loom-loyalty/meridian-types": minor
"@loom-loyalty/meridian-runtime-cloudflare": minor
---

M6: Opt-in multi-tenancy for `createMeridianWorker`.

Adopters can now run one Meridian runtime across multiple tenants
without forking. Tenancy is **off by default** — existing deploys
upgrading from M5 see no change to their DO addresses, registry
keys, or `AgentHandle` shape. Multi-tenant adopters (Shuttle and
similar) opt in by providing a `TenantAuthorizer`.

**Adopter API**

```ts
import {
  createMeridianWorker,
  type TenantAuthorizer,
} from "@loom-loyalty/meridian-runtime-cloudflare";

class JwtTenantAuthorizer implements TenantAuthorizer {
  async resolveTenantId(req: Request): Promise<string> {
    const { tid } = await verifyJwt(req);
    return tid;
  }
}

export default createMeridianWorker({
  agents: [...],
  tenancy: { authorizer: new JwtTenantAuthorizer() },
});
```

**Server-enforced isolation invariants (tenancy on)**

1. **DO namespacing** — `env.AGENT.idFromName("${tenantId}::${agentId}")`.
   Same agentId under two tenants maps to two distinct DOs with
   their own SQLite, alarms, inbox.
2. **Registry scoping** — each tenant gets its own RegistryDO shard
   keyed `${tenantId}::default`. `registry.list()` has zero
   cross-tenant leakage by construction.
3. **Cross-agent send containment** — when agent A sends to "B",
   the target DO is resolved under A's own tenantId (stored in meta
   at spawn). Sending into another tenant's namespace is impossible.
4. **Broadcast containment** — broadcasts query only the sender's
   tenant-scoped registry shard.
5. **Admin route scoping** — `GET /admin/domains` and
   `GET /admin/agents/:id` call the authorizer before reading. A
   tenant-B caller asking about tenant-A's agent gets 404
   `MRD-CF-LC-002`.
6. **Spawn body cannot spoof tenant** — the worker forces the
   authorizer-resolved `tenantId` onto the spawn config.
7. **Handle carries `tenantId`** — `AgentHandle` responses from a
   tenant-aware worker include `tenantId`; single-tenant handles
   omit it.

**Types-package update**

- `SpawnConfig.tenantId?: string` — optional, additive
- `AgentHandle.tenantId?: string` — optional, additive (absent on
  single-tenant runtimes, present on multi-tenant)

**New exports from `@loom-loyalty/meridian-runtime-cloudflare`**

- `TenantAuthorizer` interface
- `SingleTenantAuthorizer` — default (returns `"default"`)
- `TenancyConfig`, `TenantContext` types
- `scopedAgentName(agentId, tenant)` — exposed for adopters who
  need to compute DO names outside the built-in routes
- `scopedRegistryKey(tenant)` — exposed for the same reason

**Backward compatibility**

Single-tenant mode is bit-for-bit identical to M5. When `tenancy`
is undefined:

- DO names stay `env.AGENT.idFromName(agentId)` — no prefix
- Registry shard stays `"default"`
- `AgentMeta` omits `tenantId`
- `AgentHandle` omits `tenantId`

No migration needed for existing adopter deploys.

**Test totals**

- `runtime-cloudflare`: 123 → 129 tests green (+6 tenancy tests
  covering DO namespace isolation, admin `/domains` per-tenant
  listing, cross-tenant inspect returns 404, `tenantId` on handles,
  single-tenant fallback, `SingleTenantAuthorizer` stub behavior).

**v0.1 scope gates (deferred to v0.1.5)**

- `TenantLimits.maxCostUsd` aggregate caps across agents in a
  tenant — per-agent `ResourceLimits` still enforced today
- Analytics Engine `meridian.tenant_id` dimension tag on metrics
  (plumbed through `obs.metric` tags, but not auto-tagged per
  request yet — adopters can add it manually via the adopter-facing
  `AgentContext.obs.metric` tag arg)
- Tenant provisioning flow, cross-region routing, spawn-bomb rate
  limiting — Shuttle (multi-tenant operator) territory
