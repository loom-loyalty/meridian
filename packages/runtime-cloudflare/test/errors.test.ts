/**
 * Error catalog stability test.
 *
 * The MRD-* codes are part of the adapter's stable API surface (DX
 * review decision, 2026-04-21). This file locks in:
 *   • code → category mapping (so adopters pattern-matching on
 *     ErrorCategory keep working across minor bumps)
 *   • context.code and context.docUrl presence (so tooling like
 *     `meridian doctor` can render errors uniformly)
 *   • isMeridianError / errorCode helpers' return semantics
 *
 * Runs as a plain unit test (pure functions, no DO needed). Isn't
 * the same thing as the live spawn/save/etc tests that verify the
 * error codes fire from the right code paths — those live alongside
 * each primitive's test file.
 */

import { describe, it, expect } from "vitest";
import { RuntimeError } from "@loom-loyalty/meridian-types";
import {
  meridianError,
  isMeridianError,
  errorCode,
  type MeridianErrorCode,
} from "../src/errors.js";

describe("error catalog", () => {
  it("every code builds a RuntimeError with matching category + retryable + context", () => {
    const codes: Array<[MeridianErrorCode, string]> = [
      ["MRD-CF-LC-001", "already_exists"],
      ["MRD-CF-LC-002", "not_found"],
      ["MRD-CF-LC-003", "invalid_argument"],
      ["MRD-CF-LC-004", "invalid_argument"],
      ["MRD-CF-ST-001", "invalid_argument"],
      ["MRD-CF-ST-002", "invalid_argument"],
      ["MRD-CF-ST-003", "invalid_argument"],
      ["MRD-CF-EX-001", "unavailable"],
      ["MRD-CF-EX-002", "unavailable"],
      ["MRD-CF-EX-003", "unavailable"],
    ];

    for (const [code, category] of codes) {
      const err = meridianError(code);
      expect(err).toBeInstanceOf(RuntimeError);
      expect(err.category).toBe(category);
      expect(err.retryable).toBe(false);
      expect(err.context?.code).toBe(code);
      expect(err.context?.docUrl).toBe(`https://meridian.dev/errors/${code}`);
      expect(err.message).toMatch(new RegExp(`^\\[${code}\\]`));
    }
  });

  it("meridianError merges custom context onto the auto-injected fields", () => {
    const err = meridianError("MRD-CF-ST-001", "too big", {
      context: { keyByteLength: 2048, limit: 1024 },
    });
    expect(err.context?.code).toBe("MRD-CF-ST-001");
    expect(err.context?.docUrl).toBe(
      "https://meridian.dev/errors/MRD-CF-ST-001",
    );
    expect(err.context?.keyByteLength).toBe(2048);
    expect(err.context?.limit).toBe(1024);
  });

  it("isMeridianError returns true only for Meridian-tagged RuntimeErrors", () => {
    expect(isMeridianError(meridianError("MRD-CF-LC-002"))).toBe(true);
    expect(isMeridianError(new Error("plain"))).toBe(false);
    expect(
      isMeridianError(new RuntimeError("internal", "bare runtime error")),
    ).toBe(false);
    expect(isMeridianError(null)).toBe(false);
    expect(isMeridianError("MRD-CF-LC-001")).toBe(false);
  });

  it("errorCode returns the catalog code or undefined", () => {
    expect(errorCode(meridianError("MRD-CF-EX-001"))).toBe("MRD-CF-EX-001");
    expect(errorCode(new Error("plain"))).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
  });
});
