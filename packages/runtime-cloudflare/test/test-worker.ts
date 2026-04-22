/**
 * Test harness Worker entry.
 *
 * Miniflare needs a Worker module to boot the DO isolates. Tests exercise
 * the DOs via RPC directly; this fetch handler is intentionally small.
 * Adopters write their own `worker.ts` and bind their agent specs via
 * `createMeridianWorker()`.
 *
 * Two routes:
 *   • `GET /` — smoke-check payload the e2e-cloudflare workflow asserts
 *     on. Keep the `.runtime` and `.milestone` fields stable; adding
 *     fields is fine.
 *   • `GET /conformance` — runs the runtime conformance suite
 *     in-Worker (scenarios with `appliesTo` including `"real-cf"`) and
 *     returns `{summary, results}` as JSON. The E2E workflow asserts
 *     `summary.failed === 0`.
 */

import {
  runRuntimeConformance,
  runtimeScenarios,
  summarizeConformance,
  type AgentRef,
  type Runtime,
} from "@loom-loyalty/meridian-conformance/runtime";

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

export default {
  async fetch(req: Request, env: TestHarnessEnv): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/conformance") {
      const results = await runRuntimeConformance(
        realCfRuntime(env),
        runtimeScenarios,
      );
      const summary = summarizeConformance(results);
      return new Response(JSON.stringify({ summary, results }, null, 2), {
        status: summary.failed === 0 ? 200 : 500,
        headers: { "content-type": "application/json" },
      });
    }

    const body = {
      runtime: "meridian-cloudflare",
      milestone: "m1-walking-skeleton",
      healthy: true,
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
};
