import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        // Single-runtime mode with one shared worker across all test
        // files. Tests clean up agent state explicitly via
        // `terminate()`. isolatedStorage=true runs afoul of the
        // "isolated storage failed to pop" assertion that
        // vitest-pool-workers raises when DO stubs aren't disposed
        // across RPC boundaries; we don't use the `using` keyword
        // yet, so stick with manual cleanup.
        singleWorker: true,
        isolatedStorage: false,
        wrangler: { configPath: "./test/wrangler.toml" },
      },
    },
  },
});
