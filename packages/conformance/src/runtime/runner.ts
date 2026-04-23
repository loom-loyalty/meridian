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

    const startedAt = Date.now();
    let lastErr: unknown = undefined;
    // Transient-error retry budget: 2 attempts total. Only retries
    // on known-transient errors (see `isTransientDOError`). Scenarios
    // allocate fresh ids per ctx.uniqueId() call inside each run,
    // so a retry gets a fully-fresh world — no risk of half-committed
    // state poisoning the second attempt.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const ctx = makeContext(scenario.name);
      try {
        await scenario.run(runtime, ctx);
        results.push({
          scenario: scenario.name,
          status: "passed",
          durationMs: Date.now() - startedAt,
        });
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < 2 && isTransientDOError(err)) {
          // Known transient — eat and retry. Most common case: real-CF
          // killed a warm DO because code was just updated; the next
          // call lands on fresh DOs with the deployed code.
          continue;
        }
        break;
      }
    }
    if (lastErr !== undefined) {
      results.push({
        scenario: scenario.name,
        status: "failed",
        reason: formatFailure(lastErr),
        durationMs: Date.now() - startedAt,
      });
    }
  }

  return results;
}

/**
 * Identify errors that are always safe to retry:
 *
 * - "Durable Object reset because its code was updated" — Cloudflare
 *   kills warm DO instances on deploy. The first RPC to any warm DO
 *   after a deploy throws this error; the next call lands on a fresh
 *   DO running the new code. This is noise from our CI pattern of
 *   deploy-then-immediately-run, not a real bug.
 *
 * - "internal error; reference=<hex>" — cold-DO RPC marshaling
 *   hiccup. On real-CF, the FIRST RPC call to a freshly-spun DO
 *   sometimes has its thrown RuntimeError masked as a generic
 *   "internal error" with a CF reference tag. The DO-side
 *   `logRpcError` wrapper shows the real MRD-CF-* error came through
 *   correctly — CF just mangles it at the RPC boundary on cold
 *   starts. Subsequent calls return the true error, so retry
 *   reliably unsticks. Observed failing scenarios: all in the first
 *   10-15 of the suite (lifecycle, state) when run immediately after
 *   `wrangler deploy`. Warmth-based masking, not a bug we can fix
 *   in the runtime.
 */
function isTransientDOError(err: unknown): boolean {
  const msg = (err as Error | undefined)?.message ?? "";
  if (msg.includes("Durable Object reset because its code was updated")) {
    return true;
  }
  // Match CF's generic-error marshaling pattern. The `reference=<hex>`
  // token is distinctive — real adopter errors use our `MRD-CF-*`
  // prefix and wouldn't overlap.
  if (/internal error;\s*reference\s*=\s*[a-z0-9]+/i.test(msg)) {
    return true;
  }
  return false;
}

function formatFailure(err: unknown): string {
  if (err === null || err === undefined) return `thrown: ${String(err)}`;
  const e = err as Error & { code?: string; cause?: unknown };
  const ctor = e.constructor?.name ?? "Error";
  const code = e.code ? ` [${e.code}]` : "";
  const message = e.message || String(err);
  const stackHead = e.stack
    ? e.stack.split("\n").slice(0, 6).join(" | ")
    : "no-stack";

  // Walk the cause chain up to 3 levels deep — `new Error(msg, {cause})`
  // preserves the originating throw across abstraction boundaries and
  // adopters / the CF adapter use this pattern in meridianError.
  const causes: string[] = [];
  let cur: unknown = e.cause;
  for (let depth = 0; depth < 3 && cur; depth++) {
    const cause = cur as Error & { code?: string; cause?: unknown };
    const causeCtor = cause.constructor?.name ?? "Error";
    const causeCode = cause.code ? ` [${cause.code}]` : "";
    causes.push(`${causeCtor}${causeCode}: ${cause.message || String(cur)}`);
    cur = cause.cause;
  }
  const causeStr = causes.length > 0 ? ` | cause: ${causes.join(" <- ")}` : "";

  return `${ctor}${code}: ${message}${causeStr} | stack: ${stackHead}`;
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
