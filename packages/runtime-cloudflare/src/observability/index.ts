/**
 * Observability — the one plugin interface exported publicly in
 * v0.1 per the eng-review reframing (adopters bring their own
 * observability stack; shipping this as a stable interface lets
 * them swap without forking).
 */

export type {
  ObservabilityLogEntry,
  ObservabilityPlugin,
  ObservabilitySpan,
} from "./types.js";

export { CloudflareLogsPlugin } from "./cf-logs.js";
export {
  CloudflareAnalyticsPlugin,
  CompositeObservabilityPlugin,
  type AnalyticsEngineLike,
} from "./cf-analytics.js";
