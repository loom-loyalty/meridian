/**
 * Circuit-breaker logic for the reference priority engine.
 *
 * See specs/patterns/PRIORITY-ENGINE-SPEC.md §3.
 *
 * The breaker bypasses normal scoring when an ErrorFeedback on a work item
 * matches all of: severity at/above threshold, blastRadius in the configured
 * bypass set, and (when requireRecoveredFalse is true) recovered === false.
 *
 * Note: ErrorFeedback.blastRadius and CompetingContext.impact.blastRadius are
 * DIFFERENT enums with different vocabularies. The breaker consumes the
 * former (ErrorFeedback: user|customer|all_customers|internal); escalation
 * in §4 consumes the latter (CompetingContext: isolated|module|service|domain|system).
 */

import type {
  CircuitBreakerConfig,
  ErrorFeedback,
} from "@loom-loyalty/meridian-types";

/** Ordered severity levels. Higher index = more severe. */
const SEVERITY_ORDER: ErrorFeedback["severity"][] = [
  "low",
  "medium",
  "high",
  "critical",
];

/**
 * Default breaker config when a domain does not supply one.
 * Matches PRIORITY-ENGINE-SPEC.md §3.
 */
export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  criticalSeverityThreshold: "critical",
  bypassBlastRadius: ["all_customers"],
  requireRecoveredFalse: true,
  escalationPath: "steward",
};

/**
 * Returns true when the given error trips the breaker under the given config.
 */
export function shouldTripCircuitBreaker(
  error: ErrorFeedback,
  config: CircuitBreakerConfig = DEFAULT_CIRCUIT_BREAKER_CONFIG,
): boolean {
  if (!severityAtLeast(error.severity, config.criticalSeverityThreshold)) {
    return false;
  }
  if (!config.bypassBlastRadius.includes(error.blastRadius)) {
    return false;
  }
  if (config.requireRecoveredFalse && error.recovered) {
    return false;
  }
  return true;
}

function severityAtLeast(
  actual: ErrorFeedback["severity"],
  threshold: CircuitBreakerConfig["criticalSeverityThreshold"],
): boolean {
  return SEVERITY_ORDER.indexOf(actual) >= SEVERITY_ORDER.indexOf(threshold);
}
