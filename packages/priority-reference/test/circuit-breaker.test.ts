/**
 * Circuit-breaker tests. PRIORITY-ENGINE-SPEC.md §3.
 */

import { describe, it, expect } from "vitest";
import type {
  ErrorFeedback,
  CircuitBreakerConfig,
} from "@loom-loyalty/meridian-types";
import {
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  shouldTripCircuitBreaker,
} from "../src/circuit-breaker.js";

function makeError(overrides: Partial<ErrorFeedback> = {}): ErrorFeedback {
  return {
    tier: "required",
    type: "error",
    agentId: "a1",
    domain: "infrastructure",
    severity: "critical",
    category: "infrastructure",
    message: "db down",
    frequency: "first",
    blastRadius: "all_customers",
    recovered: false,
    timestamp: 1_000_000,
    ...overrides,
  };
}

describe("shouldTripCircuitBreaker (default config)", () => {
  it("trips on critical + all_customers + !recovered", () => {
    expect(shouldTripCircuitBreaker(makeError())).toBe(true);
  });

  it("does not trip on medium severity", () => {
    expect(shouldTripCircuitBreaker(makeError({ severity: "medium" }))).toBe(
      false,
    );
  });

  it("does not trip when recovered is true", () => {
    expect(shouldTripCircuitBreaker(makeError({ recovered: true }))).toBe(
      false,
    );
  });

  it("does not trip on user-level blast radius", () => {
    expect(shouldTripCircuitBreaker(makeError({ blastRadius: "user" }))).toBe(
      false,
    );
  });

  it("does not trip on internal blast radius", () => {
    expect(
      shouldTripCircuitBreaker(makeError({ blastRadius: "internal" })),
    ).toBe(false);
  });
});

describe("shouldTripCircuitBreaker (custom config)", () => {
  it("widened threshold catches high severity", () => {
    const config: CircuitBreakerConfig = {
      ...DEFAULT_CIRCUIT_BREAKER_CONFIG,
      criticalSeverityThreshold: "high",
    };
    expect(
      shouldTripCircuitBreaker(makeError({ severity: "high" }), config),
    ).toBe(true);
    expect(
      shouldTripCircuitBreaker(makeError({ severity: "medium" }), config),
    ).toBe(false);
  });

  it("widened blastRadius catches customer-level", () => {
    const config: CircuitBreakerConfig = {
      ...DEFAULT_CIRCUIT_BREAKER_CONFIG,
      bypassBlastRadius: ["customer", "all_customers"],
    };
    expect(
      shouldTripCircuitBreaker(makeError({ blastRadius: "customer" }), config),
    ).toBe(true);
  });

  it("requireRecoveredFalse=false allows recovered errors to trip", () => {
    const config: CircuitBreakerConfig = {
      ...DEFAULT_CIRCUIT_BREAKER_CONFIG,
      requireRecoveredFalse: false,
    };
    expect(
      shouldTripCircuitBreaker(makeError({ recovered: true }), config),
    ).toBe(true);
  });
});
