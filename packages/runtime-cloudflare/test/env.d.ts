/// <reference types="@cloudflare/vitest-pool-workers" />

import type { AgentDurableObject } from "../src/agent-do.js";
import type { RegistryDurableObject } from "../src/registry-do.js";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    AGENT: DurableObjectNamespace<AgentDurableObject>;
    REGISTRY: DurableObjectNamespace<RegistryDurableObject>;
  }
}
