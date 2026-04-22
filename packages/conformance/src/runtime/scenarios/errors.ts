import type { ConformanceScenario } from "../types.js";
import { expectReject } from "../assertions.js";

export const errorsCategorized: ConformanceScenario = {
  name: "errors-categorized",
  description:
    "common failure modes surface stable MRD-CF-* codes. Adopters pattern-match these in their own error handlers.",
  appliesTo: ["miniflare", "real-cf", "in-memory"],
  async run(runtime, ctx) {
    const id = ctx.uniqueId("er-cat");
    const agent = runtime.agent(id);

    // MRD-CF-LC-002 — pre-spawn access.
    await expectReject(agent.getUsage(), /MRD-CF-LC-002/, "pre-spawn getUsage");

    await agent.spawn({ id, domain: "conformance" });

    // MRD-CF-LC-001 — re-spawn with different domain.
    await expectReject(
      agent.spawn({ id, domain: "other" }),
      /MRD-CF-LC-001/,
      "re-spawn different domain",
    );

    // MRD-CF-LC-004 — missing id/domain.
    await expectReject(
      agent.spawn({} as unknown as { id: string; domain: string }),
      /MRD-CF-LC-004/,
      "missing spawn fields",
    );

    // MRD-CF-ST-003 — reserved prefix.
    await expectReject(agent.save("__x__", 1), /MRD-CF-ST-003/, "reserved key");

    // MRD-CF-SC-001 — schedule below 1s.
    await expectReject(
      agent.scheduleAt(Date.now() + 100),
      /MRD-CF-SC-001/,
      "schedule < 1s",
    );

    // MRD-CF-SC-003 — bad cron.
    await expectReject(
      agent.scheduleCron("???"),
      /MRD-CF-SC-003/,
      "bad cron pattern",
    );

    // MRD-CF-EX-001 — experimental.
    await expectReject(
      agent.snapshotState(),
      /MRD-CF-EX-001/,
      "snapshotState experimental",
    );

    await agent.terminate();
  },
};
