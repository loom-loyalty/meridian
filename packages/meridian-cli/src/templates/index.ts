/**
 * Init templates. Inlined as strings so the published CLI tarball
 * doesn't have to ship raw `.tmpl` files alongside the JS bundle.
 *
 * Placeholders use `__NAME__` so the substitution never collides
 * with a real template syntax. `renderTemplate()` handles the swap
 * in one pass.
 */

export interface TemplateVars {
  projectName: string;
  agentId: string;
  domain: string;
}

export function renderTemplate(tmpl: string, vars: TemplateVars): string {
  return tmpl
    .replace(/__PROJECT_NAME__/g, vars.projectName)
    .replace(/__AGENT_ID__/g, vars.agentId)
    .replace(/__DOMAIN__/g, vars.domain);
}

export const WRANGLER_TOML = `# wrangler.toml — Meridian runtime on Cloudflare.
#
# Adopter setup (one-time):
#   1. wrangler login
#   2. wrangler secret put MERIDIAN_ADMIN_TOKEN  (run \`meridian gen-token\`
#      to mint one first; paste the value when prompted)
#   3. wrangler deploy

name = "__PROJECT_NAME__"
main = "src/worker.ts"
compatibility_date = "2024-11-06"
compatibility_flags = ["nodejs_compat"]

# Durable Object bindings. AgentDurableObject and
# RegistryDurableObject are re-exported from src/worker.ts.

[[durable_objects.bindings]]
name = "AGENT"
class_name = "AgentDurableObject"

[[durable_objects.bindings]]
name = "REGISTRY"
class_name = "RegistryDurableObject"

# SQLite-backed Durable Objects (required for agent state).
[[migrations]]
tag = "v1"
new_sqlite_classes = ["AgentDurableObject", "RegistryDurableObject"]

# Workers Observability — persistent logs + exception tracking in
# the Cloudflare dashboard (Workers & Pages → your worker → Logs).
[observability]
enabled = true
head_sampling_rate = 1.0
`;

export const WORKER_TS = `import {
  AgentDurableObject,
  RegistryDurableObject,
  createMeridianWorker,
} from "@loom-loyalty/meridian-runtime-cloudflare";

import "./agent.js";

// Re-export the DO classes so wrangler can find them by class_name.
export { AgentDurableObject, RegistryDurableObject };

interface Env {
  MERIDIAN_ADMIN_TOKEN?: string;
  AGENT: DurableObjectNamespace;
  REGISTRY: DurableObjectNamespace;
}

// Lazy, per-env handler cache. Workers give us the secret on
// \`env.MERIDIAN_ADMIN_TOKEN\`, not at module-load time, so we build
// the handler on the first request and reuse it on subsequent ones.
// Module scope is per-isolate in Workers — this caches for the life
// of the isolate.
let cached: ReturnType<typeof createMeridianWorker> | undefined;

function getHandler(env: Env) {
  if (!cached) {
    cached = createMeridianWorker({
      agents: [{ id: "__AGENT_ID__", domain: "__DOMAIN__" }],
      agentCard: {
        name: "__PROJECT_NAME__",
        description: "Meridian runtime scaffolded by \`meridian init\`",
        version: "0.1.0",
      },
      // Bearer auth is ON by default. Set MERIDIAN_ADMIN_TOKEN via
      // \`wrangler secret put MERIDIAN_ADMIN_TOKEN\` before deploying,
      // or paste it into \`.dev.vars\` for local \`wrangler dev\`.
      auth: { bearer: env.MERIDIAN_ADMIN_TOKEN },
    });
  }
  return cached;
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return getHandler(env).fetch!(req, env as unknown as Parameters<NonNullable<ReturnType<typeof createMeridianWorker>["fetch"]>>[1], ctx);
  },
};
`;

export const AGENT_TS = `import { defineAgent } from "@loom-loyalty/meridian-runtime-cloudflare";

/**
 * First agent. Runs a "hello" log on spawn so your dashboard shows
 * the agent is alive, then handles messages by echoing the payload
 * length + sender back through the observability surface.
 *
 * Extend with:
 *   • \`onSchedule\` — react to cron / one-shot fires you schedule
 *     via \`ctx.schedule.at()\` / \`ctx.schedule.cron()\`
 *   • \`onTerminate\` — flush state before the DO is wiped
 *   • \`detectors\` — custom quality signals (coming in v0.1.5)
 */
defineAgent({
  id: "__AGENT_ID__",
  domain: "__DOMAIN__",
  async onSpawn(ctx) {
    ctx.obs.log({
      level: "info",
      message: "[__AGENT_ID__] spawned",
    });
  },
  async onMessage(ctx, msg) {
    ctx.obs.log({
      level: "info",
      message: \`[__AGENT_ID__] got \${msg.payload.byteLength}B from \${msg.fromAgentId}\`,
    });
  },
});
`;

export const PACKAGE_JSON = `{
  "name": "__PROJECT_NAME__",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "doctor": "meridian doctor",
    "test": "vitest run"
  },
  "dependencies": {
    "@loom-loyalty/meridian-runtime-cloudflare": "^0.5.0"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20250101.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.9",
    "wrangler": "^3.100.0"
  }
}
`;

export const TSCONFIG_JSON = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "isolatedModules": true
  },
  "include": ["src"]
}
`;

export const DEV_VARS = `# Local-dev secrets (wrangler reads this in \`wrangler dev\`).
# NEVER commit this file — \`.gitignore\` excludes it by default.
#
# Mint a token via: meridian gen-token
# Then paste it below:
MERIDIAN_ADMIN_TOKEN=""
`;

export const GITIGNORE = `node_modules
.wrangler
.dev.vars
dist
`;

export const README = `# __PROJECT_NAME__

Meridian runtime on Cloudflare Workers + Durable Objects, scaffolded
via \`meridian init\`.

## Next steps

\`\`\`bash
# 1. Install dependencies
pnpm install

# 2. Mint an admin token
meridian gen-token --dev-vars

# 3. Run locally
pnpm dev
# Open http://localhost:8787/.well-known/agent-card.json to confirm
# the worker + AgentCard discovery endpoint are up.

# 4. Run diagnostics
meridian doctor

# 5. Deploy
wrangler secret put MERIDIAN_ADMIN_TOKEN   # paste the token from step 2
wrangler deploy
\`\`\`

## Agent

The starter agent is in \`src/agent.ts\`. It logs a "spawned" message
on \`onSpawn\` and echoes message size on \`onMessage\`. Replace with
your own logic.

## Admin surface

After deploy, the CLI can introspect your runtime:

\`\`\`bash
meridian domains                     # list agents grouped by domain
meridian inspect __AGENT_ID__        # handle + usage + schedules + state
\`\`\`

Both commands read the endpoint + token from \`.dev.vars\` for local
dev, or from \`MERIDIAN_ENDPOINT\` / \`MERIDIAN_ADMIN_TOKEN\` env vars
for deployed runtimes.
`;
