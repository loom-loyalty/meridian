/**
 * `meridian inspect <agentId>` — unified agent inspect.
 *
 * Experimental in v0.1 (flagged via `--experimental` in `bin.ts`).
 * Backing endpoint is `GET /admin/agents/:id` which IS stable; we
 * gate the CLI wrapper in case the response shape evolves.
 *
 * `--json` prints raw response. Default formatting is a flat
 * human-readable layout (handle + usage totals + schedule count +
 * state key count + inbox length).
 */

import { resolveConfig } from "../util/config.js";
import { httpGet } from "../util/http.js";

export interface InspectOptions {
  agentId: string;
  flags: Record<string, string | boolean>;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stdout?: NodeJS.WritableStream;
}

interface InspectResponse {
  agent: {
    id: string;
    domain: string;
    status: string;
    spawnedAt: number;
  };
  schedules: Array<{ id: string; type: string }>;
  usage: {
    current: {
      memoryMB: number;
      cpuMsLifetime: number;
      tokensLifetime: number;
      costUsdLifetime: number;
      activeOperations: number;
    };
    warnings: Array<{ type: string }>;
  };
  state: { keys: string[]; cursor?: string };
  inbox: { length: number };
}

export async function inspect(opts: InspectOptions): Promise<number> {
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

  const { body } = await httpGet<InspectResponse>(
    config.endpoint,
    `/admin/agents/${encodeURIComponent(opts.agentId)}`,
    { token: config.token },
  );

  if (opts.flags.json) {
    out.write(`${JSON.stringify(body, null, 2)}\n`);
    return 0;
  }

  const spawnedAt = new Date(body.agent.spawnedAt).toISOString();
  out.write(`agent:     ${body.agent.id} (${body.agent.domain})\n`);
  out.write(`status:    ${body.agent.status}\n`);
  out.write(`spawned:   ${spawnedAt}\n`);
  out.write(`schedules: ${body.schedules.length}\n`);
  out.write(
    `usage:     ${body.usage.current.tokensLifetime} tokens, $${body.usage.current.costUsdLifetime.toFixed(4)} (${body.usage.warnings.length} warnings)\n`,
  );
  out.write(`state:     ${body.state.keys.length} keys\n`);
  out.write(`inbox:     ${body.inbox.length} messages\n`);
  return 0;
}
