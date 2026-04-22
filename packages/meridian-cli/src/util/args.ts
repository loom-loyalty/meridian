/**
 * Minimal argv parser for the `meridian` CLI. No deps on purpose —
 * the CLI ships as a zero-dependency package so `pnpm dlx
 * @loom-loyalty/meridian-cli init` stays fast.
 *
 * Supports:
 *   • positional args (e.g. `meridian inspect <agentId>`)
 *   • long flags `--name=value` or `--name value`
 *   • boolean flags `--experimental`
 *   • short boolean flags bundled or individual (`-h`, `-v`)
 *
 * Does NOT support:
 *   • `--` separator (no pass-through needed yet)
 *   • numeric coercion (callers parse)
 *   • aliases beyond what each command declares
 */

export interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Parse argv into a command + positional + flag structure.
 * `rawArgv` is `process.argv.slice(2)` normally, passed in so tests
 * can exercise directly.
 */
export function parseArgs(rawArgv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let command: string | undefined;

  for (let i = 0; i < rawArgv.length; i++) {
    const arg = rawArgv[i]!;

    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else {
        // Peek next arg; if it's another flag or EOL, treat as bool.
        const next = rawArgv[i + 1];
        if (next === undefined || next.startsWith("-")) {
          flags[body] = true;
        } else {
          flags[body] = next;
          i++;
        }
      }
      continue;
    }

    if (arg.startsWith("-") && arg.length > 1) {
      // Short bundled flags: `-abc` → {a: true, b: true, c: true}.
      for (const ch of arg.slice(1)) {
        flags[ch] = true;
      }
      continue;
    }

    if (command === undefined) {
      command = arg;
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, flags };
}
