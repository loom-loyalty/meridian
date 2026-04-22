/**
 * `meridian gen-token` — mint a cryptographically random admin token.
 *
 * Writes to stdout in a form adopters can paste directly:
 *
 *   export MERIDIAN_ADMIN_TOKEN="..."
 *
 * With `--dev-vars`, also appends the token to `.dev.vars` in the
 * current directory (creating or updating the `MERIDIAN_ADMIN_TOKEN`
 * line). With `--wrangler`, prints the `wrangler secret put` command
 * instead of the export line.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface GenTokenOptions {
  /** Append or update `MERIDIAN_ADMIN_TOKEN=...` in `./.dev.vars`. */
  devVars?: boolean;
  /** Print the `wrangler secret put` command instead of export. */
  wrangler?: boolean;
  /** Override the working directory (for tests). */
  cwd?: string;
  /** Override the writable stdout stream (for tests). */
  stdout?: NodeJS.WritableStream;
}

export function genToken(opts: GenTokenOptions = {}): string {
  const token = mintToken();
  const out = opts.stdout ?? process.stdout;

  if (opts.devVars) {
    const path = join(opts.cwd ?? process.cwd(), ".dev.vars");
    writeDevVarsToken(path, token);
    out.write(`wrote MERIDIAN_ADMIN_TOKEN to ${path}\n`);
    out.write(`token: ${token}\n`);
    return token;
  }

  if (opts.wrangler) {
    out.write(`echo "${token}" | wrangler secret put MERIDIAN_ADMIN_TOKEN\n`);
    return token;
  }

  out.write(`export MERIDIAN_ADMIN_TOKEN="${token}"\n`);
  return token;
}

/**
 * 32-byte URL-safe base64 token. ~256 bits of entropy; `+` and `/`
 * mapped to `-` / `_` so the token works unquoted in shell and URLs.
 */
function mintToken(): string {
  return randomBytes(32)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Update `.dev.vars` in place. If the file exists and already has a
 * `MERIDIAN_ADMIN_TOKEN=...` line, replace that line. Otherwise
 * append.
 */
function writeDevVarsToken(path: string, token: string): void {
  const line = `MERIDIAN_ADMIN_TOKEN="${token}"`;
  if (!existsSync(path)) {
    writeFileSync(path, `${line}\n`, { mode: 0o600 });
    return;
  }
  const raw = readFileSync(path, "utf8");
  const re = /^MERIDIAN_ADMIN_TOKEN=.*$/m;
  const next = re.test(raw)
    ? raw.replace(re, line)
    : raw.replace(/\n?$/, `\n${line}\n`);
  writeFileSync(path, next);
}
