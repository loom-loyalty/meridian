import type { ConformanceScenario } from "../types.js";
import { expect, expectReject } from "../assertions.js";

export const resourcesLimitsRoundTrip: ConformanceScenario = {
  name: "resources-limits-round-trip",
  description: "setLimits / getLimits preserves every declared field.",
  appliesTo: ["miniflare", "real-cf", "in-memory"],
  async run(runtime, ctx) {
    const id = ctx.uniqueId("rs-limits");
    const agent = runtime.agent(id);
    await agent.spawn({ id, domain: "conformance" });

    await agent.setLimits({
      maxTokensTotal: 10_000,
      maxTokensPerCall: 500,
      maxCostUsd: 25.0,
      maxConcurrency: 5,
    });
    const limits = await agent.getLimits();
    expect(limits.maxTokensTotal, "maxTokensTotal").toBe(10_000);
    expect(limits.maxTokensPerCall, "maxTokensPerCall").toBe(500);
    expect(limits.maxCostUsd, "maxCostUsd").toBe(25.0);
    expect(limits.maxConcurrency, "maxConcurrency").toBe(5);

    await agent.terminate();
  },
};

export const resourcesEnforcement: ConformanceScenario = {
  name: "resources-enforcement",
  description:
    "reportTokens over cap → MRD-CF-RS-001 (total) / MRD-CF-RS-003 (per-call); reportCost over cap → MRD-CF-RS-002. Counter preserved on reject.",
  appliesTo: ["miniflare", "real-cf", "in-memory"],
  async run(runtime, ctx) {
    const id = ctx.uniqueId("rs-enforce");
    const agent = runtime.agent(id);
    await agent.spawn({ id, domain: "conformance" });
    await agent.setLimits({
      maxTokensTotal: 1_000,
      maxTokensPerCall: 500,
      maxCostUsd: 10,
    });

    await agent.reportTokens(400);
    await expectReject(
      agent.reportTokens(700),
      /MRD-CF-RS-003/,
      "per-call cap",
    );
    await expectReject(
      agent.reportTokens(700),
      /MRD-CF-RS-003/,
      "per-call cap (second)",
    );
    // 400 + 400 = 800 OK, next 201 pushes past 1000 total.
    await agent.reportTokens(400);
    await expectReject(agent.reportTokens(201), /MRD-CF-RS-001/, "total cap");
    expect(
      (await agent.getUsage()).current.tokensLifetime,
      "lifetime preserved after reject",
    ).toBe(800);

    await agent.reportCost(9.5);
    await expectReject(agent.reportCost(1), /MRD-CF-RS-002/, "cost cap");

    await agent.terminate();
  },
};

export const resourcesNegativeReports: ConformanceScenario = {
  name: "resources-negative-reports",
  description: "negative report values are rejected (MRD-CF-RS-002/003).",
  appliesTo: ["miniflare", "real-cf", "in-memory"],
  async run(runtime, ctx) {
    const id = ctx.uniqueId("rs-negative");
    const agent = runtime.agent(id);
    await agent.spawn({ id, domain: "conformance" });

    await expectReject(
      agent.reportTokens(-1),
      /MRD-CF-RS-003/,
      "negative tokens",
    );
    await expectReject(
      agent.reportCost(-0.01),
      /MRD-CF-RS-002/,
      "negative cost",
    );

    await agent.terminate();
  },
};

export const resourcesAttribution: ConformanceScenario = {
  name: "resources-attribution",
  description:
    "reportTokens/reportCost with {workItemId} surfaces via getUsageByWorkItem, sorted by cost desc. RUNTIME-SPEC §4.5.",
  appliesTo: ["miniflare", "real-cf", "in-memory"],
  async run(runtime, ctx) {
    const id = ctx.uniqueId("rs-attr");
    const agent = runtime.agent(id);
    await agent.spawn({ id, domain: "conformance" });

    await agent.reportTokens(100, { workItemId: "wi-1" });
    await agent.reportCost(1.5, { workItemId: "wi-1" });
    await agent.reportTokens(40, { workItemId: "wi-2" });
    await agent.reportCost(0.25, { workItemId: "wi-2" });
    // Unattributed still lands in the rollup but not per-wi.
    await agent.reportTokens(25);

    const wi1 = await agent.getUsageByWorkItem("wi-1");
    expect(wi1, "wi-1 lookup").toEqual([
      { workItemId: "wi-1", tokens: 100, costUsd: 1.5 },
    ]);

    const all = await agent.getUsageByWorkItem();
    expect(all.length, "breakdown count").toBe(2);
    expect(all[0]?.workItemId, "sorted by cost desc").toBe("wi-1");

    expect(
      (await agent.getUsageByWorkItem("wi-unknown")).length,
      "unknown wi returns empty",
    ).toBe(0);

    await agent.terminate();
  },
};

export const resourcesUsageShape: ConformanceScenario = {
  name: "resources-usage-shape",
  description: "getUsage returns {limits, current, warnings} with full shape.",
  appliesTo: ["miniflare", "real-cf", "in-memory"],
  async run(runtime, ctx) {
    const id = ctx.uniqueId("rs-shape");
    const agent = runtime.agent(id);
    await agent.spawn({ id, domain: "conformance" });

    const usage = await agent.getUsage();
    expect(usage.limits !== undefined, "limits present").toBeTruthy();
    expect(typeof usage.current.memoryMB, "memoryMB typeof").toBe("number");
    expect(typeof usage.current.cpuMsLifetime, "cpuMsLifetime typeof").toBe(
      "number",
    );
    expect(typeof usage.current.tokensLifetime, "tokensLifetime typeof").toBe(
      "number",
    );
    expect(typeof usage.current.costUsdLifetime, "costUsdLifetime typeof").toBe(
      "number",
    );
    expect(
      typeof usage.current.activeOperations,
      "activeOperations typeof",
    ).toBe("number");
    expect(Array.isArray(usage.warnings), "warnings array").toBe(true);

    await agent.terminate();
  },
};

export const resourcesWarnings: ConformanceScenario = {
  name: "resources-warnings",
  description: "80% threshold on any limit surfaces a warning in getUsage.",
  appliesTo: ["miniflare", "real-cf", "in-memory"],
  async run(runtime, ctx) {
    const id = ctx.uniqueId("rs-warn");
    const agent = runtime.agent(id);
    await agent.spawn({ id, domain: "conformance" });
    await agent.setLimits({ maxCostUsd: 10 });

    await agent.reportCost(7.9);
    expect((await agent.getUsage()).warnings.length, "79% no warning").toBe(0);

    await agent.reportCost(0.2);
    const warned = await agent.getUsage();
    expect(warned.warnings.length, "81% emits warning").toBe(1);
    expect(warned.warnings[0]?.type, "warning type=cost").toBe("cost");

    await agent.terminate();
  },
};

export const resourcesLatency: ConformanceScenario = {
  name: "resources-latency",
  description: "getUsage responds in < 1s. RUNTIME-SPEC §4.5 sub-1s contract.",
  appliesTo: ["miniflare", "real-cf", "in-memory"],
  async run(runtime, ctx) {
    const id = ctx.uniqueId("rs-latency");
    const agent = runtime.agent(id);
    await agent.spawn({ id, domain: "conformance" });

    const start = Date.now();
    await agent.getUsage();
    const elapsed = Date.now() - start;
    expect(elapsed, "getUsage latency ms").toBeLessThan(1000);

    await agent.terminate();
  },
};
