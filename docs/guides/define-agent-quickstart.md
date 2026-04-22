# `defineAgent()` quickstart

Ten-line agent on Cloudflare Workers, walked line by line. Assumes
you've already run `meridian init` and installed dependencies.

## The agent

```ts
// src/agent.ts
import { defineAgent } from "@loom-loyalty/meridian-runtime-cloudflare";

defineAgent({
  id: "hello",
  domain: "demo",
  async onSpawn(ctx) {
    ctx.obs.log({ level: "info", message: "[hello] spawned" });
    await ctx.schedule.cron("*/5 * * * *");
  },
  async onSchedule(ctx, fire) {
    ctx.obs.log({
      level: "info",
      message: `[hello] ${fire.scheduleId} fired at ${fire.firedAt}`,
    });
  },
});
```

That's it. Ten lines, one agent, runs every five minutes.

## Line by line

**`import { defineAgent } from "@loom-loyalty/meridian-runtime-cloudflare";`**
The only import you need for basic agents. `defineAgent` registers the
spec in a module-level registry that `createMeridianWorker` reads at
construction time.

**`id: "hello"`**
Stable identifier. Must match the `id` in `createMeridianWorker({agents: [...]})`
so the worker knows to spawn this agent. In multi-tenant mode, two
agents can share the same id as long as they're in different tenants
— the DO namespacing handles isolation.

**`domain: "demo"`**
Organizational bucket. Agents in the same domain can broadcast to
each other; cross-domain broadcasts are possible but explicit (via
`selector.domain`).

**`async onSpawn(ctx)`**
Fires once per DO lifetime, right after the DO registers in the
tenant's registry shard. Common uses:

- Install cron schedules (`ctx.schedule.cron(...)`)
- Seed initial state (`ctx.state.save("counter", 0)`)
- Register with an external system

If `onSpawn` throws, the DO is still considered spawned (the meta
write landed before the hook). The error is captured via the
observability surface as `meridian.hook.errors` + an
`ErrorFeedback`-shaped log line.

**`ctx.obs.log({ level: "info", message: "..." })`**
Structured log. Tags like `agentId`, `domain`, and (multi-tenant)
`tenantId` are added automatically from the DO's meta. Logs flow to
Workers Logs by default (see `[observability]` in `wrangler.toml`).

**`await ctx.schedule.cron("*/5 * * * *")`**
Standard 5-field cron. Fires every 5 minutes (0, 5, 10, ...). The
first fire lands at the next-matching wall-clock minute after spawn.

**`async onSchedule(ctx, fire)`**
Fires once per schedule fire, with a `fire` object containing
`scheduleId`, `firedAt`, and any `payload` passed to `scheduleAt` /
`scheduleCron`.

Peek-and-ack semantics: if `onSchedule` throws, the fire is still
acked (adopter error = delivered). If the DO crashes mid-hook before
the ack writes, the fire replays on the next alarm. At-least-once
per RUNTIME-SPEC §4.3.

## What's in `ctx`?

```ts
interface AgentContext {
  id: AgentId;
  domain: DomainId;
  env: AgentEnv;              // full CF env — bindings, secrets, etc

  state: {
    save(k, v): Promise<void>
    load<T>(k): Promise<T | undefined>
    delete(k): Promise<void>
    list(opts?): Promise<ListResult>
    update<T>(k, fn): Promise<T>   // hook-context only; atomic read-modify-write
  };

  transport: {
    send(toId, payload): Promise<MessageReceipt>
    broadcast(selector, payload): Promise<BroadcastReceipt>
  };

  schedule: {
    at(when, payload?): Promise<ScheduleId>
    cron(pattern, payload?): Promise<ScheduleId>
    cancel(id): Promise<void>
  };

  resources: {
    setLimits(l): Promise<void>
    getLimits(): Promise<ResourceLimits>
    getUsage(): Promise<ResourceUsage>
    onLimitEvent(h): Promise<void>
    reportTokens(n, attribution?): Promise<void>
    reportCost(usd, attribution?): Promise<void>
    getUsageByWorkItem(wid?): Promise<...>
    beginOperation(): Promise<() => Promise<void>>  // returns an "end" callback
  };

  obs: {
    log(entry): void
    metric(name, value, tags?): void
    startSpan(name, parentSpanId?): Span
  };
}
```

Everything on `ctx` is synchronous to call (returns `Promise`s). No
teardown or cleanup needed — the DO's input gate serializes access.

## Hooks beyond `onSpawn` / `onSchedule`

```ts
defineAgent({
  id: "pg-optimizer",
  domain: "infrastructure",

  async onSpawn(ctx) {
    /* ... */
  },

  // Called once per inbound message, after the message lands in
  // storage. At-least-once per (sender, recipient) pair.
  async onMessage(ctx, msg) {
    const text = new TextDecoder().decode(msg.payload);
    console.log(`[${msg.fromAgentId}] ${text}`);
  },

  async onSchedule(ctx, fire) {
    /* ... */
  },

  // Called right before terminate() wipes state. Use for flushing
  // in-flight work, not for cleanup of DO storage (that's
  // automatic).
  async onTerminate(ctx) {
    const inflight = await ctx.state.load<number>("inflight");
    ctx.obs.log({
      level: "warn",
      message: `[pg-optimizer] terminating with ${inflight} inflight`,
    });
  },
});
```

## Wiring to the worker

```ts
// src/worker.ts
import {
  AgentDurableObject,
  RegistryDurableObject,
  createMeridianWorker,
} from "@loom-loyalty/meridian-runtime-cloudflare";

// This side-effects the defineAgent call in ./agent.ts.
import "./agent.js";

export { AgentDurableObject, RegistryDurableObject };

export default createMeridianWorker({
  agents: [{ id: "hello", domain: "demo" }],
  auth: { bearer: "..." }, // from env
});
```

The `agents` array passed to `createMeridianWorker` is the
agent-registration source of truth. Every entry must correspond to a
`defineAgent` call at module-load time. Passing an agent id that
was never `defineAgent`'d isn't an error — it just means `onSpawn`
/ `onMessage` / `onSchedule` hooks won't fire for that id.

## Next steps

- [meridian doctor troubleshooting](doctor-troubleshooting.md) — run diagnostics after deploy
- [AgentCard securitySchemes](agent-card-security-schemes.md) — how auth is advertised
- [Tenancy invariants](tenancy-invariants.md) — scaling beyond one tenant
- [`MERIDIAN-IN-PRACTICE.md` Ch 1](../../specs/MERIDIAN-IN-PRACTICE.md) — a real agent end-to-end (`cf-hyperdrive-postgres`)
