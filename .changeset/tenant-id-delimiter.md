---
"@loom-loyalty/meridian-runtime-cloudflare": patch
---

Security: reject tenant ids containing `:` (new code `MRD-CF-TN-001`).

DO names are `${tenantId}::${agentId}` and agent ids are arbitrary, so a
colon in a tenant id made names ambiguous: tenant `a::b` + agent `c` and
tenant `a` + agent `b::c` resolved to the same Durable Object. The check
runs when the `TenantAuthorizer` resolves a request and again inside
`spawn()`. `assertValidTenantId` is exported for authorizers that want
to validate early.
