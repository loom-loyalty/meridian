/**
 * Cloudflare Workers Logs implementation of {@link ObservabilityPlugin}.
 *
 * Routes through `console.{debug, info, warn, error}` which
 * workerd + Workers Logs ingests in production. The OTEL-compatible
 * log shape (`ObservabilityLogEntry`) is serialized as a structured
 * JSON field on each log line so adopters can query by `agentId`,
 * `domain`, `workItemId`, or custom `fields` in the Logpush pipeline.
 *
 * Metrics and spans are no-ops in this plugin — those belong in the
 * Analytics Engine companion (see `cf-analytics.ts`). Adopters can
 * compose multiple plugins via {@link CompositeObservabilityPlugin}
 * if they want both (the AgentDurableObject default composes them).
 */

import type {
  ObservabilityLogEntry,
  ObservabilityPlugin,
  ObservabilitySpan,
} from "./types.js";

export class CloudflareLogsPlugin implements ObservabilityPlugin {
  log(entry: ObservabilityLogEntry): void {
    const serialized = JSON.stringify(entry);
    switch (entry.level) {
      case "debug":
        console.debug(serialized);
        return;
      case "info":
        console.info(serialized);
        return;
      case "warn":
        console.warn(serialized);
        return;
      case "error":
        console.error(serialized);
        return;
    }
  }

  metric(): void {
    // Metrics live in Analytics Engine — see cf-analytics.ts.
  }

  startSpan(name: string, parentSpanId?: string): ObservabilitySpan {
    return new NoopSpan(name, parentSpanId);
  }
}

/**
 * Span stub used when no tracing backend is wired. Calls still
 * produce structured log lines so adopters can correlate
 * trace/span ids across logs without a full OTEL exporter.
 */
class NoopSpan implements ObservabilitySpan {
  readonly spanId: string;
  readonly traceId: string;

  constructor(
    private readonly name: string,
    parentSpanId?: string,
  ) {
    this.spanId = crypto.randomUUID();
    this.traceId = parentSpanId ?? crypto.randomUUID();
  }

  setAttribute(_key: string, _value: string | number | boolean): void {
    // Attributes buffered-and-dropped in v0.1; v0.2 wires to OTEL.
  }

  addEvent(_name: string, _attributes?: Record<string, unknown>): void {
    // Same deal — events buffered-and-dropped.
  }

  end(): void {
    // Log a span-end marker so adopters can reconstruct timing
    // from log output without an OTEL backend.
    console.debug(
      JSON.stringify({
        event: "span.end",
        name: this.name,
        spanId: this.spanId,
        traceId: this.traceId,
      }),
    );
  }
}
