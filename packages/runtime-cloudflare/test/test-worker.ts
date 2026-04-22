/**
 * Test harness Worker entry.
 *
 * Miniflare needs a Worker module to boot the DO isolates. We wire
 * the adopter-facing `createMeridianWorker` helper with a custom
 * `/conformance` route so the E2E workflow can drive the suite on
 * real CF. This also eats our own dogfood: if the helper regresses,
 * the entire test harness stops working, which the walking-skeleton
 * + worker-routes tests catch fast.
 *
 * Three routes active here:
 *   • `GET /`                             — healthy status (helper built-in)
 *   • `GET /.well-known/agent-card.json`  — discovery (helper built-in)
 *   • `GET /conformance?offset&limit`     — custom route running the
 *                                           runtime conformance suite
 *                                           against the live deploy
 *
 * All other adopter-facing built-ins (`/agents/*`) are available
 * too — the Miniflare tests for those live in `worker-routes.test.ts`.
 */

import {
  runRuntimeConformance,
  runtimeScenarios,
  summarizeConformance,
  type AgentRef,
  type Runtime,
} from "@loom-loyalty/meridian-conformance/runtime";

import { createMeridianWorker } from "../src/create-meridian-worker.js";

export { AgentDurableObject } from "../src/agent-do.js";
export { RegistryDurableObject } from "../src/registry-do.js";

import type { AgentDurableObject as _ADO } from "../src/agent-do.js";
import type { RegistryDurableObject as _RDO } from "../src/registry-do.js";

interface TestHarnessEnv {
  AGENT: DurableObjectNamespace<_ADO>;
  REGISTRY: DurableObjectNamespace<_RDO>;
}

function realCfRuntime(env: TestHarnessEnv): Runtime {
  return {
    kind: "real-cf",
    agent(id): AgentRef {
      const stub = env.AGENT.get(
        env.AGENT.idFromName(id),
      ) as unknown as DurableObjectStub<_ADO>;
      return {
        spawn: (c) => stub.spawn(c),
        terminate: () => stub.terminate(),
        exists: () => stub.exists(),
        get: () => stub.get(),
        save: (k, v) => stub.save(k, v),
        load: (k) => stub.load(k),
        delete: (k) => stub.delete(k),
        list: (o) => stub.list(o),
        incrementAtomic: (k, d) => stub.incrementAtomic(k, d),
        scheduleAt: (w, p) => stub.scheduleAt(w, p),
        scheduleCron: (c, p) => stub.scheduleCron(c, p),
        cancelSchedule: (sid) => stub.cancelSchedule(sid),
        listSchedules: () => stub.listSchedules(),
        send: (to, p) => stub.send(to, p),
        broadcast: (sel, p) => stub.broadcast(sel, p),
        receiveAll: () => stub.receiveAll(),
        drainInbox: () => stub.drainInbox(),
        setLimits: (l) => stub.setLimits(l),
        getLimits: () => stub.getLimits(),
        getUsage: () => stub.getUsage(),
        reportTokens: (n, attr) => stub.reportTokens(n, attr),
        reportCost: (u, attr) => stub.reportCost(u, attr),
        getUsageByWorkItem: (wid) => stub.getUsageByWorkItem(wid),
        snapshotState: () => stub.snapshotState(),
        setPermissions: () => stub.setPermissions(),
        getPermissions: () => stub.getPermissions(),
      };
    },
    async runAlarm() {
      // workerd fires alarms outside the Worker invocation budget;
      // real-cf applicable scenarios do not call this (see
      // scheduling-fires gate).
    },
    async sleep(ms) {
      await new Promise((r) => setTimeout(r, ms));
    },
  };
}

export default createMeridianWorker({
  // No adopter-provided agents in the test harness. Scenarios spawn
  // agents dynamically via the Runtime abstraction; the harness just
  // needs DO bindings + the /conformance route.
  agents: [],
  agentCard: {
    name: "meridian-runtime-cloudflare-ci",
    description: "E2E harness for the Meridian CF runtime adapter",
  },
  routes: {
    "GET /conformance": async (req, env) => {
      const url = new URL(req.url);
      // Batching support: the suite runs ~32 scenarios serially, each
      // of which hits 5-25 DO RPCs. Cold-start DOs + serial RPC cost
      // pushes the whole suite over the ~30s Worker CPU budget on
      // real CF. Accept `?offset=N&limit=M` so the E2E workflow can
      // page through the scenarios across multiple Worker invocations
      // and combine the results. Defaults preserve the single-shot
      // behavior for local / Miniflare callers.
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = url.searchParams.get("limit");
      const windowEnd =
        limit !== null && limit !== ""
          ? offset + Number(limit)
          : runtimeScenarios.length;
      const window = runtimeScenarios.slice(offset, windowEnd);

      const results = await runRuntimeConformance(
        realCfRuntime(env as TestHarnessEnv),
        window,
      );
      const summary = summarizeConformance(results);
      return new Response(
        JSON.stringify(
          {
            offset,
            limit: limit ?? null,
            total: runtimeScenarios.length,
            summary,
            results,
          },
          null,
          2,
        ),
        {
          status: summary.failed === 0 ? 200 : 500,
          headers: { "content-type": "application/json" },
        },
      );
    },
  },
});
