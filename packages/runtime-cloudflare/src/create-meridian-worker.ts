/**
 * createMeridianWorker — M3a adopter HTTP entrypoint.
 *
 * Returns an `ExportedHandler` that adopters put on their Worker's
 * default export. Exposes a minimal REST surface for driving agents
 * from outside the Worker isolate:
 *
 *     GET    /                              → health
 *     GET    /.well-known/agent-card.json   → A2A-shaped discovery
 *     POST   /agents/:id/spawn              → spawn
 *     GET    /agents/:id                    → get handle
 *     DELETE /agents/:id                    → terminate
 *     POST   /agents/:id/messages           → send (to another agent)
 *     POST   /agents/:id/broadcast          → broadcast
 *     GET    /agents/:id/inbox              → inbox snapshot
 *     POST   /agents/:id/inbox/drain        → inbox pull-and-clear
 *
 * Every route delegates to `env.AGENT` DO RPCs — no work happens in
 * the Worker itself beyond request parsing and response shaping.
 *
 * **No auth in v0.1.** Adopters MUST NOT expose this worker publicly
 * without M4's bearer auth. Mitigations for pre-M4 deploys:
 *   • Restrict via Cloudflare Access / IP allowlist at the edge
 *   • Keep the worker URL private (`workers.dev` subdomain + no
 *     DNS record)
 *   • Use the `routes` escape hatch to wrap routes with your own
 *     auth check before M4 lands
 *
 * **Payload encoding.** Message payloads are `Uint8Array` on the wire
 * protocol side; the HTTP surface uses **base64** strings for JSON
 * compatibility (request body + inbox response). Clients encode
 * outbound payloads with `btoa()` / node Buffer, decode inbound with
 * `atob()` / Buffer.from(..., "base64"). See the `docker-kafka`
 * example (M3c) for the pattern.
 */

import type {
  AgentHandle,
  AgentId,
  AgentSelector,
  BroadcastReceipt,
  DomainId,
  IncomingMessage,
  MessageReceipt,
  SpawnConfig,
} from "@loom-loyalty/meridian-types";

import type { AgentDurableObject, AgentEnv } from "./agent-do.js";
import type { AgentSpec } from "./define-agent.js";
import { defineAgent } from "./define-agent.js";
import type { RuntimeError } from "@loom-loyalty/meridian-types";

import {
  isMeridianError,
  lookupMeridianCode,
  MERIDIAN_ERROR_CODE_RE,
} from "./errors.js";

/** Handler for a custom route injected via `config.routes`. */
export type MeridianRouteHandler = (
  req: Request,
  env: AgentEnv,
  ctx: ExecutionContext,
) => Promise<Response> | Response;

export interface MeridianWorkerConfig {
  agents: AgentSpec[];
  /**
   * Optional custom HTTP routes, keyed by `"METHOD /path"`
   * (e.g. `"GET /conformance"`). Checked before the built-in routes,
   * so adopters can shadow built-ins if needed. Mostly used to add
   * adopter-specific monitoring / admin endpoints before M4 ships
   * official admin routes.
   */
  routes?: Record<string, MeridianRouteHandler>;
  /**
   * Optional metadata surfaced via `/.well-known/agent-card.json`.
   * Defaults are applied when fields are omitted.
   */
  agentCard?: {
    name?: string;
    description?: string;
    version?: string;
  };
}

// Maps MRD-CF-* error categories (from MeridianError.category) to HTTP status
// codes. Anything unmapped falls through to 500.
const CATEGORY_TO_STATUS: Record<string, number> = {
  invalid_argument: 400,
  not_found: 404,
  already_exists: 409,
  permission_denied: 403,
  resource_exhausted: 429,
  unavailable: 503,
  internal: 500,
  cancelled: 499,
  deadline_exceeded: 504,
  failed_precondition: 412,
  aborted: 409,
  out_of_range: 400,
  unauthenticated: 401,
};

