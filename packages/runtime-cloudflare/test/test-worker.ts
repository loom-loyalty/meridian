/**
 * Test harness Worker entry.
 *
 * Miniflare needs a Worker module to boot the DO isolates. Tests exercise
 * the DOs via RPC directly; this fetch handler is intentionally a stub.
 * Adopters write their own `worker.ts` and bind their agent specs via
 * `createMeridianWorker()`.
 *
 * The JSON shape below is also what the real-CF E2E workflow asserts on
 * (`.github/workflows/e2e-cloudflare.yml`). Keep fields stable; adding
 * fields is fine, removing or renaming will break the smoke check.
 */

export { AgentDurableObject } from "../src/agent-do.js";
export { RegistryDurableObject } from "../src/registry-do.js";

export default {
  async fetch(): Promise<Response> {
    const body = {
      runtime: "meridian-cloudflare",
      milestone: "m1-walking-skeleton",
      healthy: true,
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
};
