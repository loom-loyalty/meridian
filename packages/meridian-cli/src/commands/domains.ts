/**
 * `meridian domains` — list agents grouped by domain.
 *
 * Experimental in v0.1 (flagged via `--experimental` in `bin.ts`).
 * Backing endpoint is `GET /admin/domains` which IS stable; we gate
 * the CLI wrapper in case the admin response shape evolves before
 * v0.2 ships.
 */

import { resolveConfig } from "../util/config.js";
import { httpGet } from "../util/http.js";

export interface DomainsOptions {
  flags: Record<string, string | boolean>;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stdout?: NodeJS.WritableStream;
}

interface DomainsResponse {
  domains: Array<{ domain: string; agentIds: string[] }>;
}

export async function domains(opts: DomainsOptions): Promise<number> {
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

  const { body } = await httpGet<DomainsResponse>(
    config.endpoint,
    "/admin/domains",
    { token: config.token },
  );

  if (opts.flags.json) {
    out.write(`${JSON.stringify(body, null, 2)}\n`);
    return 0;
  }

  if (body.domains.length === 0) {
    out.write("(no agents registered)\n");
    return 0;
  }

  for (const d of body.domains) {
    out.write(`${d.domain}:\n`);
    for (const id of d.agentIds) {
      out.write(`  ${id}\n`);
    }
  }
  return 0;
}
