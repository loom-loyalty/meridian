/**
 * @loom-loyalty/meridian-priority-reference
 *
 * Reference priority engine for Meridian. Implements the WSJF-derived
 * formula documented in specs/patterns/PRIORITY-ENGINE-SPEC.md §8.
 *
 * Non-normative: other implementations may produce different scores or
 * orderings and still be Meridian-conformant.
 */

export {
  WSJFPriorityEngine,
  type EngineProviders,
  type EngineOptions,
} from "./engine.js";
export { NoOpLearner } from "./no-op-learner.js";
export {
  DEFAULT_WEIGHT_PROFILE,
  INFRA_WEIGHT_PROFILE,
  PRODUCT_WEIGHT_PROFILE,
  resolveWeightProfile,
} from "./weight-profiles.js";
export {
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  shouldTripCircuitBreaker,
} from "./circuit-breaker.js";
export { explain, type ExplainContext } from "./explainer.js";
