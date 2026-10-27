# `MRD-CF-TN-*` — Tenancy errors

Raised when `createMeridianWorker({ tenancy })` is configured. See the
[tenancy invariants guide](../guides/tenancy-invariants.md).

## `MRD-CF-TN-001` — tenant id contains `:`

**Category:** `invalid_argument` (HTTP 400) · **Retryable:** no

`TenantAuthorizer.resolveTenantId()` returned a tenant id containing
`:`, or a Durable Object was spawned with such a `SpawnConfig.tenantId`.

Durable Object names are `${tenantId}::${agentId}`, and agent ids
are arbitrary strings. With a colon in the tenant id, two different
(tenant, agent) pairs can produce the same name, for example tenant
`a::b` + agent `c` and tenant `a` + agent `b::c`. That would let one
tenant address another tenant's agent. The runtime fails closed
instead.

**Fix**

Mint tenant ids from a charset without `:` (for example
`[a-z0-9_-]`). If existing tenant ids contain `:`, map them to a
colon-free form in your authorizer (for example by
percent-encoding `:` as `%3A`) and migrate those tenants' agents.
