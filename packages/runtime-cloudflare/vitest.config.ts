import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// `@cloudflare/vitest-plugin` replaces the deprecated
// `@cloudflare/vitest-pool-workers`. It boots `test/test-worker.ts` (which
// re-exports the DO classes) in workerd via Miniflare. Tests clean up agent
// state explicitly via `terminate()`.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./test/wrangler.toml" },
    }),
  ],
  test: {
    // When a DO RPC method rejects, workerd also reports the DO-side
    // promise as "Uncaught (in promise)", even though the caller awaited it.
    // The old pool only logged that. With tests and DOs in one isolate,
    // the plugin surfaces it as an unhandled rejection. Ignore exactly those:
    // errors carrying a catalog code (`[MRD-CF-…]`), which tests trigger on
    // purpose and assert at the call site. Any other unhandled error still
    // fails the run.
    onUnhandledError(error) {
      if (/^\[MRD-CF-[A-Z]{2}-\d{3}\]/.test(error.message ?? "")) return false;
    },
  },
});
