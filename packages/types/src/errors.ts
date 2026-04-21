/**
 * Standard error categories and runtime error class.
 * All primitives throw RuntimeError on failure.
 */

/**
 * Error categories for Meridian runtime errors. String literal union; every
 * other closed-value type in this package follows the same pattern so values
 * are zero-cost at runtime and serialize directly to MessagePack / JSON.
 */
export type ErrorCategory =
  | "not_found"
  | "already_exists"
  | "permission_denied"
  | "resource_exhausted"
  | "invalid_argument"
  | "timeout"
  | "unavailable"
  | "internal"
  | "cancelled";

export class RuntimeError extends Error {
  category: ErrorCategory;
  retryable: boolean;
  cause?: Error;
  context?: Record<string, unknown>;

  constructor(
    category: ErrorCategory,
    message: string,
    opts?: { retryable?: boolean; cause?: Error; context?: Record<string, unknown> }
  ) {
    super(message);
    this.name = "RuntimeError";
    this.category = category;
    this.retryable = opts?.retryable ?? false;
    this.cause = opts?.cause;
    this.context = opts?.context;
  }
}
