/**
 * Priority engine conformance helpers.
 *
 * See specs/patterns/PRIORITY-ENGINE-SPEC.md §7. Conformance checks
 * response shape only; orderings and absolute scores are
 * implementation-defined.
 *
 * Usage: an implementation under test writes a thin adapter that turns
 * an `AgentPriorityQuery` into the engine's native call, awaits the
 * response, and passes both to `assertConformantResponse`.
 */

export { assertConformantResponse, type ConformanceResult } from "./assertions.js";
export { referenceScenarios, type ConformanceScenario } from "./scenarios.js";