export function createMeridianWorker(
  config: MeridianWorkerConfig,
): ExportedHandler<AgentEnv> {
  // Re-register any agents passed in the config. Idempotent against
  // prior `defineAgent()` calls in the adopter's module (re-registering
  // the same spec is a no-op; this just ensures the registry is
  // populated by worker-entry time even if the module ordering in the
  // adopter's build hasn't evaluated their `defineAgent` calls yet).
  for (const agent of config.agents) {
    defineAgent(agent);
  }

  return {
    async fetch(
      req: Request,
      env: AgentEnv,
      ctx: ExecutionContext,
    ): Promise<Response> {
      const url = new URL(req.url);
      const routeKey = `${req.method} ${url.pathname}`;

      // 1. Custom routes take precedence so adopters can shadow
      //    built-ins or inject admin / monitoring paths.
      const customHandler = config.routes?.[routeKey];
      if (customHandler) {
        try {
          return await customHandler(req, env, ctx);
        } catch (err) {
          return errorResponse(err);
        }
      }

      try {
        // 2. Built-in routes.
        if (req.method === "GET" && url.pathname === "/") {
          return healthResponse();
        }
        if (
          req.method === "GET" &&
          url.pathname === "/.well-known/agent-card.json"
        ) {
          return agentCardResponse(url, config);
        }

        const agentMatch = url.pathname.match(/^\/agents\/([^/]+)(\/.*)?$/);
        if (agentMatch) {
          const agentId = decodeURIComponent(agentMatch[1]!);
          const subPath = agentMatch[2] ?? "";
          return await handleAgentRoute(req, env, agentId, subPath);
        }
      } catch (err) {
        return errorResponse(err);
      }

      return jsonResponse(
        { error: { message: `Route not found: ${routeKey}` } },
        { status: 404 },
      );
    },
  };
}

// ── built-ins ───────────────────────────────────────────────

function healthResponse(): Response {
  return jsonResponse({
    runtime: "meridian-cloudflare",
    healthy: true,
  });
}

function agentCardResponse(url: URL, config: MeridianWorkerConfig): Response {
  const baseUrl = `${url.protocol}//${url.host}`;
  // AgentCard shape follows the A2A convention at a high level. v0.1
  // ships without securitySchemes; M4 adds bearer + OIDC schemes here
  // when the AuthPlugin interface stabilizes.
  const card = {
    protocolVersion: "v1",
    name: config.agentCard?.name ?? "meridian-worker",
    description:
      config.agentCard?.description ??
      "Meridian runtime on Cloudflare Workers + Durable Objects",
    version: config.agentCard?.version ?? "0.1.0",
    transports: {
      http: { url: baseUrl },
    },
    agents: config.agents.map((a) => ({
      id: a.id,
      domain: a.domain,
    })),
    securitySchemes: {},
  };
  return jsonResponse(card);
}

async function handleAgentRoute(
  req: Request,
  env: AgentEnv,
  agentId: AgentId,
  subPath: string,
): Promise<Response> {
  const stub = env.AGENT.get(
    env.AGENT.idFromName(agentId),
  ) as unknown as DurableObjectStub<AgentDurableObject>;

  // /agents/:id
  if (subPath === "" || subPath === "/") {
    if (req.method === "GET") {
      const handle = await stub.get();
      return jsonResponse(handle);
    }
    if (req.method === "DELETE") {
      await stub.terminate();
      return new Response(null, { status: 204 });
    }
    return methodNotAllowed(["GET", "DELETE"]);
  }

  // /agents/:id/spawn
  if (subPath === "/spawn") {
    if (req.method !== "POST") return methodNotAllowed(["POST"]);
    const body = (await req.json().catch(() => null)) as
      | (Partial<SpawnConfig> & { domain?: DomainId })
      | null;
    if (!body || !body.domain) {
      return badRequest("spawn body requires `domain` field");
    }
    const handle: AgentHandle = await stub.spawn({
      id: agentId,
      domain: body.domain,
    });
    return jsonResponse(handle, { status: 201 });
  }

  // /agents/:id/messages — send
  if (subPath === "/messages") {
    if (req.method !== "POST") return methodNotAllowed(["POST"]);
    const body = (await req.json().catch(() => null)) as {
      to?: AgentId;
      payload?: string;
    } | null;
    if (!body || !body.to || typeof body.payload !== "string") {
      return badRequest(
        "messages body requires `to` (agent id) and `payload` (base64 string)",
      );
    }
    const payload = base64ToBytes(body.payload);
    if (!payload) return badRequest("`payload` is not valid base64");
    const receipt: MessageReceipt = await stub.send(body.to, payload);
    return jsonResponse(receipt, { status: 202 });
  }

  // /agents/:id/broadcast
  if (subPath === "/broadcast") {
    if (req.method !== "POST") return methodNotAllowed(["POST"]);
    const body = (await req.json().catch(() => null)) as {
      selector?: AgentSelector;
      payload?: string;
    } | null;
    if (!body || typeof body.payload !== "string") {
      return badRequest(
        "broadcast body requires `payload` (base64 string); `selector` optional",
      );
    }
    const payload = base64ToBytes(body.payload);
    if (!payload) return badRequest("`payload` is not valid base64");
    const receipt: BroadcastReceipt = await stub.broadcast(
      body.selector ?? {},
      payload,
    );
    return jsonResponse(receipt, { status: 202 });
  }

  // /agents/:id/inbox — snapshot (GET) or drain (POST /inbox/drain)
  if (subPath === "/inbox") {
    if (req.method !== "GET") return methodNotAllowed(["GET"]);
    const messages = await stub.receiveAll();
    return jsonResponse({ messages: messages.map(encodeInboxMessage) });
  }
  if (subPath === "/inbox/drain") {
    if (req.method !== "POST") return methodNotAllowed(["POST"]);
    const messages = await stub.drainInbox();
    return jsonResponse({ messages: messages.map(encodeInboxMessage) });
  }

  return jsonResponse(
    { error: { message: `Unknown agent subpath: ${subPath}` } },
    { status: 404 },
  );
}

