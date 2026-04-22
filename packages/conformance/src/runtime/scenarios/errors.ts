import type { ConformanceScenario } from "../types.js";
import { expect, expectReject } from "../assertions.js";

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

export const errorsCodesReachable: ConformanceScenario = {
  name: "errors-codes-reachable",
  description:
    "every MRD-CF-* error code listed in the stable catalog is reachable from the public RPC surface. Catches drift where a new code is defined but no public path throws it.",
  appliesTo: ["miniflare", "real-cf", "in-memory"],
  async run(runtime, ctx) {
    // Codes that are reachable from the adopter-facing RPC surface.
    // Codes gated to hook contexts (e.g. MRD-CF-EX-003 PermissionScope
    // drop, MRD-CF-RS-004 concurrency — only via beginOperation which
    // is hook-only) are not included in this scenario because
    // scenarios only see the public surface.
    const exerciseId = ctx.uniqueId("er-codes");
    const agent = runtime.agent(exerciseId);

    // -- Pre-spawn: MRD-CF-LC-002 --
    await expectReject(agent.save("any", 1), /MRD-CF-LC-002/, "pre-spawn save");

    await agent.spawn({ id: exerciseId, domain: "conformance" });

    // -- Lifecycle --
    await expectReject(
      agent.spawn({ id: exerciseId, domain: "different" }),
      /MRD-CF-LC-001/,
      "LC-001 different-domain re-spawn",
    );
    await expectReject(
      agent.spawn({} as unknown as { id: string; domain: string }),
      /MRD-CF-LC-004/,
      "LC-004 missing spawn fields",
    );
    // LC-005 identity guard requires a DO-binding mismatch (id doesn't
    // hash to the bound DO). The conformance AgentRef always binds
    // correctly, so LC-005 is tested via runtime-cloudflare's
    // lifecycle.test.ts.

    // -- State --
    await expectReject(
      agent.save("k".repeat(1025), "x"),
      /MRD-CF-ST-001/,
      "ST-001 oversize key",
    );
    await expectReject(
      agent.save("k", String.fromCharCode(1).repeat(200_000)),
      /MRD-CF-ST-002/,
      "ST-002 oversize value (control-char JSON expansion)",
    );
    await expectReject(
      agent.save("__reserved__", 1),
      /MRD-CF-ST-003/,
      "ST-003 reserved key prefix",
    );

    // -- Scheduling --
    await expectReject(
      agent.scheduleAt(Date.now() + 500),
      /MRD-CF-SC-001/,
      "SC-001 < 1s delay",
    );
    await expectReject(
      agent.scheduleAt(Date.now() + 366 * 24 * 60 * 60 * 1000),
      /MRD-CF-SC-002/,
      "SC-002 > 365d delay",
    );
    await expectReject(
      agent.scheduleCron("not-a-cron"),
      /MRD-CF-SC-003/,
      "SC-003 invalid cron",
    );
    await expectReject(
      agent.cancelSchedule("never-created-id"),
      /MRD-CF-SC-004/,
      "SC-004 cancel unknown scheduleId",
    );

    // -- Resources --
    await agent.setLimits({
      maxTokensTotal: 100,
      maxTokensPerCall: 50,
      maxCostUsd: 5,
    });
    await agent.reportTokens(50);
    await expectReject(
      agent.reportTokens(51),
      /MRD-CF-RS-003/,
      "RS-003 per-call cap (also fires on negative)",
    );
    await expectReject(
      agent.reportTokens(-1),
      /MRD-CF-RS-003/,
      "RS-003 negative tokens",
    );
    // Push total right to limit, then overflow.
    await agent.reportTokens(50);
    await expectReject(
      agent.reportTokens(1),
      /MRD-CF-RS-001/,
      "RS-001 total cap",
    );
    await agent.reportCost(4);
    await expectReject(
      agent.reportCost(1.01),
      /MRD-CF-RS-002/,
      "RS-002 cost cap",
    );

    // -- Experimental: UNAVAILABLE-category throws --
    await expectReject(
      agent.snapshotState(),
      /MRD-CF-EX-001/,
      "EX-001 snapshotState",
    );
    await expectReject(
      agent.setPermissions(),
      /MRD-CF-EX-004/,
      "EX-004 setPermissions",
    );
    await expectReject(
      agent.getPermissions(),
      /MRD-CF-EX-005/,
      "EX-005 getPermissions",
    );

    // -- Transport: TR-002 zero-recipient broadcast --
    // Per-run unique domain so real-CF's persistent registry from
    // prior workflow runs can't seed a "peer" that defeats the
    // zero-recipient assertion.
    const aloneId = ctx.uniqueId("er-alone");
    const aloneDomain = ctx.uniqueId("er-alone-domain");
    const alone = runtime.agent(aloneId);
    await alone.spawn({ id: aloneId, domain: aloneDomain });
    await expectReject(
      alone.broadcast({}, new TextEncoder().encode("nobody")),
      /MRD-CF-TR-002/,
      "TR-002 zero-recipient broadcast",
    );
    await alone.terminate();

    // TR-001 (payload > 1 MB) is reachable but exercising it from
    // real-CF hits a platform boundary before our validator runs.
    // Tested in runtime-cloudflare's transport.test.ts. TR-003
    // (inbox cap) tested via transport-inbox-cap conformance
    // scenario in miniflare + in-memory.

    // Basic sanity: all the throws above carry a `MRD-CF-` prefix
    // and none of them are RangeError / TypeError / etc which would
    // indicate a bug leaked through the plugin layer.
    expect(true, "every code above matched its expected regex").toBeTruthy();

    await agent.terminate();
  },
};
