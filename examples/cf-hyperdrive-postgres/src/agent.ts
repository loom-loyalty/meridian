/**
 * PostgresQueryOptimizer — a Meridian agent that watches
 * `pg_stat_statements`, spots consistently slow queries, and emits
 * `InsightFeedback` + creates a `proposed` `WorkItem` for the domain
 * steward to act on.
 *
 * Schedule: every 15 minutes via `ctx.schedule.cron`. The onSchedule
 * hook reads the view, persists an observation row, and — if a slow
 * query has been seen N consecutive ticks — emits an insight.
 *
 * Confidence math: `confidence = min(1.0, observations / 8)` — 8
 * consecutive ticks (~2 hours) to reach full confidence. Below that
 * we still emit, but with a lower confidence score so the priority
 * engine can down-weight it.
 *
 * Cost estimation (detector/estimator handoff, WORK-ITEM-SPEC §6):
 * this agent is a DETECTOR. It fills in `costOfNotBuilding` from the
 * measured query cost × estimated blast radius, and leaves
 * `costToBuild` as a zero / unknown estimate. A downstream estimator
 * agent (or human steward) sets `costToBuild` before the item
 * enters the queue.
 */

// The `/agent` subpath is the "lightweight" adopter entry — it
// exports defineAgent + types without pulling in the Workers-only
// agent-do.ts. Safe to import from node-side tests (vitest, ava,
// jest) that use createTestRuntime() for in-memory runs.
// `worker.ts` still imports the DO classes + createMeridianWorker
// from the main entry for wrangler deploy.
import type {
  AgentContext,
  AgentEnv,
  AgentSpec,
} from "@loom-loyalty/meridian-runtime-cloudflare/agent";
import { defineAgent } from "@loom-loyalty/meridian-runtime-cloudflare/agent";
import type {
  InsightFeedback,
  Timestamp,
  WorkItem,
} from "@loom-loyalty/meridian-types";

/**
 * This example extends `AgentEnv` with a Hyperdrive binding the
 * agent reads at each cron tick. Other bindings (KV, R2, Secrets)
 * layer on the same pattern.
 */
export interface PgMonitorEnv extends AgentEnv {
  HYPERDRIVE: Hyperdrive;
}

// Number of consecutive ticks a query must stay slow before we
// flag it as an insight. 4 × 15 min = 1 hour of sustained slowness.
const SUSTAINED_TICKS_THRESHOLD = 4;

// Mean-execution-time cutoff in milliseconds. Queries below this
// are ignored (fast queries can't justify a WorkItem even if they
// run frequently).
const SLOW_MEAN_MS_THRESHOLD = 50;

// Minimum call count. One-off slow query runs aren't actionable.
const MIN_CALL_COUNT = 20;

interface SlowQueryRow {
  queryid: bigint;
  query: string;
  calls: bigint;
  mean_exec_time: number;
  stddev_exec_time: number;
  total_exec_time: number;
}

interface TrackingState {
  /** queryid → consecutive-tick count at which we've seen it slow. */
  consecutiveTicks: Record<string, number>;
  /** queryid → last emission timestamp (ms). Dedupes emits. */
  lastEmittedAt: Record<string, number>;
}

/**
 * Build the agent spec. The agent module imports `defineAgent` and
 * this factory so adopter tests (`createTestRuntime`) can spawn
 * without touching the DO isolate.
 */
