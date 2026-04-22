# @loom-loyalty/meridian-cli

Developer CLI for the [Meridian protocol](https://meridianprotocol.dev).

Scaffolds Cloudflare adopter projects, mints admin tokens, runs
diagnostics, and talks to the admin surface exposed by
[`@loom-loyalty/meridian-runtime-cloudflare`](../runtime-cloudflare).

## Install

```bash
# Global (recommended for solo work)
pnpm add -g @loom-loyalty/meridian-cli

# Or one-shot
pnpm dlx @loom-loyalty/meridian-cli init my-app
```

Requires Node 22+.

## Quickstart

```bash
meridian init my-meridian-app
cd my-meridian-app
pnpm install
meridian gen-token --dev-vars
pnpm dev                               # wrangler dev
meridian doctor --endpoint=http://localhost:8787
```

## Commands

### Stable (v0.1)

| Command                | Description                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meridian init [name]` | Scaffold a Cloudflare Meridian project (wrangler.toml, worker.ts, agent.ts, package.json, .gitignore, .dev.vars, README).                                       |
| `meridian gen-token`   | Mint a cryptographically random `MERIDIAN_ADMIN_TOKEN`. Pass `--dev-vars` to write into `./.dev.vars`, `--wrangler` to print the `wrangler secret put` command. |
| `meridian demo`        | Spawn a canned agent + send a sample `InsightFeedback` payload, drain the inbox, confirm admin visibility. Needs `--endpoint` and a running runtime.            |
| `meridian doctor`      | Run local + remote health checks. Node version, token presence, endpoint reachability, AgentCard shape, `securitySchemes` advertisement, admin-auth round-trip. |

### Experimental (v0.1 behind `--experimental`)

Backing endpoints are stable (`GET /admin/domains`, `GET /admin/agents/:id`
both stable in `runtime-cloudflare@0.5+`). The CLI wrapper is gated
because the formatting / flag shape may evolve across v0.1.x.

| Command                      | Description                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `meridian inspect <agentId>` | Full inspect payload: handle + schedules + usage + state keys + inbox length. |
| `meridian domains`           | Agents grouped by domain.                                                     |

Enable via `--experimental` flag or `MERIDIAN_EXPERIMENTAL=1`.

## Configuration

Every command that talks to a running runtime resolves its endpoint
and admin token in this order:

1. Explicit flags: `--endpoint <url>` and `--token <secret>`
2. Env vars: `MERIDIAN_ENDPOINT` and `MERIDIAN_ADMIN_TOKEN`
3. `./.dev.vars` — key/value lines like `wrangler` expects

This mirrors how `wrangler` loads its local secrets, so the same
`.dev.vars` powers both `wrangler dev` and the Meridian CLI.

## Token rotation

```bash
meridian gen-token --dev-vars                 # update local .dev.vars
wrangler secret put MERIDIAN_ADMIN_TOKEN      # paste the same value
wrangler deploy                                # apply
```

The CLI's `meridian doctor` flow confirms the deployed token matches
the local one — run it after every rotation.

## Zero-dependency

The CLI ships with no runtime dependencies. Arg parsing, HTTP, config
resolution are all hand-rolled against Node 22 built-ins (`fetch`,
`node:fs`, `node:crypto`). `pnpm dlx @loom-loyalty/meridian-cli init`
lands in seconds.
