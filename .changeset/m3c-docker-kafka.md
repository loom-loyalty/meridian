---
---

M3c: `examples/docker-kafka` — external Meridian agent running in a
Docker sidecar. Monitors Kafka consumer-group lag via `kafkajs` (an
NPM module that opens raw TCP sockets and doesn't run on workerd)
and broadcasts `InsightFeedback` over HTTP to a deployed Meridian
worker.

**Pattern:** infra-proximity / non-CF adoption. Agent lives outside
the Workers isolate; talks to a `createMeridianWorker` (from M3a)
over HTTP the same way any third-party service would. Key piece is
`src/client.ts` — ~150 lines of plain `fetch`, zero Meridian runtime
deps. Adopters copy it straight into their Go/Node/Python agents
(or port the signatures).

Files:

- `src/client.ts` — the reference HTTP client
  (`MeridianClient` with `spawn` / `terminate` / `send` / `broadcast` /
  `inbox` / `drainInbox`). Base64 encodes payloads. Structured
  `MeridianHttpError` with `code` + `category` + `docUrl` so callers
  pattern-match on MRD-CF-* codes.
- `src/agent.ts` — `KafkaLagMonitor`. Spawns on startup, polls lag
  every `POLL_INTERVAL_MS`, broadcasts to `AGENT_DOMAIN`. Swallows
  `MRD-CF-TR-002` ("no recipients yet") as an expected early-deploy
  state. Graceful SIGTERM → DELETE agent.
- `test/agent.test.ts` — 5 unit tests with hand-stubbed Kafka Admin
  (no real TCP) and a fake `MeridianClient`. Covers: zero-lag path,
  multi-group emission, 002 swallow, transient-group-failure
  recovery, non-002 error propagation.
- `Dockerfile` — multi-stage `node:22-alpine`, non-root user,
  `STOPSIGNAL SIGTERM` for graceful teardown.
- `docker-compose.yml` — agent + Bitnami Kafka in KRaft mode (no
  ZooKeeper). Agent depends-on Kafka health.
- `README.md` — "why Docker not CF" teaching, compose-up walkthrough,
  config table, known v0.1 gaps (no auth, no inbox consumption, no
  backpressure retry).
- `.env.example` — `MERIDIAN_ENDPOINT`, `KAFKA_BROKERS`, optional
  token.

**Node version cleanup across the repo:** upgraded from Node 20 to
Node 22 (current LTS as of October 2024) in three places that
diverged from `.nvmrc`:

- `examples/docker-kafka/Dockerfile` + `package.json` → Node 22
- `.github/workflows/ci.yml` and `release.yml` — now pull from
  `.nvmrc` directly via `node-version-file` (matching
  `e2e-cloudflare.yml`'s pattern). Single source of truth.

Test totals: 105 → 114 green (runtime-cloudflare 105 + cf-hyperdrive
4 + docker-kafka 5).

**M3 sequence closed.** Adopters now have: a native-CF example
(cf-hyperdrive-postgres), an external-agent example (docker-kafka),
and the `createMeridianWorker` helper both examples share. Next
sequenced milestone is M4 (admin routes + bearer auth + CLI).
