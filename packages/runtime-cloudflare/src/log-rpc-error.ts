/**
 * Cross-cutting RPC error logging.
 *
 * Wraps a DO RPC method body so any throw is `console.error`-logged
 * with full constructor name + code + message + stack BEFORE the
 * exception crosses the Workers RPC boundary.
 *
 * The motivation: Cloudflare's DO RPC collapses non-standard throws
 * (JS runtime errors, workerd-internal issues, or anything that
 * doesn't match a known CF error type) into the opaque string
 * `"internal error; reference=XXX"` at the CALLER side. The
 * originating stack — the DO's frames — is NOT forwarded. For
 * adopters debugging a real-CF-only flake, that means the only
 * visible signal is a useless reference ID.
 *
 * By logging to `console.error` inside the DO isolate BEFORE the
 * throw propagates, we get the real stack into:
 *   • Workers Logs (viewable in the Cloudflare dashboard, filterable
 *     by agent id / worker name)
 *   • `wrangler tail` streaming (the E2E workflow captures this)
 *
 * Known errors (MeridianError with a MRD-CF-* code) also log, which
 * is a little noisy when scenarios intentionally trigger them — but
 * the uniformity is worth it: one log format, no "did this throw
 * pass through the wrapper" uncertainty. Adopters who want a
 * quieter surface can filter by `code` in their log ingestion.
 */

export async function logRpcError<T>(
  method: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const e = err as Error & { code?: string; cause?: unknown };
    const code = e.code ?? "n/a";
    const ctor = e.constructor?.name ?? "Error";
    const stack = e.stack ?? "(no stack)";
    const causeMsg =
      e.cause && (e.cause as { message?: string }).message
        ? ` | cause: ${(e.cause as { message?: string }).message}`
        : "";
    console.error(
      `[meridian-do] ${method} threw ${ctor}[${code}]: ${e.message}${causeMsg}\n${stack}`,
    );
    throw err;
  }
}
