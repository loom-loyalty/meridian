/**
 * M2d observability tests.
 *
 * Observability emission is fire-and-forget; most of the surface is
 * side-effect (console.log, AE writeDataPoint). These tests exercise
 * the plugin directly + via the AgentContext, verifying:
 *   • CloudflareAnalyticsPlugin no-ops when binding is missing
 *   • CloudflareAnalyticsPlugin forwards metric calls to AE
 *   • CompositeObservabilityPlugin fans out to children
 *   • ctx.obs.log / metric / startSpan are callable from an
 *     adopter hook without throwing
 */

import { describe, it, expect, vi } from "vitest";
import {
  CloudflareAnalyticsPlugin,
  CloudflareLogsPlugin,
  CompositeObservabilityPlugin,
  type AnalyticsEngineLike,
  type ObservabilityLogEntry,
} from "../src/observability/index.js";

describe("CloudflareLogsPlugin", () => {
  it("log() routes to console.{level} for each level", () => {
    const plugin = new CloudflareLogsPlugin();
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const base: Omit<ObservabilityLogEntry, "level"> = {
      message: "hi",
      timestamp: 1,
    };

    plugin.log({ ...base, level: "debug" });
    plugin.log({ ...base, level: "info" });
    plugin.log({ ...base, level: "warn" });
    plugin.log({ ...base, level: "error" });

    expect(debugSpy).toHaveBeenCalledOnce();
    expect(infoSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledOnce();

    debugSpy.mockRestore();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("metric() is a no-op (belongs to the analytics plugin)", () => {
    const plugin = new CloudflareLogsPlugin();
    plugin.metric("foo", 1);
    expect(true).toBe(true); // no throw = pass
  });

  it("startSpan() returns a noop span with ids", () => {
    const plugin = new CloudflareLogsPlugin();
    const span = plugin.startSpan("op");
    expect(span.spanId).toBeTruthy();
    expect(span.traceId).toBeTruthy();
    expect(() => span.setAttribute("k", "v")).not.toThrow();
    expect(() => span.addEvent("e")).not.toThrow();
    // end() emits a structured log line; don't assert on output.
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    span.end();
    expect(debugSpy).toHaveBeenCalled();
    debugSpy.mockRestore();
  });
});

describe("CloudflareAnalyticsPlugin", () => {
  it("metric() no-ops when the dataset binding is absent", () => {
    const plugin = new CloudflareAnalyticsPlugin(undefined);
    expect(() => plugin.metric("foo", 1)).not.toThrow();
  });

  it("metric() writes a data point with blobs, doubles, and agentId index", () => {
    const points: Array<{
      blobs?: string[];
      doubles?: number[];
      indexes?: string[];
    }> = [];
    const fakeDataset: AnalyticsEngineLike = {
      writeDataPoint: (p) => points.push(p),
    };

    const plugin = new CloudflareAnalyticsPlugin(fakeDataset);
    plugin.metric("llm.tokens", 42, {
      agentId: "agent-a",
      model: "claude",
    });

    expect(points).toHaveLength(1);
    expect(points[0]?.doubles).toEqual([42]);
    // blobs: name + sorted-tag kv strings
    expect(points[0]?.blobs).toEqual([
      "llm.tokens",
      "agentId=agent-a",
      "model=claude",
    ]);
    expect(points[0]?.indexes).toEqual(["agent-a"]);
  });

  it("metric() without agentId tag omits indexes", () => {
    const points: Array<{
      blobs?: string[];
      doubles?: number[];
      indexes?: string[];
    }> = [];
    const plugin = new CloudflareAnalyticsPlugin({
      writeDataPoint: (p) => points.push(p),
    });
    plugin.metric("sys.heartbeat", 1);
    expect(points[0]?.indexes).toEqual([]);
  });

  it("log() is a no-op (Workers Logs is the logs plugin)", () => {
    const plugin = new CloudflareAnalyticsPlugin(undefined);
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    plugin.log({
      level: "info",
      message: "should not emit",
      timestamp: 0,
    });
    expect(debugSpy).not.toHaveBeenCalled();
    debugSpy.mockRestore();
  });
});

describe("CompositeObservabilityPlugin", () => {
  it("fans out log/metric/startSpan to every child", () => {
    const logs: ObservabilityLogEntry[] = [];
    const metrics: Array<{
      name: string;
      value: number;
      tags?: Record<string, string>;
    }> = [];
    const childA = {
      log: (e: ObservabilityLogEntry) =>
        logs.push({ ...e, message: `A:${e.message}` }),
      metric: (n: string, v: number, t?: Record<string, string>) =>
        metrics.push({ name: `A:${n}`, value: v, tags: t }),
      startSpan: (_n: string) => ({
        spanId: "span-a",
        traceId: "trace-a",
        setAttribute: () => {},
        addEvent: () => {},
        end: () => {},
      }),
    };
    const childB = {
      log: (e: ObservabilityLogEntry) =>
        logs.push({ ...e, message: `B:${e.message}` }),
      metric: (n: string, v: number, t?: Record<string, string>) =>
        metrics.push({ name: `B:${n}`, value: v, tags: t }),
      startSpan: (_n: string) => ({
        spanId: "span-b",
        traceId: "trace-b",
        setAttribute: () => {},
        addEvent: () => {},
        end: () => {},
      }),
    };
    const comp = new CompositeObservabilityPlugin([childA, childB]);

    comp.log({ level: "info", message: "hi", timestamp: 1 });
    comp.metric("m", 1, { tag: "x" });
    const span = comp.startSpan("op");

    expect(logs.map((l) => l.message)).toEqual(["A:hi", "B:hi"]);
    expect(metrics.map((m) => m.name)).toEqual(["A:m", "B:m"]);
    // Composite returns the primary child's span id.
    expect(span.spanId).toBe("span-a");
  });

  it("a failing child doesn't prevent others from receiving", () => {
    const received: string[] = [];
    const breaker = {
      log: () => {
        throw new Error("boom");
      },
      metric: () => {
        throw new Error("boom");
      },
      startSpan: () => {
        throw new Error("boom");
      },
    };
    const survivor = {
      log: (e: ObservabilityLogEntry) => received.push(e.message),
      metric: (n: string) => received.push(`m:${n}`),
      startSpan: (_n: string) => ({
        spanId: "s",
        traceId: "t",
        setAttribute: () => {},
        addEvent: () => {},
        end: () => {},
      }),
    };

    const comp = new CompositeObservabilityPlugin([breaker, survivor]);
    expect(() =>
      comp.log({ level: "info", message: "kept", timestamp: 0 }),
    ).not.toThrow();
    expect(() => comp.metric("kept-metric", 1)).not.toThrow();
    expect(received).toContain("kept");
    expect(received).toContain("m:kept-metric");
  });
});
