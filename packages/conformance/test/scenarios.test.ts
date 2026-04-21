/**
 * Tests for the reference scenarios. These scenarios are what every
 * implementation-under-test runs against — broken scenarios mean every
 * downstream adopter gets garbage input.
 */

import { describe, it, expect } from "vitest";
import { referenceScenarios } from "../src/priority/scenarios.js";

describe("referenceScenarios — well-formed fixtures", () => {
  it("exports at least the five scenarios named in PRIORITY-ENGINE-SPEC §7", () => {
    const names = referenceScenarios.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "basic-query",
        "empty-result",
        "escalation-response",
        "not-found-domain",
        "invalid-argument",
      ])
    );
  });

  it("includes a circuit-breaker scenario", () => {
    expect(referenceScenarios.some((s) => s.name === "circuit-breaker")).toBe(true);
  });

  it("every scenario has a non-empty name and description", () => {
    for (const scenario of referenceScenarios) {
      expect(scenario.name.length).toBeGreaterThan(0);
      expect(scenario.description.length).toBeGreaterThan(0);
    }
  });

  it("every scenario has a well-formed query", () => {
    for (const scenario of referenceScenarios) {
      expect(typeof scenario.query.agentId).toBe("string");
      expect(typeof scenario.query.domain).toBe("string");
      if (scenario.query.limit !== undefined) {
        expect(scenario.query.limit).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("every scenario has a declared expectation", () => {
    const expectationKinds = [
      "non-empty-items",
      "empty-items",
      "escalated-item",
      "circuit-breaker-item",
      "not-found",
      "invalid-argument",
    ];
    for (const scenario of referenceScenarios) {
      expect(expectationKinds).toContain(scenario.expectation.kind);
    }
  });

  it("escalation and circuit-breaker scenarios reference a real work item id in the world", () => {
    for (const scenario of referenceScenarios) {
      if (
        scenario.expectation.kind === "escalated-item" ||
        scenario.expectation.kind === "circuit-breaker-item"
      ) {
        const id = scenario.expectation.workItemId;
        expect(scenario.world.workItems.some((wi) => wi.id === id)).toBe(true);
      }
    }
  });

  it("escalation scenario attaches a CompetingContext with service+ blast radius", () => {
    const escalation = referenceScenarios.find((s) => s.name === "escalation-response");
    expect(escalation).toBeDefined();
    const id = escalation!.world.workItems[0].id;
    const contexts = escalation!.world.contexts?.[id];
    expect(contexts).toBeDefined();
    const highBlast = contexts!.some((c) =>
      ["service", "domain", "system"].includes(c.impact.blastRadius)
    );
    expect(highBlast).toBe(true);
  });

  it("circuit-breaker scenario attaches an error matching the trigger condition", () => {
    const cb = referenceScenarios.find((s) => s.name === "circuit-breaker");
    expect(cb).toBeDefined();
    const id = cb!.world.workItems[0].id;
    const err = cb!.world.errors?.[id];
    expect(err).toBeDefined();
    expect(err!.severity).toBe("critical");
    expect(err!.blastRadius).toBe("all_customers");
    expect(err!.recovered).toBe(false);
  });
});
