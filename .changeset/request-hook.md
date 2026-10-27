---
"@loom-loyalty/meridian-runtime-cloudflare": minor
---

Add `onRequest` and tenant context for custom routes.

- `config.onRequest({ req, env, ctx, tenant, route })` runs before built-in
  `/agents/*` and `/admin/*` routes, after bearer auth and tenant
  resolution. It can short-circuit by returning a `Response`, or return
  `{ onResponse(res) }` to observe or replace the response (errors are
  already mapped to HTTP status). `route` classifies the request
  (`{ kind: "agent", agentId, action }` or an admin route), so adopters
  can meter, rate-limit and audit per tenant and operation without
  re-parsing paths.
- Custom `routes` handlers get a 4th argument, `meridian.tenant()`. It
  resolves the tenant lazily (once per request), so public custom routes
  still need no credentials.
