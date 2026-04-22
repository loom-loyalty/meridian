/**
 * Error catalog for `@loom-loyalty/meridian-runtime-cloudflare`.
 *
 * Every {@link RuntimeError} this adapter raises carries a stable `code`
 * of the form `MRD-CF-<primitive>-<nnn>` and a `docUrl` pointing at the
 * matching page on `meridian.dev/errors/`. The code catalog is part of
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
  // Experimental
  | "MRD-CF-EX-001" // snapshotState unavailable in v0.1
  | "MRD-CF-EX-002" // SpawnConfig.fromSnapshot rejected in v0.1
  | "MRD-CF-EX-003"; // PermissionScope ignored (dropped with warning in v0.1)

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
};

const DOC_BASE_URL = "https://meridian.dev/errors/";

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

/** Pull the catalog code off a Meridian error, or undefined. */
export function errorCode(err: unknown): MeridianErrorCode | undefined {
  if (isMeridianError(err) && typeof err.context?.code === "string") {
    return err.context.code as MeridianErrorCode;
  }
  return undefined;
}
