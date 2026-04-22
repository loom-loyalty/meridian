/**
 * Cloudflare Analytics Engine implementation of
 * {@link ObservabilityPlugin} — `metric()` writes data points to an
 * `AnalyticsEngineDataset` binding. Adopters configure the binding
 * in `wrangler.toml` as:
 *
 *     [[analytics_engine_datasets]]
 *     binding = "ANALYTICS"
 *     dataset = "meridian_metrics"
 *
 * AE has per-point budgets (~20 indexes, double limits on blobs /
 * doubles). The plugin writes:
 *   • blobs — agentId, domain, workItemId, metric name, and the
 *     provided `tags` map (stringified)
 *   • doubles — the metric value
 *   • indexes — agentId (first-class cardinality; AE caps at 50k)
 *
 * Per the M2a review's Analytics-Engine-cardinality follow-up note,
 * `workItemId` and tag values go in BLOBS (unbounded cardinality,
 * queryable via filter) rather than indexes. Only `agentId` is an
 * index since it has well-bounded cardinality within a tenant.
 *
 * `log` delegates to the Workers Logs plugin composed alongside
 * this one (see CompositeObservabilityPlugin). `startSpan` is a
 * stub until OTEL wiring lands in v0.2.
 */

import type {
  ObservabilityLogEntry,
  ObservabilityPlugin,
  ObservabilitySpan,
} from "./types.js";

/**
 * Minimal type surface we need from an
 * `AnalyticsEngineDataset` binding. Full @cloudflare/workers-types
 * defines the same shape; this local alias keeps the plugin
 * usable when the full binding isn't wired (`ANALYTICS` env var
 * absent) — passing `undefined` makes `metric()` a no-op.
 */
export interface AnalyticsEngineLike {
  writeDataPoint(point: {
    blobs?: string[];
    doubles?: number[];
    indexes?: string[];
  }): void;
}

export class CloudflareAnalyticsPlugin implements ObservabilityPlugin {
  constructor(private readonly dataset: AnalyticsEngineLike | undefined) {}

  log(_entry: ObservabilityLogEntry): void {
    // Logs are the Workers Logs plugin's domain. This plugin
    // is metric + span only. See CompositeObservabilityPlugin
    // for how they're wired together in agent-do.
  }

  metric(name: string, value: number, tags: Record<string, string> = {}): void {
    if (!this.dataset) return;

    // Sort tag keys so encoding is deterministic across hosts.
    const tagKeys = Object.keys(tags).sort();
    const rawBlobs = [name, ...tagKeys.map((k) => `${k}=${tags[k]}`)];

    // Analytics Engine caps blobs to ~5120 bytes per data point.
    // Trim long blobs at 200 bytes each and cap total count at 20.
    // Everything past the cap is dropped — visible to adopters via
    // the `meridian.obs.drops` self-metric so they notice cardinality
    // issues before debugging missing dashboards.
    const MAX_BLOBS = 20;
    const MAX_BLOB_BYTES = 200;
    const blobs = rawBlobs
      .slice(0, MAX_BLOBS)
      .map((b) =>
        b.length > MAX_BLOB_BYTES ? b.slice(0, MAX_BLOB_BYTES - 3) + "..." : b,
      );
    const dropped = rawBlobs.length - blobs.length;

    // RUNTIME-SPEC §4.6: emission MUST NOT throw. AE binding may
    // reject for budget reasons beyond our trim; swallow + record.
    try {
      this.dataset.writeDataPoint({
        blobs,
        doubles: [value],
        indexes: tags.agentId ? [tags.agentId] : [],
      });
      if (dropped > 0) {
        // Re-emit a drops marker so adopters see when they exceeded
        // the budget. Uses a minimal shape to avoid re-triggering.
        this.dataset.writeDataPoint({
          blobs: ["meridian.obs.drops", `src=${name}`],
          doubles: [dropped],
          indexes: tags.agentId ? [tags.agentId] : [],
        });
      }
    } catch {
      // Fire-and-forget; AE dropped the point. No re-throw — keeps
      // adopter hook paths non-blocking.
    }
  }

  startSpan(_name: string, parentSpanId?: string): ObservabilitySpan {
    const spanId = crypto.randomUUID();
    const traceId = parentSpanId ?? crypto.randomUUID();
    return {
      spanId,
      traceId,
      setAttribute: () => {
        // v0.1: attributes buffered-and-dropped. v0.2 wires OTEL.
      },
      addEvent: () => {
        // Same.
      },
      end: () => {
        // No backend; span lifecycle is captured as a log line
        // by the paired logs plugin. Nothing to emit from AE.
      },
    };
  }
}

/**
 * Fan-out composition: invoke every child plugin per call. The
 * AgentDurableObject builds this by default with
 * [logs, analytics] so adopters get Workers Logs + Analytics
 * Engine out of the box. Swap by passing a different set into
 * `createMeridianWorker({ observability: [...] })` in M2e.
 */
export class CompositeObservabilityPlugin implements ObservabilityPlugin {
  constructor(private readonly children: ObservabilityPlugin[]) {}

  log(entry: ObservabilityLogEntry): void {
    for (const c of this.children) {
      try {
        c.log(entry);
      } catch {
        // Emission is non-blocking + fire-and-forget; a failing
        // plugin can't take down others.
      }
    }
  }

  metric(name: string, value: number, tags?: Record<string, string>): void {
    for (const c of this.children) {
      try {
        c.metric(name, value, tags);
      } catch {
        // see above
      }
    }
  }

  startSpan(name: string, parentSpanId?: string): ObservabilitySpan {
    // For span composition we return the first child's span and
    // broadcast begin/end via log entries. Good enough for v0.1 —
    // OTEL exporter composition lands in v0.2.
    const [primary, ...rest] = this.children;
    if (!primary) {
      return noopSpan(name, parentSpanId);
    }
    const span = primary.startSpan(name, parentSpanId);
    for (const c of rest) {
      try {
        c.startSpan(name, span.spanId).end();
      } catch {
        // see above
      }
    }
    return span;
  }
}

function noopSpan(name: string, parentSpanId?: string): ObservabilitySpan {
  const spanId = crypto.randomUUID();
  const traceId = parentSpanId ?? crypto.randomUUID();
  return {
    spanId,
    traceId,
    setAttribute: () => {},
    addEvent: () => {},
    end: () => {
      console.debug(
        JSON.stringify({ event: "span.end", name, spanId, traceId }),
      );
    },
  };
}
