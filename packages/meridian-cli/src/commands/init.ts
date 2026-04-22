/**
 * `meridian init [name]` — scaffold a Cloudflare Meridian project.
 *
 * Creates a new directory with:
 *   • wrangler.toml
 *   • package.json
 *   • tsconfig.json
 *   • .gitignore
 *   • .dev.vars (secrets, excluded from git)
 *   • README.md
 *   • src/worker.ts (re-exports DOs + createMeridianWorker)
 *   • src/agent.ts (starter agent via defineAgent)
 *
 * Defaults (override with flags):
 *   --project    → last positional arg, or "my-meridian-app"
 *   --agent-id   → "hello"
 *   --domain     → "demo"
 *
 * Prints next-step commands (install, gen-token, dev, deploy) on
 * completion so the adopter is never guessing what comes next.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  AGENT_TS,
  DEV_VARS,
  GITIGNORE,
  PACKAGE_JSON,
  README,
  TSCONFIG_JSON,
  WORKER_TS,
  WRANGLER_TOML,
  renderTemplate,
} from "../templates/index.js";

export interface InitOptions {
  /** Target directory name (also used as wrangler project name). */
  projectName?: string;
  /** Starter agent id. Defaults to "hello". */
  agentId?: string;
  /** Starter agent domain. Defaults to "demo". */
  domain?: string;
  /** Override CWD for tests. */
  cwd?: string;
  /** Override stdout for tests. */
  stdout?: NodeJS.WritableStream;
  /** If true, allow writing into an existing non-empty dir. */
  force?: boolean;
}

export function init(opts: InitOptions = {}): string {
  const out = opts.stdout ?? process.stdout;
  const cwd = opts.cwd ?? process.cwd();
  const projectName = opts.projectName ?? "my-meridian-app";
  const agentId = opts.agentId ?? "hello";
  const domain = opts.domain ?? "demo";

  const target = resolve(cwd, projectName);
  mkdirSync(target, { recursive: true });

  if (!opts.force && existsSync(target) && readdirSync(target).length > 0) {
    throw new Error(
      `Target directory ${target} is not empty. Pass --force to scaffold into it anyway.`,
    );
  }

  mkdirSync(join(target, "src"), { recursive: true });

  const vars = { projectName, agentId, domain };
  writeFileSync(
    join(target, "wrangler.toml"),
    renderTemplate(WRANGLER_TOML, vars),
  );
  writeFileSync(
    join(target, "package.json"),
    renderTemplate(PACKAGE_JSON, vars),
  );
  writeFileSync(
    join(target, "tsconfig.json"),
    renderTemplate(TSCONFIG_JSON, vars),
  );
  writeFileSync(join(target, ".gitignore"), GITIGNORE);
  writeFileSync(join(target, ".dev.vars"), DEV_VARS, { mode: 0o600 });
  writeFileSync(join(target, "README.md"), renderTemplate(README, vars));
  writeFileSync(
    join(target, "src", "worker.ts"),
    renderTemplate(WORKER_TS, vars),
  );
  writeFileSync(
    join(target, "src", "agent.ts"),
    renderTemplate(AGENT_TS, vars),
  );

  out.write(`scaffolded Meridian project at ${target}\n`);
  out.write(`\nNext steps:\n`);
  out.write(`  cd ${projectName}\n`);
  out.write(`  pnpm install\n`);
  out.write(`  meridian gen-token --dev-vars\n`);
  out.write(`  pnpm dev\n`);
  out.write(`\nThen deploy:\n`);
  out.write(`  wrangler secret put MERIDIAN_ADMIN_TOKEN\n`);
  out.write(`  wrangler deploy\n`);

  return target;
}
