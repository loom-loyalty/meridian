/**
 * Standard error categories and runtime error class.
 * All primitives throw RuntimeError on failure.
 */

export enum ErrorCategory {
  NOT_FOUND = "not_found",
  ALREADY_EXISTS = "already_exists",
  PERMISSION_DENIED = "permission_denied",
  RESOURCE_EXHAUSTED = "resource_exhausted",
  INVALID_ARGUMENT = "invalid_argument",
  TIMEOUT = "timeout",
  UNAVAILABLE = "unavailable",
  INTERNAL = "internal",
  CANCELLED = "cancelled",
}

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
