/**
 * `meridian demo` — the "magical moment" closer.
 *
 * Spawns a demo agent named `meridian-demo` in the `meridian-demo`
 * domain, sends it a canned message containing a pre-shaped
 * `InsightFeedback` payload, then drains its inbox to prove the
 * round-trip worked.
 *
 * This is the competitive-tier TTHW closer: after `init → install →
 * dev`, an adopter runs `meridian demo` and sees a real agent do
 * real work against their local runtime in under 30 seconds.
 *
 * **Assumptions**
 *
 * The target worker must have an agent registered with id
 * `meridian-demo` and domain `meridian-demo`. The scaffolded
 * `src/agent.ts` uses `hello` by default, so adopters running
 * `meridian demo` against a fresh init project need to either:
 *   (a) rename the starter agent to `meridian-demo`, or
 *   (b) pass `--agent-id <id> --domain <d>` to target whatever
 *       they registered.
 *
 * The demo itself is runtime-agnostic — it only uses the public
 * HTTP surface.
 */

import { resolveConfig } from "../util/config.js";
import { httpGet, httpPost } from "../util/http.js";

export interface DemoOptions {
  flags: Record<string, string | boolean>;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stdout?: NodeJS.WritableStream;
}

const DEFAULT_AGENT_ID = "meridian-demo";
const DEFAULT_DOMAIN = "meridian-demo";

export async function demo(opts: DemoOptions): Promise<number> {
  const out = opts.stdout ?? process.stdout;
  const config = resolveConfig({
    flags: opts.flags,
    env: opts.env,
    cwd: opts.cwd,
  });

  if (!config.endpoint) {
    out.write(
      "error: MERIDIAN_ENDPOINT not set. Pass --endpoint or set it in .dev.vars.\n",
    );
    return 1;
  }

  const agentId =
    typeof opts.flags["agent-id"] === "string"
      ? opts.flags["agent-id"]
      : DEFAULT_AGENT_ID;
  const domain =
    typeof opts.flags["domain"] === "string"
      ? opts.flags["domain"]
      : DEFAULT_DOMAIN;
  const tokenOpts = { token: config.token };

  // 1. Spawn.
  out.write(`[1/4] spawning ${agentId} in domain ${domain}...\n`);
  await httpPost(
    config.endpoint,
    `/agents/${encodeURIComponent(agentId)}/spawn`,
    { domain },
    tokenOpts,
  );

  // 2. Send a canned InsightFeedback-shaped payload to itself.
  // The demo agent's `onMessage` (from the init template) logs the
  // byte count; the point is to prove the round-trip, not the
  // payload semantics.
  const insight = {
    type: "insight",
    summary: "meridian-demo: canned hello from the CLI",
    tier: "expected",
    confidence: 0.85,
  };
  const payload = btoa(JSON.stringify(insight));
  out.write(`[2/4] sending canned InsightFeedback payload...\n`);
  await httpPost(
    config.endpoint,
    `/agents/${encodeURIComponent(agentId)}/messages`,
    { to: agentId, payload },
    tokenOpts,
  );

  // 3. Drain the inbox to prove delivery.
  out.write(`[3/4] draining inbox...\n`);
  const { body: drain } = await httpPost<{
    messages: Array<{ payload: string; fromAgentId: string }>;
  }>(
    config.endpoint,
    `/agents/${encodeURIComponent(agentId)}/inbox/drain`,
    undefined,
    tokenOpts,
  );
  const got = drain.messages.length;

  // 4. Show the result.
  out.write(`[4/4] received ${got} message(s)\n`);
  if (got > 0) {
    const first = drain.messages[0]!;
    const decoded = JSON.parse(atob(first.payload)) as Record<string, unknown>;
    out.write(`       from:    ${first.fromAgentId}\n`);
    out.write(`       payload: ${JSON.stringify(decoded)}\n`);
  }

  // Bonus: confirm domain listing shows the agent.
  try {
    const { body: domains } = await httpGet<{
      domains: Array<{ domain: string; agentIds: string[] }>;
    }>(config.endpoint, "/admin/domains", tokenOpts);
    const bucket = domains.domains.find((d) => d.domain === domain);
    if (bucket && bucket.agentIds.includes(agentId)) {
      out.write(`\nAdmin surface sees agent:\n`);
      out.write(`  ${agentId} (${domain}) — registered\n`);
    }
  } catch {
    // Admin route may not be configured; that's fine for the demo.
  }

  out.write(`\ndone. Run \`meridian inspect ${agentId}\` for full state.\n`);
  return 0;
}
