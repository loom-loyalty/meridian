/**
 * MCP binding conformance runner.
 *
 * Runs scenarios in order against one target and records each as passed,
 * failed, or skipped. A scenario that needs a capability the target does
 * not provide is skipped with the capability named in `reason`.
 *
 * @experimental
 */

import { mcpScenarios } from "./scenarios.js";
import type {
  McpConformanceResult,
  McpConformanceTarget,
  RunMcpConformanceOptions,
} from "./types.js";

/**
 * Run the MCP binding conformance suite against `target`.
 *
 * @experimental
 */
export async function runMcpConformance(
  target: McpConformanceTarget,
  opts: RunMcpConformanceOptions = {},
): Promise<McpConformanceResult[]> {
  const scenarios = opts.scenarios ?? mcpScenarios;
  const skipSet = new Set(opts.skip ?? []);
  const onlySet = opts.only ? new Set(opts.only) : undefined;
  const results: McpConformanceResult[] = [];

  for (const scenario of scenarios) {
    if (onlySet && !onlySet.has(scenario.name)) continue;
    if (skipSet.has(scenario.name)) {
      results.push({
        scenario: scenario.name,
        status: "skipped",
        reason: "caller-requested skip",
        durationMs: 0,
      });
      continue;
    }
    if (scenario.requires && typeof target[scenario.requires] !== "function") {
      results.push({
        scenario: scenario.name,
        status: "skipped",
        reason: `target does not provide ${scenario.requires}()`,
        durationMs: 0,
      });
      continue;
    }

    const startedAt = Date.now();
    try {
      const note = await scenario.run(target);
      results.push({
        scenario: scenario.name,
        status: "passed",
        ...(typeof note === "string" ? { reason: note } : {}),
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      results.push({
        scenario: scenario.name,
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      });
    }
  }

  return results;
}

/**
 * Reduce MCP conformance results to counts and a red/green verdict.
 *
 * @experimental
 */
export function summarizeMcpConformance(
  results: ReadonlyArray<McpConformanceResult>,
): {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  ok: boolean;
} {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const r of results) {
    if (r.status === "passed") passed++;
    else if (r.status === "failed") failed++;
    else skipped++;
  }
  return { total: results.length, passed, failed, skipped, ok: failed === 0 };
}
