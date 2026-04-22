/**
 * Public observability plugin interface.
 *
 * Per the eng-review decision (2026-04-21), `ObservabilityPlugin` is
 * the ONE plugin interface the adapter exports publicly in v0.1 —
 * adopters bring their own observability stack (OTEL, Datadog,
 * Honeycomb) with clear demand signal, and shipping this as a stable
 * interface now lets them swap without forking. The remaining five
 * primitives keep their plugin interfaces INTERNAL until the v0.2
 * timeframe when a second concrete implementation surfaces.
 *
 * `CloudflareAnalyticsPlugin` + `CloudflareLogsPlugin` are the
 * bundled defaults — wrap `env.ANALYTICS` (Analytics Engine binding)
 * and `console.{log,error,warn,debug}` (Workers Logs captures these
 * in production).
 *
 * Emission MUST be non-blocking per RUNTIME-SPEC §4.6. Plugins
 * return synchronously; any async work is fire-and-forget inside
 * the plugin.
 */

import type {
  AgentId,
  DomainId,
  Timestamp,
  WorkItemId,
} from "@loom-loyalty/meridian-types";

export interface ObservabilityLogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  agentId?: AgentId;
  domain?: DomainId;
  workItemId?: WorkItemId;
  timestamp: Timestamp;
  fields?: Record<string, unknown>;
}

export interface ObservabilitySpan {
  spanId: string;
  traceId: string;
  setAttribute(key: string, value: string | number | boolean): void;
  addEvent(name: string, attributes?: Record<string, unknown>): void;
  end(): void;
}

export interface ObservabilityPlugin {
  log(entry: ObservabilityLogEntry): void;
  metric(name: string, value: number, tags?: Record<string, string>): void;
  startSpan(name: string, parentSpanId?: string): ObservabilitySpan;
}
