import {
  lifecycleBasic,
  lifecycleIdempotent,
  lifecycleRequiresSpawn,
} from "./lifecycle.js";
import {
  stateIsolation,
  stateReservedKeys,
  stateSizeLimits,
  stateConcurrentUpdate,
  stateDurability,
} from "./state.js";
import {
  schedulingBounds,
  schedulingCronBounds,
  schedulingCancel,
  schedulingFires,
} from "./scheduling.js";
import {
  transportOrdering,
  transportPayloadLimit,
  transportBroadcast,
  transportDrain,
} from "./transport.js";
import {
  resourcesLimitsRoundTrip,
  resourcesEnforcement,
  resourcesNegativeReports,
  resourcesAttribution,
  resourcesUsageShape,
  resourcesWarnings,
  resourcesLatency,
} from "./resources.js";
import { experimentalUnavailable } from "./experimental.js";
import { errorsCategorized } from "./errors.js";

import type { ConformanceScenario } from "../types.js";

/**
 * The full runtime conformance suite. Scenarios with
 * `appliesTo: ["real-cf"]` are skipped by the Miniflare and
 * in-memory adapters but MUST run in the real-CF E2E workflow.
 */
export const runtimeScenarios: ReadonlyArray<ConformanceScenario> = [
  lifecycleBasic,
  lifecycleIdempotent,
  lifecycleRequiresSpawn,
  stateIsolation,
  stateReservedKeys,
  stateSizeLimits,
  stateConcurrentUpdate,
  stateDurability,
  schedulingBounds,
  schedulingCronBounds,
  schedulingCancel,
  schedulingFires,
  transportOrdering,
  transportPayloadLimit,
  transportBroadcast,
  transportDrain,
  resourcesLimitsRoundTrip,
  resourcesEnforcement,
  resourcesNegativeReports,
  resourcesAttribution,
  resourcesUsageShape,
  resourcesWarnings,
  resourcesLatency,
  experimentalUnavailable,
  errorsCategorized,
];

export * from "./lifecycle.js";
export * from "./state.js";
export * from "./scheduling.js";
export * from "./transport.js";
export * from "./resources.js";
export * from "./experimental.js";
export * from "./errors.js";