// ── helpers ─────────────────────────────────────────────────

function encodeInboxMessage(
  m: IncomingMessage,
): Omit<IncomingMessage, "payload"> & { payload: string } {
  return {
    ...m,
    payload: bytesToBase64(m.payload),
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function badRequest(message: string): Response {
  return jsonResponse(
    { error: { code: "invalid_argument", message } },
    {
      status: 400,
    },
  );
}

function methodNotAllowed(allowed: string[]): Response {
  return jsonResponse(
    { error: { code: "invalid_argument", message: "Method not allowed" } },
    {
      status: 405,
      headers: { allow: allowed.join(", ") },
    },
  );
}

function errorResponse(err: unknown): Response {
  // When a MeridianError comes through the DO RPC boundary, it loses
  // its `RuntimeError` class identity (Cloudflare's structured clone
  // reconstructs errors as plain `Error` with message + stack, but
  // no subclass info). `isMeridianError` relies on `instanceof
  // RuntimeError`, so it returns false on the caller side. We need
  // a message-based fallback: every meridianError()-minted throw
  // prefixes its message with `[MRD-CF-XX-NNN]`. Parse that out and
  // map to the category / HTTP status via the local catalog.
  if (isMeridianError(err)) {
    return meridianErrorResponseFromInstance(err);
  }
  const e = err as Error;
  const fromMessage = parseMeridianErrorFromMessage(e?.message);
  if (fromMessage) {
    const status = CATEGORY_TO_STATUS[fromMessage.category] ?? 500;
    return jsonResponse(
      {
        error: {
          code: fromMessage.code,
          category: fromMessage.category,
          message: e.message,
          retryable: fromMessage.retryable,
          docUrl: `https://meridian.dev/errors/${fromMessage.code}`,
        },
      },
      { status },
    );
  }
  return jsonResponse(
    { error: { code: "internal", message: e?.message ?? String(err) } },
    { status: 500 },
  );
}

function meridianErrorResponseFromInstance(err: RuntimeError): Response {
  const status = CATEGORY_TO_STATUS[err.category] ?? 500;
  const ctx = (err.context ?? {}) as Record<string, unknown>;
  return jsonResponse(
    {
      error: {
        code: ctx.code as string | undefined,
        category: err.category,
        message: err.message,
        retryable: err.retryable,
        docUrl: ctx.docUrl as string | undefined,
        context: ctx,
      },
    },
    { status },
  );
}

function parseMeridianErrorFromMessage(
  message: string | undefined,
): ReturnType<typeof lookupMeridianCode> {
  if (!message) return null;
  const match = message.match(MERIDIAN_ERROR_CODE_RE);
  if (!match) return null;
  return lookupMeridianCode(match[1]!);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToBytes(s: string): Uint8Array | null {
  try {
    const binary = atob(s);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}
