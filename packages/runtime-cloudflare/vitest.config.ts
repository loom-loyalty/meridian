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
});
