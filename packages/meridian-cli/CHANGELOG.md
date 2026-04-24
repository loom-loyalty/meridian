# @loom-loyalty/meridian-cli

## 0.2.3

### Patch Changes

- a3d91a5: No-op patch to exercise the fixed OIDC publish path.

  The Release workflow's publish job now uses Node 24 (which ships
  npm 11.x natively) instead of attempting to upgrade Node 22's
  bundled npm 10.x in place. The in-place upgrade path hit a
  `Cannot find module 'promise-retry'` race on the GH runner
  that --force didn't resolve.

  After this lands, every `@loom-loyalty/meridian-*` package gets
  published with signed provenance via the full Trusted Publishers
  OIDC pipeline.

## 0.2.2

### Patch Changes

- 85c31fc: Verify Trusted Publishers OIDC flow across every package.

  No-op patch bump that forces every `@loom-loyalty/meridian-*`
  package to republish via the OIDC + Trusted Publishers pipeline.

  Why a deliberate no-op bump: the first real publish run
  (changesets published via `gh workflow run release.yml` from
  PR #38) 404'd on `meridian-conformance` and
  `meridian-runtime-cloudflare`. npm returns 404 (not 403) when a
  Trusted Publisher config is missing or mismatched for a specific
  package — confusingly, "package not found" covers both "doesn't
  exist" and "exists but no TP entry matches". That first run
  confirmed OIDC tokens mint correctly and provenance attestations
  land in Sigstore (indices 1360301067, 1360301068) — just the
  per-package TP entries were incomplete.

  TP is now configured on all six. This changeset exercises each
  one so we verify the full pipeline in one run:
  - 6 separate npm publishes, each with its own OIDC token
  - 6 separate provenance attestations in Sigstore
  - 6 registry entries bumped by a patch version

  If any single package 404s on this run, that's the one with a
  TP config problem — isolated signal instead of hoping subsequent
  changesets happen to touch it.

  Adopter-facing change: none. No code changes in this commit; the
  behavior is identical across all 6 packages.

## 0.2.0

### Minor Changes

- 7b005a1: M4c: Initial `meridian` CLI (v0.1.0).

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

  | Command                | Description                                                                                                                                                                                                                                                                                                                             |
  | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `meridian init [name]` | Scaffold a Cloudflare Meridian project — `wrangler.toml`, `package.json`, `tsconfig.json`, `.gitignore`, `.dev.vars`, `README.md`, `src/worker.ts`, `src/agent.ts`. Defaults: project `my-meridian-app`, agent id `hello`, domain `demo`. Override with `--project`, `--agent-id`, `--domain`. `--force` overwrites a non-empty target. |
  | `meridian gen-token`   | Mint a 256-bit URL-safe base64 `MERIDIAN_ADMIN_TOKEN`. `--dev-vars` appends/updates `./.dev.vars`. `--wrangler` prints the `wrangler secret put` command. Default prints `export MERIDIAN_ADMIN_TOKEN=...`.                                                                                                                             |
  | `meridian demo`        | Spawn a canned agent + send a sample `InsightFeedback` payload + drain the inbox + confirm admin visibility. Competitive-tier TTHW closer. Needs `--endpoint` and a running runtime.                                                                                                                                                    |
  | `meridian doctor`      | Local + remote health checks: Node version, token presence, endpoint reachability, health probe, AgentCard shape, `securitySchemes.bearer` advertisement, admin-auth round-trip. Exits 1 on any failure with concrete remediation.                                                                                                      |

  **Commands (experimental, v0.1 behind `--experimental`)**

  Backing endpoints (`GET /admin/domains`, `GET /admin/agents/:id`)
  are stable in `runtime-cloudflare@0.5+`; the CLI wrapper is gated
  because the formatting / flag shape may evolve across v0.1.x.

  | Command                      | Description                                                                 |
  | ---------------------------- | --------------------------------------------------------------------------- |
  | `meridian inspect <agentId>` | Full inspect: agent handle + schedules + usage + state keys + inbox length. |
  | `meridian domains`           | Agents grouped by domain (alphabetically sorted).                           |

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
