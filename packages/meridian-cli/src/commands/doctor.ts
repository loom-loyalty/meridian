/**
 * `meridian doctor` — local-env + remote-health diagnostics.
 *
 * Checks (in order):
 *   1. Node version is >= 22
 *   2. `MERIDIAN_ADMIN_TOKEN` is present (env or `.dev.vars`)
 *   3. `MERIDIAN_ENDPOINT` is set (env or `.dev.vars`) OR user
 *      passes `--endpoint`
 *   4. Health endpoint responds 200
 *   5. AgentCard endpoint returns a v1 shape
 *   6. AgentCard advertises `securitySchemes.bearer` (auth enabled)
 *   7. Admin route accepts the configured token
 *
 * Exits 0 if everything green, 1 if any check fails. Prints each
 * result inline so adopters see WHAT failed without scrolling.
 *
 * Designed to be the first thing an adopter runs when something
 * doesn't work. Every check points at a single concrete remediation.
 */

import { resolveConfig } from "../util/config.js";
import { CliHttpError, httpGet } from "../util/http.js";

export interface DoctorOptions {
  flags: Record<string, string | boolean>;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stdout?: NodeJS.WritableStream;
}

interface CheckResult {
  name: string;
  status: "pass" | "fail" | "skip";
  detail: string;
  remediation?: string;
}

export async function doctor(opts: DoctorOptions): Promise<number> {
  const out = opts.stdout ?? process.stdout;
  const results: CheckResult[] = [];

  results.push(checkNodeVersion());

  const config = resolveConfig({
    flags: opts.flags,
    env: opts.env,
    cwd: opts.cwd,
  });

  results.push(checkAdminToken(config.token));
  results.push(checkEndpoint(config.endpoint));

  // Remote checks gated on having an endpoint.
  if (config.endpoint) {
    results.push(await checkHealth(config.endpoint));
    const cardCheck = await checkAgentCard(config.endpoint);
    results.push(cardCheck.health);
    results.push(cardCheck.security);
    if (config.token) {
      results.push(await checkAdminAuth(config.endpoint, config.token));
    } else {
      results.push({
        name: "admin-auth",
        status: "skip",
        detail: "skipping — no MERIDIAN_ADMIN_TOKEN available",
      });
    }
  } else {
    for (const name of [
      "health",
      "agent-card",
      "security-schemes",
      "admin-auth",
    ]) {
      results.push({
        name,
        status: "skip",
        detail: `skipping — no MERIDIAN_ENDPOINT`,
      });
    }
  }

  for (const r of results) {
    const mark =
      r.status === "pass" ? "OK " : r.status === "fail" ? "FAIL" : "SKIP";
    out.write(`[${mark}] ${r.name}: ${r.detail}\n`);
    if (r.remediation) {
      out.write(`       → ${r.remediation}\n`);
    }
  }

  const failed = results.some((r) => r.status === "fail");
  return failed ? 1 : 0;
}

function checkNodeVersion(): CheckResult {
  const raw = process.versions.node;
  const major = Number(raw.split(".")[0]);
  if (major >= 22) {
    return {
      name: "node-version",
      status: "pass",
      detail: `Node ${raw}`,
    };
  }
  return {
    name: "node-version",
    status: "fail",
    detail: `Node ${raw} (want >= 22)`,
    remediation: "Upgrade via nvm: `nvm install 22 && nvm use 22`",
  };
}

function checkAdminToken(token: string | undefined): CheckResult {
  if (!token) {
    return {
      name: "admin-token",
      status: "fail",
      detail: "MERIDIAN_ADMIN_TOKEN not found in env or .dev.vars",
      remediation: "Run `meridian gen-token --dev-vars` to mint one.",
    };
  }
  if (token.length < 20) {
    return {
      name: "admin-token",
      status: "fail",
      detail: `token is only ${token.length} chars — too short for secure bearer auth`,
      remediation: "Regenerate with `meridian gen-token --dev-vars`.",
    };
  }
  return {
    name: "admin-token",
    status: "pass",
    detail: `present (${token.length} chars)`,
  };
}

