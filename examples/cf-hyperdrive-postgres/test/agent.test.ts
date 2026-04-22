/**
 * Adopter unit tests for `pgQueryOptimizer`.
 *
 * Pattern: `createTestRuntime()` gives us an in-memory runtime that
 * implements the same AgentContext contract as the CF adapter —
 * millisecond setup, no Miniflare boot. The agent's hooks run in
 * the test process, so we can verify business logic (insight emission
 * thresholds, WorkItem shape, cost attribution) without any
 * Postgres or Hyperdrive.
 *
 * The `fetchSlowQueries` call inside `onSchedule` would normally
 * import `postgres` and hit a real database. The test replaces
 * that path by stubbing `ctx.env.HYPERDRIVE` to undefined — the
 * agent logs a warning and early-returns, letting the rest of the
 * hook wiring (cron registration, cost reporting) still run.
 *
 * Adopters who want to test the "slow query detected" path stub
 * `globalThis.postgres` via vitest's `vi.mock()` — not shown here
 * to keep the example focused on the Meridian-side contract.
 */

import { createTestRuntime } from "@loom-loyalty/meridian-runtime-cloudflare/testing";
import { describe, it, expect, beforeEach } from "vitest";

// Import for side effect — this registers the agent in the module
// registry that `createTestRuntime` looks up from.
import "../src/agent.js";

describe("pgQueryOptimizer (in-memory runtime)", () => {
  let runtime: ReturnType<typeof createTestRuntime>;

  beforeEach(() => {
    runtime = createTestRuntime();
  });

  it("spawn seeds the tracking state + registers the cron schedule", async () => {
    const agent = runtime.agent("pg-query-optimizer");
    await agent.spawn({ id: "pg-query-optimizer", domain: "infrastructure" });

    // Tracking state is initialized.
    const tracking = await agent.load<{
      consecutiveTicks: Record<string, number>;
      lastEmittedAt: Record<string, number>;
    }>("tracking");
    expect(tracking).toEqual({
      consecutiveTicks: {},
      lastEmittedAt: {},
    });

    // Cron is armed.
    const schedules = await agent.listSchedules();
    expect(schedules).toHaveLength(1);
    expect(schedules[0]?.type).toBe("cron");
    expect(schedules[0]?.cron).toBe("*/15 * * * *");
    expect(schedules[0]?.payload).toEqual({ tag: "poll-pg-stats" });

    await agent.terminate();
  });

  it("spawn is idempotent — re-spawn with same (id, domain) is a no-op", async () => {
    const agent = runtime.agent("pg-query-optimizer");
    await agent.spawn({ id: "pg-query-optimizer", domain: "infrastructure" });
    await agent.spawn({ id: "pg-query-optimizer", domain: "infrastructure" });

    // Tracking and schedules should be unchanged (one schedule, not two).
    const schedules = await agent.listSchedules();
    expect(schedules).toHaveLength(1);

    await agent.terminate();
  });

  it("re-spawn with a different domain throws MRD-CF-LC-001", async () => {
    const agent = runtime.agent("pg-query-optimizer");
    await agent.spawn({ id: "pg-query-optimizer", domain: "infrastructure" });

    await expect(
      agent.spawn({ id: "pg-query-optimizer", domain: "product" }),
    ).rejects.toThrow(/MRD-CF-LC-001/);

    await agent.terminate();
  });

  it("scenario pattern: after spawn, adopter-code lists insight/workitem keys", async () => {
    // Demonstrates how an adopter's ingestion / monitoring code
    // would poll the agent's state. With no real Hyperdrive in
    // createTestRuntime, no insights are emitted — but the list()
    // surface is what ingestion code uses.
    const agent = runtime.agent("pg-query-optimizer");
    await agent.spawn({ id: "pg-query-optimizer", domain: "infrastructure" });

    const insightKeys = await agent.list({ prefix: "insights/" });
    expect(insightKeys.keys).toEqual([]);

    const workItemKeys = await agent.list({ prefix: "workitems/" });
    expect(workItemKeys.keys).toEqual([]);

    await agent.terminate();
  });
});
