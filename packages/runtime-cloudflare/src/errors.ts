/**
 * Error catalog for `@loom-loyalty/meridian-runtime-cloudflare`.
 *
 * Every {@link RuntimeError} this adapter raises carries a stable `code`
 * of the form `MRD-CF-<primitive>-<nnn>` and a `docUrl` pointing at the
 * matching page on `meridianprotocol.dev/errors/`. The code catalog is part of
 * the adapter's stable API surface within a major version — breaking
 * code changes bump major per the DX review decision (2026-04-21). When
 * adding a code, append a new number at the end of the appropriate
 * primitive block; never reuse or renumber retired codes.
 *
 * Primitive prefixes:
 *   LC  — Lifecycle
 *   ST  — State
 *   SC  — Scheduling
 *   TR  — Transport
 *   RS  — Resources
 *   OB  — Observability
 *   EX  — Experimental (stable primitives' @experimental methods)
 *   WR  — Wire / frame decoding
 *   AU  — Auth / admin
 *   TN  — Tenancy
 */

import type { ErrorCategory } from "@loom-loyalty/meridian-types";
import { RuntimeError } from "@loom-loyalty/meridian-types";

export type MeridianErrorCode =
  // Lifecycle
  | "MRD-CF-LC-001" // spawn identity conflict on re-bind
  | "MRD-CF-LC-002" // method invoked before spawn
  | "MRD-CF-LC-003" // resume called on terminated agent
  | "MRD-CF-LC-004" // spawn missing required id/domain
  | "MRD-CF-LC-005" // spawn config.id doesn't match DO binding name (spoofing guard)
  // State
  | "MRD-CF-ST-001" // state key too large (> 1024 bytes utf-8)
  | "MRD-CF-ST-002" // state value too large (> 1 MB approximate)
  | "MRD-CF-ST-003" // state key empty or reserved (__meta__, __inbox__, state::, etc)
  // Scheduling
  | "MRD-CF-SC-001" // scheduleAt delay below 1-second minimum
  | "MRD-CF-SC-002" // scheduleAt delay above 365-day maximum
  | "MRD-CF-SC-003" // cron pattern invalid (croner parse failure)
  | "MRD-CF-SC-004" // scheduleId not found on cancel
  // Transport
  | "MRD-CF-TR-001" // payload exceeds 1 MB wire limit
  | "MRD-CF-TR-002" // broadcast selector produced zero recipients
  | "MRD-CF-TR-003" // inbox partition full (per-sender backpressure)
  // Resources
  | "MRD-CF-RS-001" // reportTokens would exceed maxTokensTotal
  | "MRD-CF-RS-002" // reportCost would exceed maxCostUsd
  | "MRD-CF-RS-003" // reportTokens single-call exceeds maxTokensPerCall
  | "MRD-CF-RS-004" // activeOperations would exceed maxConcurrency
  // Experimental
  | "MRD-CF-EX-001" // snapshotState unavailable in v0.1
  | "MRD-CF-EX-002" // SpawnConfig.fromSnapshot rejected in v0.1
  | "MRD-CF-EX-003" // PermissionScope ignored (dropped with warning in v0.1)
  | "MRD-CF-EX-004" // setPermissions unavailable in v0.1
  | "MRD-CF-EX-005" // getPermissions unavailable in v0.1
  // Auth (M4a — gating via Authorization: Bearer on mutation routes)
  | "MRD-CF-AU-001" // missing Authorization header on a gated route
  | "MRD-CF-AU-002" // Authorization header present but bearer token doesn't match
  | "MRD-CF-AU-003"; // Authorization scheme other than Bearer (Basic, Digest, etc)

interface CodeSpec {
  category: ErrorCategory;
  retryable: boolean;
  summary: string;
}

