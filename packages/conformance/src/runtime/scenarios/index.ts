import {
  lifecycleBasic,
  lifecycleIdempotent,
  lifecycleRequiresSpawn,
} from "./lifecycle.js";
import {
  stateIsolation,
  stateReservedKeys,
  stateSizeLimits,
  stateListPrefix,
  stateListPagination,
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
  transportBroadcastCrossDomain,
  transportBroadcastLateSpawn,
  transportInboxCap,
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
import { errorsCategorized, errorsCodesReachable } from "./errors.js";
import { concurrencySpawnBroadcastFanout } from "./concurrency.js";

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
  stateListPrefix,
  stateListPagination,
  stateConcurrentUpdate,
  stateDurability,
  schedulingBounds,
  schedulingCronBounds,
  schedulingCancel,
  schedulingFires,
  transportOrdering,
  transportPayloadLimit,
  transportBroadcast,
  transportBroadcastCrossDomain,
  transportBroadcastLateSpawn,
  transportInboxCap,
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
  errorsCodesReachable,
  concurrencySpawnBroadcastFanout,
];

export * from "./lifecycle.js";
export * from "./state.js";
export * from "./scheduling.js";
export * from "./transport.js";
export * from "./resources.js";
export * from "./experimental.js";
export * from "./errors.js";
export * from "./concurrency.js";
