# `MRD-CF-RS-*` — Resource errors

Cost + token + concurrency cap errors. See [RUNTIME-SPEC §4.5](../../specs/core/RUNTIME-SPEC.md#45-resource-limits).

## `MRD-CF-RS-001` — maxTokensTotal exceeded

**Category:** `resource_exhausted` (HTTP 429) · **Retryable:** no

`reportTokens(n)` would push `tokensLifetime + n > ResourceLimits.maxTokensTotal`.
The lifetime cap is strict — once exceeded, no further token reports
land on this agent.

**Fix**

Spawn a fresh agent (new DO, new cap) for the next batch of work,
or raise `maxTokensTotal` via `setLimits({maxTokensTotal: ...})`
before the next report.

## `MRD-CF-RS-002` — maxCostUsd exceeded

**Category:** `resource_exhausted` (HTTP 429) · **Retryable:** no

`reportCost(usd)` would push `costUsdLifetime + usd > ResourceLimits.maxCostUsd`.
Same strictness as RS-001.

**Fix**

Same pattern — new agent, or `setLimits({maxCostUsd: ...})`. Cost
caps are the primary enforcement for "this agent cannot spend more
than $X without human approval".

## `MRD-CF-RS-003` — single-call token report exceeds per-call cap

**Category:** `invalid_argument` (HTTP 400) · **Retryable:** no

`reportTokens(n)` where `n > ResourceLimits.maxTokensPerCall` or
`n < 0`. The per-call cap guards against a single runaway LLM call
eating the whole budget; negative values signal an adopter bug.

**Fix**

Check the token count before calling `reportTokens`. If you really
need to report more than the per-call cap in one shot, raise the
limit via `setLimits` first.

## `MRD-CF-RS-004` — concurrent operations would exceed cap

**Category:** `resource_exhausted` (HTTP 429) · **Retryable:** yes

`beginOperation()` would push `activeOperations + 1 > ResourceLimits.maxConcurrency`.
Only surfaces from hook-context `ctx.resources.beginOperation()`;
the public RPC surface doesn't expose begin/end directly.

**Fix**

- Let in-flight operations complete (retryable after backoff)
- Raise `maxConcurrency` if your workload genuinely needs more
  parallelism
- Serialize the work if concurrency isn't helping throughput