const CATALOG: Record<MeridianErrorCode, CodeSpec> = {
  "MRD-CF-LC-001": {
    category: "already_exists",
    retryable: false,
    summary:
      "agent identity conflict: this DO was already spawned with a different id/domain",
  },
  "MRD-CF-LC-002": {
    category: "not_found",
    retryable: false,
    summary: "agent not spawned; call spawn() before other lifecycle methods",
  },
  "MRD-CF-LC-003": {
    category: "invalid_argument",
    retryable: false,
    summary: "cannot resume an agent that has been terminated",
  },
  "MRD-CF-LC-004": {
    category: "invalid_argument",
    retryable: false,
    summary: "SpawnConfig.id and SpawnConfig.domain are required",
  },
  "MRD-CF-LC-005": {
    category: "permission_denied",
    retryable: false,
    summary:
      "SpawnConfig.id does not match the DO binding name (sender-identity spoof guard)",
  },
  "MRD-CF-ST-001": {
    category: "invalid_argument",
    retryable: false,
    summary: "state key exceeds 1024-byte UTF-8 limit (RUNTIME-SPEC §4.2)",
  },
  "MRD-CF-ST-002": {
    category: "invalid_argument",
    retryable: false,
    summary: "state value exceeds 1 MB limit (RUNTIME-SPEC §4.2)",
  },
  "MRD-CF-ST-003": {
    category: "invalid_argument",
    retryable: false,
    summary: "state key is empty or uses a reserved prefix (__, state::)",
  },
  "MRD-CF-SC-001": {
    category: "invalid_argument",
    retryable: false,
    summary: "scheduleAt delay below 1-second minimum (RUNTIME-SPEC §4.3)",
  },
  "MRD-CF-SC-002": {
    category: "invalid_argument",
    retryable: false,
    summary: "scheduleAt delay above 365-day maximum (RUNTIME-SPEC §4.3)",
  },
  "MRD-CF-SC-003": {
    category: "invalid_argument",
    retryable: false,
    summary: "cron pattern rejected by croner",
  },
  "MRD-CF-SC-004": {
    category: "not_found",
    retryable: false,
    summary: "scheduleId not registered on this agent",
  },
  "MRD-CF-TR-001": {
    category: "invalid_argument",
    retryable: false,
    summary: "transport payload exceeds 1 MB wire limit (RUNTIME-SPEC §4.4)",
  },
  "MRD-CF-TR-002": {
    category: "not_found",
    retryable: false,
    summary: "broadcast selector matched zero registered agents",
  },
  "MRD-CF-TR-003": {
    category: "resource_exhausted",
    retryable: true,
    summary:
      "inbox partition full for this (sender, recipient) pair; retry with backoff",
  },
  "MRD-CF-RS-001": {
    category: "resource_exhausted",
    retryable: false,
    summary:
      "reportTokens would exceed ResourceLimits.maxTokensTotal (RUNTIME-SPEC §4.5)",
  },
  "MRD-CF-RS-002": {
    category: "resource_exhausted",
    retryable: false,
    summary:
      "reportCost would exceed ResourceLimits.maxCostUsd (RUNTIME-SPEC §4.5)",
  },
  "MRD-CF-RS-003": {
    category: "invalid_argument",
    retryable: false,
    summary: "reportTokens single call exceeds ResourceLimits.maxTokensPerCall",
  },
  "MRD-CF-RS-004": {
    category: "resource_exhausted",
    retryable: true,
    summary: "concurrent operations would exceed ResourceLimits.maxConcurrency",
  },
  "MRD-CF-EX-001": {
    category: "unavailable",
    retryable: false,
    summary: "snapshotState is @experimental and not implemented in v0.1",
  },
  "MRD-CF-EX-002": {
    category: "unavailable",
    retryable: false,
    summary:
      "SpawnConfig.fromSnapshot rejected: snapshots not implemented in v0.1",
  },
  "MRD-CF-EX-003": {
    category: "unavailable",
    retryable: false,
    summary:
      "SpawnConfig.permissions is dropped in v0.1 (no enforcement); upgrade to v0.1.5 for AuthPlugin",
  },
  "MRD-CF-EX-004": {
    category: "unavailable",
    retryable: false,
    summary:
      "setPermissions is @experimental and not implemented in v0.1 (AuthPlugin lands in v0.1.5)",
  },
  "MRD-CF-EX-005": {
    category: "unavailable",
    retryable: false,
    summary:
      "getPermissions is @experimental and not implemented in v0.1 (AuthPlugin lands in v0.1.5)",
  },
  "MRD-CF-AU-001": {
    category: "unauthenticated",
    retryable: false,
    summary:
      "missing Authorization header on a route that requires bearer auth",
  },
  "MRD-CF-AU-002": {
    category: "unauthenticated",
    retryable: false,
    summary: "bearer token does not match the configured auth.bearer",
  },
  "MRD-CF-AU-003": {
    category: "unauthenticated",
    retryable: false,
    summary:
      "Authorization header uses an unsupported scheme; only `Bearer <token>` is accepted in v0.1",
  },
};

const DOC_BASE_URL = "https://meridianprotocol.dev/errors/";

/**
 * Construct a RuntimeError tagged with a stable catalog code + doc URL.
 * The error's `context` always includes `code` and `docUrl` so log
 * consumers and the `meridian doctor` CLI can render them without
 * re-lookup.
 */
export function meridianError(
  code: MeridianErrorCode,
  message?: string,
  opts: {
    cause?: Error;
    context?: Record<string, unknown>;
  } = {},
): RuntimeError {
  const spec = CATALOG[code];
  const fullMessage = message
    ? `[${code}] ${message}`
    : `[${code}] ${spec.summary}`;
  return new RuntimeError(spec.category, fullMessage, {
    retryable: spec.retryable,
    cause: opts.cause,
    context: {
      code,
      docUrl: `${DOC_BASE_URL}${code}`,
      ...opts.context,
    },
  });
}

/** Returns true if `err` is a Meridian-tagged RuntimeError. */
export function isMeridianError(err: unknown): err is RuntimeError {
  return (
    err instanceof RuntimeError &&
    typeof err.context?.code === "string" &&
    (err.context.code as string).startsWith("MRD-")
  );
}

/**
 * Look up a MRD-CF-* code's category + retryable + docUrl without
 * throwing. Useful when reconstructing Meridian-specific error
 * responses from a plain `Error` whose class identity was stripped
 * by the DO RPC boundary (Workers structured clone reconstructs
 * thrown errors as plain `Error`, so `instanceof RuntimeError` fails
 * on the caller side even when the thrown value was originally one).
 */
export function lookupMeridianCode(code: string): {
  code: MeridianErrorCode;
  category: ErrorCategory;
  retryable: boolean;
  docUrl: string;
} | null {
  if (!(code in CATALOG)) return null;
  const spec = CATALOG[code as MeridianErrorCode];
  return {
    code: code as MeridianErrorCode,
    category: spec.category,
    retryable: spec.retryable,
    docUrl: `${DOC_BASE_URL}${code}`,
  };
}

/**
 * Regex that matches the `[MRD-CF-XX-NNN]` prefix every
 * `meridianError()` throw carries. Exported so adopters can detect
 * Meridian errors in the caller-side view after DO RPC has stripped
 * the class identity.
 */
export const MERIDIAN_ERROR_CODE_RE = /\[(MRD-CF-[A-Z]{2}-\d{3})\]/;

/** Pull the catalog code off a Meridian error, or undefined. */
export function errorCode(err: unknown): MeridianErrorCode | undefined {
  if (isMeridianError(err) && typeof err.context?.code === "string") {
    return err.context.code as MeridianErrorCode;
  }
  return undefined;
}
