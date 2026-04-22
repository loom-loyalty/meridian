#!/usr/bin/env node
/**
 * `meridian` — developer CLI for the Meridian protocol.
 *
 * Stable commands (v0.1):
 *   init         scaffold a Cloudflare adopter project
 *   gen-token    mint a cryptographically random admin token
 *   demo         spawn a canned agent to prove the round-trip
 *   doctor       run local + remote health checks
 *
 * Experimental commands (v0.1 behind --experimental):
 *   inspect <id> GET /admin/agents/:id on a running runtime
 *   domains      GET /admin/domains on a running runtime
 *
 * Experimental gate: adopters MUST pass `--experimental` on the
 * invocation (or set `MERIDIAN_EXPERIMENTAL=1`). The gate exists
 * because the CLI wrapper shape may evolve across v0.1.x even
 * though the underlying HTTP endpoints are stable.
 */

import { parseArgs } from "./util/args.js";
import { CliHttpError } from "./util/http.js";

import { demo } from "./commands/demo.js";
import { doctor } from "./commands/doctor.js";
import { domains } from "./commands/domains.js";
import { genToken } from "./commands/gen-token.js";
import { init } from "./commands/init.js";
import { inspect } from "./commands/inspect.js";

const STABLE_COMMANDS = new Set([
  "init",
  "gen-token",
  "demo",
  "doctor",
  "help",
]);
const EXPERIMENTAL_COMMANDS = new Set(["inspect", "domains"]);

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const { command, positional, flags } = parsed;

  if (!command || command === "help" || flags.help === true) {
    printUsage(process.stdout);
    return 0;
  }

  if (flags.version === true) {
    // Kept in sync with package.json via the `version` field.
    process.stdout.write("meridian 0.1.0\n");
    return 0;
  }

  const isExperimentalRequest =
    flags.experimental === true ||
    process.env.MERIDIAN_EXPERIMENTAL === "1" ||
    EXPERIMENTAL_COMMANDS.has(command) === false;

  if (EXPERIMENTAL_COMMANDS.has(command) && !isExperimentalRequest) {
    process.stderr.write(
      `${command} is experimental in v0.1. Pass --experimental or set MERIDIAN_EXPERIMENTAL=1 to use it.\n`,
    );
    return 2;
  }

  if (!STABLE_COMMANDS.has(command) && !EXPERIMENTAL_COMMANDS.has(command)) {
    process.stderr.write(`unknown command: ${command}\n\n`);
    printUsage(process.stderr);
    return 2;
  }

  try {
    switch (command) {
      case "init": {
        const projectName =
          typeof flags.project === "string" ? flags.project : positional[0];
        init({
          projectName,
          agentId:
            typeof flags["agent-id"] === "string"
              ? flags["agent-id"]
              : undefined,
          domain: typeof flags.domain === "string" ? flags.domain : undefined,
          force: flags.force === true,
        });
        return 0;
      }
      case "gen-token": {
        genToken({
          devVars: flags["dev-vars"] === true,
          wrangler: flags.wrangler === true,
        });
        return 0;
      }
      case "demo":
        return await demo({ flags });
      case "doctor":
        return await doctor({ flags });
      case "domains":
        return await domains({ flags });
      case "inspect": {
        const agentId = positional[0];
        if (!agentId) {
          process.stderr.write(
            "usage: meridian inspect <agentId> [--experimental]\n",
          );
          return 2;
        }
        return await inspect({ agentId, flags });
      }
      default:
        // Unreachable — STABLE_COMMANDS / EXPERIMENTAL_COMMANDS exhaustively checked above.
        return 2;
    }
  } catch (err) {
    if (err instanceof CliHttpError) {
      process.stderr.write(`error (${err.status}): ${err.message}\n`);
      if (err.code) process.stderr.write(`  code: ${err.code}\n`);
      if (err.docUrl) process.stderr.write(`  docs: ${err.docUrl}\n`);
      return 1;
    }
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }
}

function printUsage(out: NodeJS.WritableStream): void {
  out.write(`meridian — CLI for the Meridian protocol runtime

Usage:
  meridian <command> [options]

Stable commands:
  init [name]              scaffold a Cloudflare adopter project
  gen-token                mint a cryptographically random admin token
  demo                     spawn a canned agent (needs --endpoint)
  doctor                   run local + remote health checks

Experimental commands (pass --experimental):
  inspect <agentId>        GET /admin/agents/:id
  domains                  GET /admin/domains

Global flags:
  --endpoint <url>         Meridian runtime URL (overrides env/.dev.vars)
  --token <secret>         MERIDIAN_ADMIN_TOKEN (overrides env/.dev.vars)
  --json                   emit raw JSON on read commands
  --help                   show this message
  --version                print version
`);
}

// Only run when invoked directly (not when imported in tests).
if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`fatal: ${(err as Error).message}\n`);
      process.exit(1);
    },
  );
}

export { main };
