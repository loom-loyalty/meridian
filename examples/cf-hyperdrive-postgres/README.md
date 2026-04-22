# cf-hyperdrive-postgres

Native-Cloudflare Meridian example. Spawns a
`PostgresQueryOptimizer` agent that polls `pg_stat_statements`
every 15 minutes via Hyperdrive, emits an `InsightFeedback` +
creates a `proposed` `WorkItem` for any query that stays slow
for ≥1 hour.

## Architecture

```text
┌────────────────────────────────────────────────────────────────┐
│  Cloudflare Worker                                             │
│  ┌──────────────────────────┐                                 │
│  │  createMeridianWorker    │   ← HTTP surface (/bootstrap,   │
│  │   + PostgresQueryOpt.    │     /insights, /.well-known,    │
│  │     AgentDurableObject   │     /agents/*)                  │
│  └────────┬─────────────────┘                                 │
│           │ DO alarm every 15 min                             │
│           ▼                                                   │
│  ┌──────────────────────────┐      ┌──────────────────────┐   │
│  │  onSchedule hook         │─────▶│  Hyperdrive          │   │
│  │  fetchSlowQueries()      │ SQL  │  (pg_stat_statements)│   │
│  │  buildInsight()          │◀─────│                      │   │
│  │  buildWorkItem()         │ rows └──────────────────────┘   │
│  │  state.save("insights/") │                                 │
│  │  state.save("workitems/")│                                 │
│  └──────────────────────────┘                                 │
└────────────────────────────────────────────────────────────────┘
```

State is persisted inside the agent's DO (SQLite-backed). An
ingestion pipeline polls `GET /insights` or `GET /agents/:id/inbox`
to pull new feedback + work items.

## Time to first insight

- **0 min:** deploy
- **~1 min:** first cron tick observes `pg_stat_statements`
- **~1 hour:** 4 consecutive sustained-slow polls → first insight
  emitted (confidence 0.5)
- **~2 hours:** 8 consecutive polls → full confidence (1.0)

Adopters who want faster emission during development can temporarily
lower `SUSTAINED_TICKS_THRESHOLD` in `src/agent.ts`.

## Deploy

See [DEPLOY.md](./DEPLOY.md) for the 15-minute walkthrough. Short
version:

```bash
# 1. Login + provision
wrangler login
wrangler hyperdrive create pg-monitor --connection-string "postgres://..."

# 2. Put the returned `id` into wrangler.toml's [[hyperdrive]].id

# 3. Deploy + bootstrap
wrangler deploy
curl -X POST https://pg-monitor.<your-subdomain>.workers.dev/bootstrap

# 4. (Optional) Inspect what the agent has collected
curl https://pg-monitor.<your-subdomain>.workers.dev/insights
```

## Local development

```bash
# Install, typecheck, test (in-memory — no wrangler / miniflare needed)
pnpm install
pnpm typecheck
pnpm test

# Wrangler dev — runs against a local Miniflare + your Postgres
# via Hyperdrive's connection string passed through .dev.vars
wrangler dev
```

`pnpm test` uses `createTestRuntime()` — the in-memory Meridian
runtime. Adopter hooks fire in the node process, so you can verify
business logic with millisecond setup and no Workers environment.

## How this maps to the spec

- `InsightFeedback` — RUNTIME-SPEC expected-tier feedback with
  `summary` narrative, `evidence` payload, `suggestedAction`, and
  confidence derived from sustained observation.
- `WorkItem.source = "agent"` — detector/estimator handoff per
  `WORK-ITEM-SPEC.md §6`. This agent fills `costOfNotBuilding`
  from measured query cost × projection; `costToBuild` stays zero
  pending a downstream estimator agent or human steward.
- `WorkItem.status = "proposed"` — enters the queue but doesn't
  block; a human steward reviews and transitions to `researching`
  or `ready` before work starts.

## Caveats (v0.1)

- **No auth** on the `/bootstrap` + `/insights` routes. Deploy to
  a private `workers.dev` subdomain; M4 adds bearer auth.
- **Cost model is a heuristic** (`$0.001 per ms of DB CPU`).
  Replace with your infrastructure pricing in `buildWorkItem()`.
- **No external feedback forwarding** — the agent stores insights
  - work items in its own DO. Ingestion code polls; a future
    example wires this to a Kafka/Pulsar sink.

## License

Apache 2.0.
