import type { ConformanceScenario } from "../types.js";
import { expectReject } from "../assertions.js";

export const experimentalUnavailable: ConformanceScenario = {
  name: "experimental-unavailable",
  description:
    "experimental methods (snapshotState, setPermissions, getPermissions) MUST throw an UNAVAILABLE-category error in v0.1.",
  appliesTo: ["miniflare", "real-cf", "in-memory"],
  async run(runtime, ctx) {
    const id = ctx.uniqueId("ex-unavail");
    const agent = runtime.agent(id);
    await agent.spawn({ id, domain: "conformance" });

    await expectReject(agent.snapshotState(), /MRD-CF-EX-001/, "snapshotState");
    await expectReject(
      agent.setPermissions(),
      /MRD-CF-EX-004/,
      "setPermissions",
    );
    await expectReject(
      agent.getPermissions(),
      /MRD-CF-EX-005/,
      "getPermissions",
    );

    await agent.terminate();
  },
};