export const pgQueryOptimizer: AgentSpec = defineAgent({
  id: "pg-query-optimizer",
  domain: "infrastructure",

  async onSpawn(ctx) {
    // Seed the tracking state so the first scheduled run sees a
    // well-formed object. Idempotent on re-spawn (spawn is a no-op
    // when the (id, domain) match the existing DO per MRD-CF-LC-001
    // semantics).
    const existing = await ctx.state.load<TrackingState>("tracking");
    if (!existing) {
      await ctx.state.save("tracking", {
        consecutiveTicks: {},
        lastEmittedAt: {},
      } satisfies TrackingState);
    }
    // Every 15 minutes, on the minute. Croner handles DST + timezone;
    // this cron runs in UTC per CF default.
    await ctx.schedule.cron("*/15 * * * *", { tag: "poll-pg-stats" });
  },

  async onSchedule(ctx) {
    // Cast to our extended env shape so TS resolves the Hyperdrive
    // binding. The runtime itself doesn't know about HYPERDRIVE;
    // adopters bring their own bindings via wrangler.toml and
    // declare them through a subtype of AgentEnv.
    const env = ctx.env as PgMonitorEnv;
    if (!env.HYPERDRIVE) {
      ctx.obs.log({
        level: "warn",
        message:
          "[pg-query-optimizer] HYPERDRIVE binding missing; skipping tick",
        agentId: ctx.id,
        domain: ctx.domain,
        timestamp: Date.now() as Timestamp,
      });
      return;
    }

    const rows = await fetchSlowQueries(env.HYPERDRIVE);
    const tracking = (await ctx.state.load<TrackingState>("tracking")) ?? {
      consecutiveTicks: {},
      lastEmittedAt: {},
    };

    const now = Date.now() as Timestamp;
    const seenThisTick = new Set<string>();

    for (const row of rows) {
      const key = row.queryid.toString();
      seenThisTick.add(key);

      const prior = tracking.consecutiveTicks[key] ?? 0;
      const next = prior + 1;
      tracking.consecutiveTicks[key] = next;

      // Only emit when we've crossed the threshold AND we haven't
      // emitted for this query within the last hour (prevents
      // restarts from spamming steward inboxes).
      const lastEmit = tracking.lastEmittedAt[key] ?? 0;
      const emitCooldownMs = 60 * 60 * 1000;
      if (
        next >= SUSTAINED_TICKS_THRESHOLD &&
        now - lastEmit > emitCooldownMs
      ) {
        const insight = buildInsight(ctx, row, next, now);
        // Upsert pattern: the WorkItem id is stable (`wi-pg-${queryid}`)
        // so re-emissions overwrite the same entry. Load the existing
        // item first to preserve `createdAt` — only the adopter's
        // first emission sets the true creation time; subsequent
        // emissions bump `updatedAt` but leave `createdAt` alone.
        const workItemId = `wi-pg-${row.queryid.toString()}`;
        const existing = await ctx.state.load<WorkItem>(
          `workitems/${workItemId}`,
        );
        const workItem = buildWorkItem(ctx, row, now, existing?.createdAt);

        // Persist both into state. Insights are event-sourced (one
        // key per observation, timestamped); work items are entities
        // (single key per queryid, upserted). Adopters list by
        // prefix to pull either shape.
        await ctx.state.save(`insights/${now}-${key}`, insight);
        await ctx.state.save(`workitems/${workItem.id}`, workItem);

        tracking.lastEmittedAt[key] = now;

        ctx.obs.log({
          level: "info",
          message: `[pg-query-optimizer] emitted insight for queryid ${key} after ${next} sustained ticks`,
          agentId: ctx.id,
          domain: ctx.domain,
          timestamp: now,
          fields: {
            queryid: key,
            mean_ms: row.mean_exec_time,
            calls: Number(row.calls),
            workItemId: workItem.id,
          },
        });
        ctx.obs.metric("pg_query_optimizer.insight_emitted", 1, {
          queryid: key,
        });
      }
    }

    // Reset the streak for any query that WASN'T slow this tick.
    for (const key of Object.keys(tracking.consecutiveTicks)) {
      if (!seenThisTick.has(key)) {
        delete tracking.consecutiveTicks[key];
      }
    }

    await ctx.state.save("tracking", tracking);

    // Cost attribution: each tick consumes a small amount of CPU +
    // one Hyperdrive query. Report as 0 tokens / negligible USD so
    // adopters with cost caps see the rollup grow predictably.
    await ctx.resources.reportCost(0.0001, {
      workItemId: "pg-query-optimizer:poll",
    });
  },

  async onTerminate(ctx) {
    // Last chance to flush anything to an external store. We emit a
    // final heartbeat-ish log so observability backends see the agent
    // cleanly shutting down (vs a crash loop).
    ctx.obs.log({
      level: "info",
      message: `[pg-query-optimizer] terminating after clean shutdown`,
      agentId: ctx.id,
      domain: ctx.domain,
      timestamp: Date.now() as Timestamp,
    });
  },
});

// ── helpers ────────────────────────────────────────────────

