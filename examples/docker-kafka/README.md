# docker-kafka

External Meridian agent example. A Node process in a Docker sidecar
monitors Kafka consumer-group lag and broadcasts `InsightFeedback`
over HTTP to a deployed Meridian worker.

## Why Docker, not Cloudflare?

This is the canonical "infra-proximity" adoption pattern.
`kafkajs` opens raw TCP sockets to your Kafka brokers and does
non-trivial buffer manipulation — workerd (Cloudflare Workers'
runtime) doesn't support either. Two other reasons to run an agent
as a sidecar:

- **Network topology.** Agent runs inside your VPC; Kafka brokers
  aren't exposed to the public internet. No ingress rules to punch,
  no CF → VPC egress to route.
- **Language / library ecosystem.** Adopters with existing Go / Java /
  Python fleets can run native agents alongside their apps and talk
  to Meridian over HTTP — no Workers rewrite.

The sidecar still participates fully in the Meridian protocol: it
spawns a real agent with an id + domain, emits `InsightFeedback`,
consumes its own inbox. Everything in the protocol-spec sense, just
not hosted on CF.

## Architecture

```text
┌──────────────────────────┐          ┌────────────────────────────┐
│  Docker container (Node) │          │  Cloudflare Worker         │
│                          │   HTTP   │                            │
│  KafkaLagMonitor agent   │─────────▶│  createMeridianWorker      │
│  (polls every POLL_INT)  │  POST /  │  + your domain agents      │
│                          │  agents/ │                            │
│           ▲              │  .../bc  │            ▼               │
│           │              │          │  ┌────────────────────┐    │
└───────────│──────────────┘          │  │ AgentDurableObject │    │
            │                         │  │ (receives insights)│    │
            │ Kafka admin API         │  └────────────────────┘    │
            ▼                         └────────────────────────────┘
   ┌──────────────────┐
   │ Kafka broker     │
   │ (same VPC, same  │
   │  docker-compose) │
   └──────────────────┘
```

The Kafka broker is part of the local compose stack. The Meridian
worker runs on CF (or locally via `wrangler dev --remote` during
development).

## Run it

```bash
# 1. Deploy (or already have) a Meridian worker. See
#    examples/cf-hyperdrive-postgres/DEPLOY.md for the pattern.

# 2. Configure this sidecar.
cp .env.example .env
# edit .env — set MERIDIAN_ENDPOINT to your worker URL

# 3. Start the stack.
docker compose up --build

# 4. (Optional) Seed some lag so the agent has something to report.
#    Produce a few thousand messages then consume only a handful:
docker exec -it docker-kafka-kafka-1 \
  /opt/bitnami/kafka/bin/kafka-console-producer.sh \
  --broker-list localhost:9092 --topic demo \
  < /etc/hostname  # any small file works
```

The agent logs a line per tick. When consumer lag crosses
`LAG_THRESHOLD`, you'll see:

```
[kafka-lag-monitor] emitted insight for group <name> to 1 recipient(s)
```

If no CF-side listener is registered in the `AGENT_DOMAIN` yet, you'll
see:

```
[kafka-lag-monitor] no recipients in domain "infrastructure" yet; insight deferred
```

That's a known path — deploy a sink agent in your CF worker to
consume these. (cf-hyperdrive-postgres from M3b is a _producer_, not
a sink; adopters build or generate their sink per their pipeline.)

## Local dev without Docker

```bash
pnpm install
pnpm typecheck
pnpm test     # 5 tests, ~300ms, no Kafka or HTTP needed

# Point at a local Kafka + Meridian worker
export KAFKA_BROKERS=localhost:9092
export MERIDIAN_ENDPOINT=http://localhost:8787
pnpm dev      # runs src/agent.ts via tsx
```

## Files

- `src/agent.ts` — main loop + `runOneTick` (exported so tests
  exercise it without the full lifecycle).
- `src/client.ts` — ~120 lines of plain fetch; copy-paste this into
  any Node / Deno / Bun external-agent codebase.
- `test/agent.test.ts` — 5 unit tests; hand-stubs Kafka Admin so
  nothing opens a real socket.
- `Dockerfile` — multi-stage: compile TS in a build image, ship a
  lean `node:22-alpine` runtime as a non-root user.
- `docker-compose.yml` — agent + Bitnami Kafka in KRaft mode (no
  ZooKeeper needed).

## Configuration

All via environment variables (.env.example lists them):

| Variable            | Required | Default                | Purpose                                  |
| ------------------- | -------- | ---------------------- | ---------------------------------------- |
| `MERIDIAN_ENDPOINT` | yes      | —                      | URL of the Meridian worker               |
| `MERIDIAN_TOKEN`    | no       | —                      | Bearer token (v0.1 ignored; M4 enforces) |
| `KAFKA_BROKERS`     | yes      | —                      | comma-separated broker list              |
| `KAFKA_CLIENT_ID`   | no       | `meridian-lag-monitor` | Kafka client id                          |
| `AGENT_ID`          | no       | `kafka-lag-monitor`    | Meridian agent id                        |
| `AGENT_DOMAIN`      | no       | `infrastructure`       | Meridian agent domain                    |
| `POLL_INTERVAL_MS`  | no       | `60000`                | Lag-check cadence                        |
| `LAG_THRESHOLD`     | no       | `1000`                 | Messages-of-lag trigger                  |

## What this does NOT do (v0.1)

- **No auth.** The Meridian worker accepts the spawn/broadcast/terminate
  without bearer verification. Deploy to a private `workers.dev`
  subdomain or behind Cloudflare Access until M4 lands.
- **No inbox consumption.** The agent emits but doesn't read its own
  inbox. If a CF-side operator wants to poke it (e.g., "poll now"),
  that arrives but goes unprocessed. Add `setInterval(() =>
client.drainInbox(AGENT_ID).then(handleCommands))` if you need
  bidirectional control.
- **No backpressure handling on emit.** If the Meridian worker
  returns 429 (rate-limited), the agent logs and continues. Adopters
  shipping to production should add retry-with-backoff in
  `client.ts`.

## License

Apache 2.0.
