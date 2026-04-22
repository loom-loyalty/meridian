/**
 * Conformance runner.
 *
 * Walks a scenario list, dispatching each to the runtime under test
 * and collecting structured results. Scenarios signal failure by
 * throwing; the runner catches and records the failure reason.
 *
 * Scenarios that don't apply to the adapter kind are recorded as
 * `skipped`, not silently dropped — a counter of skipped scenarios
 * in the result set helps adopters notice when real-CF-only coverage
 * is missing from their harness.
 */

import type {
  ConformanceResult,
  ConformanceScenario,
  RunConformanceOptions,
  Runtime,
  ScenarioContext,
} from "./types.js";

export async function runRuntimeConformance(
  runtime: Runtime,
  scenarios: ReadonlyArray<ConformanceScenario>,
  opts: RunConformanceOptions = {},
): Promise<ConformanceResult[]> {
  const skipSet = new Set(opts.skip ?? []);
  const onlySet = opts.only ? new Set(opts.only) : undefined;

  const results: ConformanceResult[] = [];

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
    if (!scenario.appliesTo.includes(runtime.kind)) {
      results.push({
        scenario: scenario.name,
        status: "skipped",
        reason: `scenario does not apply to runtime kind "${runtime.kind}"`,
        durationMs: 0,
      });
      continue;
    }

    const ctx = makeContext(scenario.name);
    const startedAt = Date.now();
    try {
      await scenario.run(runtime, ctx);
      results.push({
        scenario: scenario.name,
        status: "passed",
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      results.push({
        scenario: scenario.name,
        status: "failed",
        reason: (err as Error).message || String(err),
        durationMs: Date.now() - startedAt,
      });
    }
  }

  return results;
}

function makeContext(scenarioName: string): ScenarioContext {
  let counter = 0;
  return {
    uniqueId(prefix: string): string {
      counter += 1;
      // Suffix with scenario name + counter so two scenarios running
      // in the same process don't collide on agent ids. The
      // millisecond component keeps re-runs of the same test from
      // hitting stale DO state in Miniflare's persistent storage.
      return `${prefix}-${scenarioName}-${counter}-${Date.now()}`;
    },
    fail(reason: string): never {
      throw new Error(reason);
    },
  };
}

/**
 * Summary helper adopters use to reduce a result list down to a
 * red/green verdict. Returns the same shape the CLI / CI output
 * adapters consume.
 */
export function summarizeConformance(
  results: ReadonlyArray<ConformanceResult>,
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
  return {
    total: results.length,
    passed,
    failed,
    skipped,
    ok: failed === 0,
  };
}
