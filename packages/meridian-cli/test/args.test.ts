import { describe, it, expect } from "vitest";

import { parseArgs } from "../src/util/args.js";

describe("parseArgs", () => {
  it("captures the command as the first positional", () => {
    const res = parseArgs(["init"]);
    expect(res.command).toBe("init");
    expect(res.positional).toEqual([]);
    expect(res.flags).toEqual({});
  });

  it("captures subsequent positionals", () => {
    const res = parseArgs(["inspect", "agent-123"]);
    expect(res.command).toBe("inspect");
    expect(res.positional).toEqual(["agent-123"]);
  });

  it("parses --flag=value", () => {
    const res = parseArgs(["doctor", "--endpoint=https://x.dev"]);
    expect(res.flags.endpoint).toBe("https://x.dev");
  });

  it("parses --flag value (space-separated)", () => {
    const res = parseArgs(["doctor", "--endpoint", "https://x.dev"]);
    expect(res.flags.endpoint).toBe("https://x.dev");
  });

  it("treats a trailing --flag (no value) as boolean true", () => {
    const res = parseArgs(["demo", "--experimental"]);
    expect(res.flags.experimental).toBe(true);
  });

  it("treats --flag before another --flag as boolean true", () => {
    const res = parseArgs(["domains", "--experimental", "--json"]);
    expect(res.flags.experimental).toBe(true);
    expect(res.flags.json).toBe(true);
  });

  it("bundles short flags", () => {
    const res = parseArgs(["-abc"]);
    expect(res.flags.a).toBe(true);
    expect(res.flags.b).toBe(true);
    expect(res.flags.c).toBe(true);
  });

  it("handles no args → everything undefined/empty", () => {
    const res = parseArgs([]);
    expect(res.command).toBeUndefined();
    expect(res.positional).toEqual([]);
    expect(res.flags).toEqual({});
  });

  it("preserves flag order via object keys", () => {
    const res = parseArgs([
      "inspect",
      "agent-1",
      "--experimental",
      "--token",
      "xyz",
      "--json",
    ]);
    expect(res.command).toBe("inspect");
    expect(res.positional).toEqual(["agent-1"]);
    expect(res.flags.experimental).toBe(true);
    expect(res.flags.token).toBe("xyz");
    expect(res.flags.json).toBe(true);
  });
});
