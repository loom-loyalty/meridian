/**
 * Runtime conformance suite — subpath export.
 *
 * Adopters implement the {@link Runtime} contract over their runtime
 * (Cloudflare, in-memory, a future platform) and invoke
 * {@link runRuntimeConformance} with the scenario list. Failing
 * scenarios surface `MRD-CF-*` error-code patterns so adopters can
 * pinpoint which primitive diverged.
 *
 *     import { runRuntimeConformance, runtimeScenarios } from
 *       "@loom-loyalty/meridian-conformance/runtime";
 *     const results = await runRuntimeConformance(myRuntime, runtimeScenarios);
 *     const { ok, failed, skipped } = summarizeConformance(results);
 */

export * from "./types.js";
export * from "./runner.js";
export * from "./scenarios/index.js";
export { expect, expectReject } from "./assertions.js";
