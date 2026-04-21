# @loom-loyalty/meridian-runtime-cloudflare

Cloudflare Workers + Durable Objects reference runtime for the
[Meridian protocol](../../specs/core/RUNTIME-SPEC.md).

## Status

**Pre-alpha, M1 walking skeleton.** This is the first milestone of the
v0.1 runtime-cloudflare adapter. It ships the five walking-skeleton
primitives: spawn → save → load → send → receive → terminate, verified
under Miniflare via `@cloudflare/vitest-pool-workers`. The full six
stable runtime primitives (lifecycle, state, scheduling, transport,
resources, observability), WebSocket transport, AgentCard endpoint,
admin routes, and bearer auth land in M2+.

See
[`~/.claude/plans/enter-plan-mode-to-delegated-dawn.md`](../../../../..) for
the full plan. Do not use this package in production yet.

## Usage (preview)

```ts
import {
  createMeridianWorker,
  defineAgent,
  AgentDurableObject,
  RegistryDurableObject,
} from "@loom-loyalty/meridian-runtime-cloudflare";

const monitor = defineAgent({
  id: "pg-query-optimizer-prod",
  domain: "infrastructure",
});

export default createMeridianWorker({ agents: [monitor] });
export { AgentDurableObject, RegistryDurableObject };
```

`wrangler.toml.example` shows the bindings and SQLite migration your
Worker needs.

## License

Apache 2.0.
