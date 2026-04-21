/**
 * Regression auto-annotation tests. PRIORITY-ENGINE-SPEC.md §8.3.
 */

import { describe, it, expect } from "vitest";
import type { Domain, WorkItem, WorkItemId } from "@loom-loyalty/meridian-types";
import { WSJFPriorityEngine } from "../src/engine.js";

const DAY_MS = 86_400_000;

function makeWorkItem(overrides: Partial<WorkItem> & { id: WorkItemId }): WorkItem {
  return {
    type: "story",
    title: "Test",
    domains: ["infrastructure"],
    source: "agent",
    costToBuild: { amountUsd: 50 },
    costOfNotBuilding: { amountUsd: 100 },
    confidence: 0.8,
    status: "ready",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeDomain(): Domain {
  return {
    id: "infrastructure",
    name: "Infra",
    stewards: [{ id: "s1", name: "Steward", role: "primary" }],
  };
}

async function priorityOf(
  now: number,
  wi: WorkItem,
  superseded: WorkItem | undefined
): Promise<number | null> {
  const engine = new WSJFPriorityEngine({
    providers: {
      async listOpenWorkItems() {
        return [wi];
      },
      async getCompetingContexts() {
        return [];
      },
      async getLatestError() {
        return undefined;
      },
      async getDomain() {
        return makeDomain();
      },
      async getSupersededItem(lineage) {
        return lineage ? superseded : undefined;
      },
    },
    now: () => now,
  });
  const resp = await engine.query({
    agentId: "a",
    domain: "infrastructure",
    limit: 1,
  });
  return resp.items[0].priorityScore;
}

describe("regression auto-annotation multiplier", () => {
  it("produces ~2.0x multiplier for a 1-day-old regression", async () => {
    const baseWi = makeWorkItem({ id: "wi_base", createdAt: 10 * DAY_MS });
    const supersededWi = makeWorkItem({
      id: "wi_old",
      status: "done",
      createdAt: 5 * DAY_MS,
      updatedAt: 9 * DAY_MS,
    });
    const regressionWi = makeWorkItem({
      id: "wi_regress",
      createdAt: 10 * DAY_MS,
      lineage: "wi_old",
    });

    const now = 10 * DAY_MS;
    const basePriority = await priorityOf(now, baseWi, undefined);
    const regPriority = await priorityOf(now, regressionWi, supersededWi);

    expect(basePriority).toBeGreaterThan(0);
    expect(regPriority).toBeGreaterThan(0);
    expect(regPriority! / basePriority!).toBeGreaterThan(1.5);
    expect(regPriority! / basePriority!).toBeLessThanOrEqual(2.0);
  });

  it("produces ~1.1x multiplier for a 10-day-old regression", async () => {
    const baseWi = makeWorkItem({ id: "wi_base" });
    const supersededWi = makeWorkItem({
      id: "wi_old",
      status: "done",
      updatedAt: 0,
    });
    const regressionWi = makeWorkItem({ id: "wi_regress", lineage: "wi_old" });

    const now = 10 * DAY_MS;
    const basePriority = await priorityOf(now, baseWi, undefined);
    const regPriority = await priorityOf(now, regressionWi, supersededWi);

    const ratio = regPriority! / basePriority!;
    expect(ratio).toBeGreaterThan(1.0);
    expect(ratio).toBeLessThan(1.15);
  });

  it("does not apply regression boost when superseded is not done", async () => {
    const supersededWi = makeWorkItem({
      id: "wi_old",
      status: "in_progress",
      updatedAt: 0,
    });
    const regressionWi = makeWorkItem({ id: "wi_regress", lineage: "wi_old" });

    const now = 5 * DAY_MS;
    const basePriority = await priorityOf(now, makeWorkItem({ id: "wi_base" }), undefined);
    const regPriority = await priorityOf(now, regressionWi, supersededWi);

    expect(regPriority).toBeCloseTo(basePriority!);
  });

  it("flags regression annotation when boost applied", async () => {
    const supersededWi = makeWorkItem({
      id: "wi_old",
      status: "done",
      updatedAt: 0,
    });
    const regressionWi = makeWorkItem({ id: "wi_regress", lineage: "wi_old" });

    const engine = new WSJFPriorityEngine({
      providers: {
        async listOpenWorkItems() {
          return [regressionWi];
        },
        async getCompetingContexts() {
          return [];
        },
        async getLatestError() {
          return undefined;
        },
        async getDomain() {
          return makeDomain();
        },
        async getSupersededItem(lineage) {
          return lineage ? supersededWi : undefined;
        },
      },
      now: () => 3 * DAY_MS,
    });

    const resp = await engine.query({
      agentId: "a",
      domain: "infrastructure",
      limit: 1,
    });
    expect(resp.items[0].priorityAnnotation).toBe("regression");
  });
});
