/**
 * Test harness Worker entry.
 *
 * Miniflare needs a Worker module to boot the DO isolates. Tests exercise
 * the DOs via RPC directly; this fetch handler is intentionally a stub.
 * Adopters write their own `worker.ts` and bind their agent specs via
 * `createMeridianWorker()`.
 */

export { AgentDurableObject } from "../src/agent-do.js";
export { RegistryDurableObject } from "../src/registry-do.js";

export default {
  async fetch(): Promise<Response> {
    return new Response("test harness", { status: 200 });
  },
};
