import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        // Each test sets up its own agent IDs and terminates at the end; we
        // rely on explicit teardown rather than the pool's auto-isolation.
        isolatedStorage: false,
        wrangler: { configPath: "./test/wrangler.toml" },
      },
    },
  },
});