async function fetchSlowQueries(
  hyperdrive: Hyperdrive,
): Promise<SlowQueryRow[]> {
  // `postgres` (porsager/postgres) is Workers-compatible when used
  // with Hyperdrive's connectionString. We keep the query tight and
  // parameterize both thresholds so an adopter can tune without
  // redeploying the query text.
  const { default: postgres } = await import("postgres");
  const sql = postgres(hyperdrive.connectionString, {
    // Workers runs each invocation in isolation; we use a small
    // single-connection pool per invocation and close on exit.
    max: 1,
    fetch_types: false,
  });
  try {
    return (await sql<SlowQueryRow[]>`
      SELECT
        queryid,
        query,
        calls,
        mean_exec_time,
        stddev_exec_time,
        total_exec_time
      FROM pg_stat_statements
      WHERE mean_exec_time >= ${SLOW_MEAN_MS_THRESHOLD}
        AND calls >= ${MIN_CALL_COUNT}
      ORDER BY total_exec_time DESC
      LIMIT 25
    `) as SlowQueryRow[];
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function buildInsight(
  ctx: AgentContext,
  row: SlowQueryRow,
  sustainedTicks: number,
  now: Timestamp,
): InsightFeedback {
  const confidence = Math.min(1.0, sustainedTicks / 8);
  const truncatedQuery =
    row.query.length > 200 ? row.query.slice(0, 200) + "…" : row.query;
  return {
    tier: "expected",
    type: "insight",
    agentId: ctx.id,
    domain: ctx.domain,
    confidence,
    summary: `Query has averaged ${row.mean_exec_time.toFixed(1)}ms over ${row.calls} calls across ${sustainedTicks} consecutive polls — candidate for index tuning or rewrite. Snippet: ${truncatedQuery}`,
    evidence: {
      queryid: row.queryid.toString(),
      mean_exec_time: row.mean_exec_time,
      stddev_exec_time: row.stddev_exec_time,
      calls: Number(row.calls),
      total_exec_time: row.total_exec_time,
      sustainedTicks,
    },
    suggestedAction:
      "Run EXPLAIN ANALYZE on the query, check for missing indexes, and consider adding or rewriting.",
    timestamp: now,
  };
}

function buildWorkItem(
  ctx: AgentContext,
  row: SlowQueryRow,
  now: Timestamp,
  createdAt: Timestamp | undefined,
): WorkItem {
  // costOfNotBuilding model: total_exec_time is ms spent running this
  // query since stats reset. Assume $0.001 per ms of DB CPU (round
  // figure for a small managed Postgres tier); scale up to a monthly
  // cost estimate by projecting the observed rate forward.
  // Adopters should replace this heuristic with their infrastructure
  // pricing when they deploy.
  const estimatedMonthlyUsdImpact = Math.max(
    10,
    Math.round(row.total_exec_time * 0.001 * 30),
  );

  return {
    // Stable id keyed only on queryid so repeat emissions (every hour
    // a query stays slow) upsert the SAME WorkItem rather than
    // creating duplicates. Downstream systems that dedupe on id get
    // clean semantics. If adopters need a historical emission trail,
    // they pull it from the `insights/${now}-${queryid}` keys (which
    // DO include a timestamp — each observation is its own event).
    id: `wi-pg-${row.queryid.toString()}`,
    type: "task",
    title: `Investigate slow Postgres query ${row.queryid.toString()}`,
    description: row.query.slice(0, 500),
    domains: [ctx.domain],
    source: "agent",
    sourceAgentId: ctx.id,
    // DETECTOR fills costOfNotBuilding; a downstream estimator (or
    // human) sets costToBuild before the item enters the priority
    // queue. Leaving it at zero is the "unknown; please estimate"
    // signal per WORK-ITEM-SPEC §6.
    costToBuild: {
      amountUsd: 0,
      basis:
        "pending estimator handoff — no cost-to-build estimate from the detector agent",
    },
    costOfNotBuilding: {
      amountUsd: estimatedMonthlyUsdImpact,
      breakdown: {
        compute: estimatedMonthlyUsdImpact,
      },
      basis: `total_exec_time=${row.total_exec_time.toFixed(0)}ms × $0.001/ms × 30 (month projection)`,
      providedBy: ctx.domain,
      estimatorAgentId: ctx.id,
    },
    confidence: Math.min(1.0, Number(row.calls) / 1000),
    status: "proposed",
    createdAt: createdAt ?? now,
    updatedAt: now,
  };
}

// `Hyperdrive` comes from `@cloudflare/workers-types` as an ambient
// global. The package is a devDep of this example, so the global is
// always in scope. See package.json → devDependencies.
