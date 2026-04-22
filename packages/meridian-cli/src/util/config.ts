/**
 * Resolve the Meridian endpoint + admin token used by CLI commands.
 *
 * Resolution order:
 *   1. Explicit `--endpoint` / `--token` CLI flags
 *   2. Env vars `MERIDIAN_ENDPOINT` / `MERIDIAN_ADMIN_TOKEN`
 *   3. `.dev.vars` at the repo root (simple `KEY=value` parser,
 *      same format `wrangler` writes)
 *
 * Nothing is written to disk here — this is pure read-side.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface MeridianConfig {
  endpoint: string | undefined;
  token: string | undefined;
}

/**
 * Build the effective config by merging CLI flags, env vars, and
 * `.dev.vars`. `cwd` is a parameter so tests can point at a tmpdir.
 */
export function resolveConfig(opts: {
  flags: Record<string, string | boolean>;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): MeridianConfig {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();

  const fromFlags = {
    endpoint:
      typeof opts.flags.endpoint === "string" ? opts.flags.endpoint : undefined,
    token: typeof opts.flags.token === "string" ? opts.flags.token : undefined,
  };

  const fromEnv = {
    endpoint: env.MERIDIAN_ENDPOINT,
    token: env.MERIDIAN_ADMIN_TOKEN,
  };

  const fromDevVars = readDevVars(join(cwd, ".dev.vars"));

  return {
    endpoint:
      fromFlags.endpoint ?? fromEnv.endpoint ?? fromDevVars.MERIDIAN_ENDPOINT,
    token: fromFlags.token ?? fromEnv.token ?? fromDevVars.MERIDIAN_ADMIN_TOKEN,
  };
}

/**
 * Parse a `.dev.vars` file into a flat map. Matches `wrangler`'s
 * behavior closely enough for our needs: strips surrounding quotes,
 * ignores blank lines + `#` comments, one `KEY=value` per line.
 */
function readDevVars(path: string): Record<string, string | undefined> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
