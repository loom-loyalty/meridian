---
"@loom-loyalty/meridian-cli": minor
---

M4c: Initial `meridian` CLI (v0.1.0).

Developer CLI for scaffolding Cloudflare adopter projects and
talking to the admin surface exposed by
`@loom-loyalty/meridian-runtime-cloudflare`.

**Install**

```bash
pnpm add -g @loom-loyalty/meridian-cli
# or one-shot
pnpm dlx @loom-loyalty/meridian-cli init my-app
```

Requires Node 22+.

**Commands (stable in v0.1)**

| Command | Description |
|---|---|
| `meridian init [name]` | Scaffold a Cloudflare Meridian project — `wrangler.toml`, `package.json`, `tsconfig.json`, `.gitignore`, `.dev.vars`, `README.md`, `src/worker.ts`, `src/agent.ts`. Defaults: project `my-meridian-app`, agent id `hello`, domain `demo`. Override with `--project`, `--agent-id`, `--domain`. `--force` overwrites a non-empty target. |
| `meridian gen-token` | Mint a 256-bit URL-safe base64 `MERIDIAN_ADMIN_TOKEN`. `--dev-vars` appends/updates `./.dev.vars`. `--wrangler` prints the `wrangler secret put` command. Default prints `export MERIDIAN_ADMIN_TOKEN=...`. |
| `meridian demo` | Spawn a canned agent + send a sample `InsightFeedback` payload + drain the inbox + confirm admin visibility. Competitive-tier TTHW closer. Needs `--endpoint` and a running runtime. |
| `meridian doctor` | Local + remote health checks: Node version, token presence, endpoint reachability, health probe, AgentCard shape, `securitySchemes.bearer` advertisement, admin-auth round-trip. Exits 1 on any failure with concrete remediation. |

**Commands (experimental, v0.1 behind `--experimental`)**

Backing endpoints (`GET /admin/domains`, `GET /admin/agents/:id`)
are stable in `runtime-cloudflare@0.5+`; the CLI wrapper is gated
because the formatting / flag shape may evolve across v0.1.x.

| Command | Description |
|---|---|
| `meridian inspect <agentId>` | Full inspect: agent handle + schedules + usage + state keys + inbox length. |
| `meridian domains` | Agents grouped by domain (alphabetically sorted). |

Enable per-invocation with `--experimental`, or set
`MERIDIAN_EXPERIMENTAL=1` to opt in globally.

**Configuration**

Every network-facing command resolves its endpoint + token in this
order:

1. Explicit flags: `--endpoint <url>`, `--token <secret>`
2. Env vars: `MERIDIAN_ENDPOINT`, `MERIDIAN_ADMIN_TOKEN`
3. `./.dev.vars` (same format `wrangler` reads)

Mirrors `wrangler`'s local-dev conventions so one `.dev.vars` powers
both `wrangler dev` and the Meridian CLI.

**Design notes**

- **Zero runtime dependencies.** Arg parsing, HTTP, config resolution
  hand-rolled against Node 22 built-ins (`fetch`, `node:fs`,
  `node:crypto`). `pnpm dlx` install time stays minimal.
- **Template-driven init.** Raw text templates inlined as strings in
  `src/templates/index.ts` — no bundled `.tmpl` files, no
  platform-specific path resolution at runtime.
- **Lazy worker handler.** The scaffolded `src/worker.ts` builds
  `createMeridianWorker` on the first request and caches per-isolate
  so `env.MERIDIAN_ADMIN_TOKEN` (only available at request time in
  Workers) flows through correctly.

**Test coverage**

34 tests green across 5 files:

- `test/args.test.ts` — arg parsing (positionals, long flags, bundled
  shorts, no-args edge)
- `test/gen-token.test.ts` — token minting, output forms, `.dev.vars`
  create/replace/append
- `test/init.test.ts` — scaffolding all files, template substitution,
  force semantics, `.gitignore` secret safety
- `test/config.test.ts` — flag > env > `.dev.vars` precedence
- `test/http.test.ts` — bearer header injection, URL join, 4xx/5xx
  → `CliHttpError` with stable `MRD-*` code extraction

**v0.1 scope gates**

- No `tail` (WebSocket) command yet — admin WebSocket route lands
  post-M4.
- No `queue` command — domain work-item queue route not yet
  scaffolded on the runtime side.
- No telemetry. Anonymous usage signals deferred to v0.1.5 (plan
  DX-review decision).
