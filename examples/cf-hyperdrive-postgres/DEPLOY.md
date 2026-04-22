# Deploy: cf-hyperdrive-postgres

Realistic walkthrough. Total ~15 minutes if you have a Postgres
instance already; add 5-10 minutes if you're provisioning one from
scratch.

## Prerequisites

- Cloudflare account with Workers Paid ($5/mo minimum — Durable
  Objects with SQLite backing aren't available on the free plan)
- A Postgres database reachable from the public internet (Neon,
  Supabase, RDS, your own). Version 14+ recommended for
  `pg_stat_statements` defaults.
- `wrangler` CLI (bundled as a dev dep here; `pnpm wrangler ...`
  works)
- `psql` (or equivalent) for running one migration

## Step 1 — Clone + install (~1 min)

```bash
git clone <your-fork-of-meridian>
cd meridian
pnpm install
cd examples/cf-hyperdrive-postgres
```

## Step 2 — Enable `pg_stat_statements` (~2 min)

On Postgres 14+ this is pre-loaded but disabled per database. On
RDS / Neon you may need to add it to `shared_preload_libraries`
via the provider's UI first.

```bash
psql "$DATABASE_URL" <<'SQL'
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SELECT pg_stat_statements_reset();
SQL
```

Then run the example's migration:

```bash
psql "$DATABASE_URL" < migrations/0001-create-observations.sql
```

(The migration is a belt-and-suspenders observation log — the agent
keeps tracking state in its DO storage too. You can skip the
migration if you only care about the in-DO view.)

## Step 3 — Provision Hyperdrive (~3 min)

Hyperdrive is the CF edge pooler that makes Postgres reachable from
Workers without per-request TLS handshakes. One config per database.

```bash
wrangler login

wrangler hyperdrive create pg-monitor-prod \
  --connection-string "postgresql://USER:PASSWORD@HOST:5432/DB"
```

Copy the `id` printed in the output. It looks like
`00000000-0000-0000-0000-000000000000`. Paste it into
`wrangler.toml` under `[[hyperdrive]].id`:

```toml
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<paste-here>"
```

## Step 4 — Deploy (~2 min)

```bash
wrangler deploy
```

Wrangler prints the worker URL:
`https://pg-monitor.<your-subdomain>.workers.dev`

First deploy runs the DO migration automatically; no extra step.

## Step 5 — Bootstrap the agent (~30 sec)

The agent doesn't spawn itself — an HTTP call triggers it:

```bash
WORKER_URL="https://pg-monitor.<your-subdomain>.workers.dev"
curl -X POST "$WORKER_URL/bootstrap"
```

Response:

```json
{
  "bootstrapped": {
    "id": "pg-query-optimizer",
    "domain": "infrastructure",
    "status": "running",
    "spawnedAt": 1776890000000
  }
}
```

The `onSpawn` hook installs the `*/15 * * * *` cron. From here the
agent runs autonomously.

## Step 6 — Watch for insights

Insights surface after the sustained-slow threshold trips (4
consecutive polls = ~1 hour of sustained slowness). For the first
few hours you'll see empty lists:

```bash
curl "$WORKER_URL/insights"
# {"insightKeys": [], "workItemKeys": []}
```

Once the agent emits:

```bash
curl "$WORKER_URL/insights"
# {
#   "insightKeys": ["insights/1776890000000-123456"],
#   "workItemKeys": ["workitems/wi-pg-123456-1776890000000"]
# }
```

Pull the inspect payload (handle + schedules + usage + state key
list + inbox length) via the admin route:

```bash
MERIDIAN_ADMIN_TOKEN="..."  # your admin token
curl -H "Authorization: Bearer $MERIDIAN_ADMIN_TOKEN" \
  "$WORKER_URL/admin/agents/pg-query-optimizer" | jq .
```

Or with the CLI:

```bash
meridian inspect pg-query-optimizer \
  --experimental \
  --endpoint="$WORKER_URL" \
  --token="$MERIDIAN_ADMIN_TOKEN"
```

v0.1 exposes state-key enumeration (`state.keys`) but not individual
state values over HTTP — intentional, since state can contain
anything the agent writes. Read specific values via the
`routes: {...}` hatch on `createMeridianWorker` (the `/insights`
route above is one example).

## Step 7 — Tail logs

`wrangler.toml` has Observability enabled, so the Cloudflare
dashboard captures every invocation's `console.error` / `console.log`
output including the `[meridian-do]` and `[pg-query-optimizer]`
structured entries.

Dashboard path: **Workers & Pages → `pg-monitor` → Logs**

Live stream:

```bash
wrangler tail pg-monitor
```

Look for:

- `[pg-query-optimizer] emitted insight for queryid ...` — the
  agent tripped an insight on the matching query.
- `[meridian-do] onSchedule threw ...` — hook error (check your
  Hyperdrive connection or `pg_stat_statements` access).

## Costs

- Workers paid: $5/mo base.
- Durable Objects: storage cost is negligible at this scale
  (tens of KB per agent, priced per GB).
- Hyperdrive: free in beta as of this writing.
- Postgres connections: 1 per cron tick (~96 per day).

Budget ≈ **$5/month** for a production deploy watching one database.

## Teardown

```bash
wrangler delete pg-monitor
wrangler hyperdrive delete <config-id>
```

Durable Object storage gets reclaimed automatically within a day
or two of the worker deletion.

## Troubleshooting

**`/bootstrap` returns 500 with `MRD-CF-LC-005`.** The DO binding
name doesn't match the spawn-requested id. Our code sends
`spawn({id: "pg-query-optimizer"})` to `env.AGENT.idFromName("pg-query-optimizer")` — they match by construction. If you see this, your
`wrangler.toml` class_name probably diverged; reset to the template.

**`[pg-query-optimizer] HYPERDRIVE binding missing`** in logs.
Check `wrangler.toml` has `[[hyperdrive]]` with the right `id`, and
`wrangler deploy` succeeded without warnings about the binding.

**`pg_stat_statements` is empty.** Either the extension isn't
loaded (needs `shared_preload_libraries` update + Postgres restart)
or no queries have hit the thresholds yet. Manually run some slow
queries to seed:

```sql
SELECT pg_sleep(0.1), 1 FROM generate_series(1, 100);
```

then wait for the next cron tick.

**Internal error; reference=XXX from DO RPC.** Check the CF
dashboard logs — the `log-rpc-error.ts` wrapper in
`meridian-runtime-cloudflare` writes the real stack there.