function checkEndpoint(endpoint: string | undefined): CheckResult {
  if (!endpoint) {
    return {
      name: "endpoint",
      status: "fail",
      detail: "MERIDIAN_ENDPOINT not set",
      remediation:
        "Pass --endpoint=https://<your-worker>.workers.dev OR set MERIDIAN_ENDPOINT in .dev.vars.",
    };
  }
  try {
    new URL(endpoint);
  } catch {
    return {
      name: "endpoint",
      status: "fail",
      detail: `MERIDIAN_ENDPOINT is not a valid URL: ${endpoint}`,
      remediation: "Fix the URL format (protocol + host).",
    };
  }
  return {
    name: "endpoint",
    status: "pass",
    detail: endpoint,
  };
}

async function checkHealth(endpoint: string): Promise<CheckResult> {
  try {
    const { body } = await httpGet<{ healthy?: boolean; runtime?: string }>(
      endpoint,
      "/",
    );
    if (body?.healthy === true) {
      return {
        name: "health",
        status: "pass",
        detail: `${body.runtime ?? "unknown"} runtime is healthy`,
      };
    }
    return {
      name: "health",
      status: "fail",
      detail: `unexpected health response: ${JSON.stringify(body)}`,
    };
  } catch (err) {
    return {
      name: "health",
      status: "fail",
      detail: (err as Error).message,
      remediation: "Confirm the worker is deployed and the URL is reachable.",
    };
  }
}

async function checkAgentCard(
  endpoint: string,
): Promise<{ health: CheckResult; security: CheckResult }> {
  try {
    const { body } = await httpGet<{
      protocolVersion?: string;
      securitySchemes?: Record<string, unknown>;
    }>(endpoint, "/.well-known/agent-card.json");
    const versionOk = body?.protocolVersion === "v1";
    const health: CheckResult = versionOk
      ? {
          name: "agent-card",
          status: "pass",
          detail: "protocolVersion=v1",
        }
      : {
          name: "agent-card",
          status: "fail",
          detail: `unexpected protocolVersion: ${body?.protocolVersion ?? "<missing>"}`,
          remediation:
            "Upgrade runtime-cloudflare to a version matching this CLI.",
        };

    const hasBearer =
      body?.securitySchemes &&
      typeof body.securitySchemes === "object" &&
      "bearer" in body.securitySchemes;
    const security: CheckResult = hasBearer
      ? {
          name: "security-schemes",
          status: "pass",
          detail: "bearer auth advertised",
        }
      : {
          name: "security-schemes",
          status: "fail",
          detail: "AgentCard does not advertise bearer auth — worker is OPEN",
          remediation:
            "Set `auth: { bearer: env.MERIDIAN_ADMIN_TOKEN }` in createMeridianWorker(), then redeploy.",
        };

    return { health, security };
  } catch (err) {
    const failed: CheckResult = {
      name: "agent-card",
      status: "fail",
      detail: (err as Error).message,
    };
    return {
      health: failed,
      security: { ...failed, name: "security-schemes" },
    };
  }
}

async function checkAdminAuth(
  endpoint: string,
  token: string,
): Promise<CheckResult> {
  try {
    await httpGet(endpoint, "/admin/domains", { token });
    return {
      name: "admin-auth",
      status: "pass",
      detail: "bearer token accepted by /admin/domains",
    };
  } catch (err) {
    if (err instanceof CliHttpError && err.status === 401) {
      return {
        name: "admin-auth",
        status: "fail",
        detail: `token rejected: ${err.code ?? err.status} ${err.message}`,
        remediation:
          "Confirm the deployed MERIDIAN_ADMIN_TOKEN matches your local token.",
      };
    }
    return {
      name: "admin-auth",
      status: "fail",
      detail: (err as Error).message,
    };
  }
}
