---
"@loom-loyalty/meridian-runtime-cloudflare": minor
---

M4b: Admin routes for `createMeridianWorker`.

Adds two read-only operational endpoints adopters (and the upcoming
`meridian` CLI) can call to introspect a live runtime without
cracking open the Durable Object internals themselves.

**New routes**

```
GET /admin/domains           → list registered agents grouped by domain
GET /admin/agents/:id        → unified inspect: handle + schedules +
                                usage + state keys + inbox length
```

Every admin route is gated by bearer auth when `config.auth.bearer`
is set. Unlike the `/agents/*` surface, admin reads are gated too —
enumerating the registry / draining state keys is operationally
sensitive enough that leaving it open without a token would surprise
adopters.

**Response shapes**

```jsonc
// GET /admin/domains
{
  "domains": [
    { "domain": "adm-x", "agentIds": ["a", "b"] },
    { "domain": "adm-y", "agentIds": ["c"] }
  ]
}
```

Domains and `agentIds` are sorted alphabetically so the response is
deterministic.

```jsonc
// GET /admin/agents/:id
{
  "agent": { "id": "...", "domain": "...", "status": "running", "spawnedAt": 1234567890 },
  "schedules": [ /* ScheduleInfo[] */ ],
  "usage": {
    "limits": { /* ResourceLimits */ },
    "current": {
      "memoryMB": 0,
      "cpuMsLifetime": 0,
      "tokensLifetime": 0,
      "costUsdLifetime": 0,
      "activeOperations": 0
    },
    "warnings": []
  },
  "state": {
    "keys": [ /* string[] */ ],
    "cursor": "..."  // optional, for pagination
  },
  "inbox": { "length": 3 }
}
```

Pre-spawn inspect returns HTTP 404 with `MRD-CF-LC-002`.

**Error mapping**

- Unknown `/admin/*` path → 404
- Non-GET on a known admin path → 405 with `Allow: GET`
- Auth configured but missing header → 401 `MRD-CF-AU-001`
- Wrong bearer token → 401 `MRD-CF-AU-002`

**Test totals**

- `runtime-cloudflare`: 114 → 123 tests green (+9 admin tests covering
  domain grouping + sort contract, inspect payload shape, pre-spawn
  404, unknown admin path, 405 on non-GET, bearer required + wrong
  token paths).

**v0.1 scope gates**

- Read-only. No spawn / terminate / send on the admin surface —
  those stay on `/agents/*` where adopters already drive them.
- Single-registry-shard lookup for `/admin/domains`. When the sharded
  registry lands in M6, the fan-out across all 16 shards is additive
  (same response shape, more internal subrequests).
- `/admin/domains/:id/queue` and `/admin/tail` (WebSocket) stay on
  the roadmap for M4c / post-M4; the shape above is minimal-viable
  for the CLI's `inspect` and `domains` commands.

**Next**

- M4c: `packages/meridian-cli` — `meridian init/gen-token/demo/doctor`
  plus admin clients (`inspect/tail/queue/domains`) that hit these
  routes with the configured `MERIDIAN_ADMIN_TOKEN`.
