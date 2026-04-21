/**
 * createMeridianWorker — M1 walking-skeleton scope.
 *
 * Returns an `ExportedHandler` that adopters put on their Worker's default
 * export. In M1 the fetch handler just responds 404 for every non-special
 * route; the walking-skeleton tests exercise the primitives via direct
 * DO RPC calls. M2 adds /.well-known/agent-card.json, /admin/*, and the
 * WebSocket upgrade path per the plan's `worker.ts` spec.
 */

import type { AgentEnv } from "./agent-do.js";
import type { AgentSpec } from "./define-agent.js";
import { defineAgent } from "./define-agent.js";

export interface MeridianWorkerConfig {
  agents: AgentSpec[];
}

export function createMeridianWorker(
  config: MeridianWorkerConfig,
): ExportedHandler<AgentEnv> {
  // Re-register any agents passed in the config. Idempotent against prior
  // defineAgent() calls in the adopter's module.
  for (const agent of config.agents) {
    defineAgent(agent);
  }

  return {
    async fetch(_request: Request, _env: AgentEnv): Promise<Response> {
      // M1: no HTTP surface. The walking-skeleton tests speak DO RPC directly.
      // M2 wires up agent-card.json + admin/* + WebSocket upgrade.
      return new Response("Not Implemented", { status: 501 });
    },
  };
}
