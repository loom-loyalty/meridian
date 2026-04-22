/**
 * Worker entrypoint for the cf-hyperdrive-postgres example.
 *
 * Binds the agent from `./agent.ts` into a `createMeridianWorker`
 * handler and re-exports the DO classes so wrangler can wire them.
 * A one-time GET `/bootstrap` triggers the initial spawn — after
 * that, the agent runs entirely on its own cron schedule.
 *
 * See `README.md` for the deploy walkthrough.
 */

import {
  AgentDurableObject,
  RegistryDurableObject,
  createMeridianWorker,
} from "@loom-loyalty/meridian-runtime-cloudflare";

import type { AgentEnv } from "@loom-loyalty/meridian-runtime-cloudflare";

import { pgQueryOptimizer } from "./agent.js";

export { AgentDurableObject, RegistryDurableObject };

// Note: once M4 ships admin routes with auth, `/bootstrap` moves
// behind the AuthPlugin. For v0.1 the route is open; deploy this
// example to a private `workers.dev` subdomain and never expose it
// publicly.
export default createMeridianWorker({
  agents: [pgQueryOptimizer],
  agentCard: {
    name: "pg-query-optimizer-worker",
    description:
      "Meridian PostgresQueryOptimizer — polls pg_stat_statements and emits InsightFeedback + proposed WorkItems",
  },
  routes: {
    // One-shot bootstrap: idempotently spawn the monitor agent.
    // Hit once after `wrangler deploy`; the onSpawn hook installs
    // the cron schedule, and every poll thereafter runs via the
    // DO's alarm handler.
    "POST /bootstrap": async (_req, env) => {
      const e = env as AgentEnv;
      const stub = e.AGENT.get(
        e.AGENT.idFromName("pg-query-optimizer"),
      ) as unknown as DurableObjectStub<AgentDurableObject>;
      const handle = await stub.spawn({
        id: "pg-query-optimizer",
        domain: "infrastructure",
      });
      return new Response(JSON.stringify({ bootstrapped: handle }, null, 2), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    // Inspect collected insights + work items without spinning up
    // an admin UI. Drops under a prefix so adopters can list both.
    "GET /insights": async (_req, env) => {
      const e = env as AgentEnv;
      const stub = e.AGENT.get(
        e.AGENT.idFromName("pg-query-optimizer"),
      ) as unknown as DurableObjectStub<AgentDurableObject>;
      const insightKeys = await stub.list({ prefix: "insights/" });
      const workItemKeys = await stub.list({ prefix: "workitems/" });
      return new Response(
        JSON.stringify(
          { insightKeys: insightKeys.keys, workItemKeys: workItemKeys.keys },
          null,
          2,
        ),
        { headers: { "content-type": "application/json" } },
      );
    },
  },
});
