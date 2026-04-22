import type { ConformanceScenario } from "../types.js";
import { expect } from "../assertions.js";

/**
 * Fan-out spawn + broadcast load scenario.
 *
 * Why it exists: every other scenario exercises a small, fixed number
 * of agents. Real adopters run far more agents per domain, and the
 * RegistryDO + mailbox DOs need to handle parallel access without
 * dropping writes or double-delivering messages. This scenario spawns
 * N agents in the same domain in parallel, then broadcasts once from
 * each, then asserts every recipient's inbox ended up with exactly
 * N-1 messages.
 *
 * N=12 is deliberately conservative. Each scenario runs inside a
 * single Worker invocation on real-CF; the CPU budget is ~30s. N=12
 * fan-out is 12 spawns + 12 broadcasts + 12 receiveAll calls + 12
 * terminates = ~48 DO RPCs. Comfortably under the budget without
 * being trivial.
 */
export const concurrencySpawnBroadcastFanout: ConformanceScenario = {
  name: "concurrency-spawn-broadcast-fanout",
  description:
    "N parallel spawns in a domain + N parallel broadcasts → every recipient's inbox ends with exactly N-1 messages. Exercises RegistryDO + mailbox DO concurrency.",
  appliesTo: ["miniflare", "real-cf", "in-memory"],
  async run(runtime, ctx) {
    const N = 12;
    const domain = ctx.uniqueId("conc-dom");
    const ids = Array.from({ length: N }, (_, i) => ctx.uniqueId(`conc-${i}`));

    // Phase 1 — parallel spawn. RegistryDO.register() is the hot
    // path; `Promise.all` drives all inserts concurrently.
    const agents = ids.map((id) => runtime.agent(id));
    await Promise.all(agents.map((a, i) => a.spawn({ id: ids[i]!, domain })));

    // Phase 2 — parallel broadcast. Each agent broadcasts once with
    // an empty selector (same-domain default). Expected recipients
    // per broadcast = N - 1 (excludes sender).
    const payload = new TextEncoder().encode("fanout-ping");
    const receipts = await Promise.all(
      agents.map((a) => a.broadcast({}, payload)),
    );
    for (const r of receipts) {
      expect(r.recipientCount, "each broadcast reaches N-1 peers").toBe(N - 1);
    }

    // Phase 3 — every inbox should have exactly N-1 messages. If
    // RegistryDO dropped a write or a mailbox DO missed a deliver,
    // this count is wrong and the scenario fails loud.
    const inboxes = await Promise.all(agents.map((a) => a.receiveAll()));
    for (let i = 0; i < N; i++) {
      expect(inboxes[i]!.length, `agent ${ids[i]} inbox length`).toBe(N - 1);
    }

    // Phase 4 — cleanup. Terminating all N in parallel also
    // exercises RegistryDO.unregister() under concurrency.
    await Promise.all(agents.map((a) => a.terminate()));
  },
};
