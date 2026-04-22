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
 *     GET    /admin/domains                 → list agents by domain
 *     GET    /admin/agents/:id              → unified inspect
 *
 * Every route delegates to `env.AGENT` / `env.REGISTRY` DO RPCs — no
 * work happens in the Worker itself beyond request parsing and
 * response shaping.
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
import type { RegistryDurableObject } from "./registry-do.js";
import type { RuntimeError } from "@loom-loyalty/meridian-types";

import { enforceBearer, type AuthConfig } from "./auth.js";
import {
  isMeridianError,
  lookupMeridianCode,
  MERIDIAN_ERROR_CODE_RE,
} from "./errors.js";
import {
  resolveTenantContext,
  scopedAgentName,
  scopedRegistryKey,
  type TenancyConfig,
  type TenantContext,
} from "./tenancy.js";

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
   *
   * Custom routes are NOT auth-gated by the helper — if `auth` is
   * configured and a custom route must be authenticated, the adopter
   * calls `enforceBearer(req, config.auth)` at the top of their
   * handler. Keeping it explicit means public custom routes (e.g.
   * a `/conformance` health probe) work without reconfiguration.
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
  /**
   * Optional shared-secret bearer auth. When set, every mutation
   * route (`POST /agents/:id/spawn`, `DELETE /agents/:id`,
   * `POST /agents/:id/messages`, `POST /agents/:id/broadcast`,
   * `POST /agents/:id/inbox/drain`) requires
   * `Authorization: Bearer <token>`. Discovery reads (`GET /`,
   * `GET /.well-known/agent-card.json`) and inbox reads (`GET
   * /agents/:id`, `GET /agents/:id/inbox`) stay open for health
   * checks and polling.
   *
   * Typical adopter pattern:
   *
   *     // wrangler secret put MERIDIAN_ADMIN_TOKEN
   *     createMeridianWorker({
   *       agents: [...],
   *       auth: { bearer: env.MERIDIAN_ADMIN_TOKEN },
   *     })
   *
   * When `auth.bearer` is falsy, auth is disabled (same as omitting
   * the field). AgentCard `securitySchemes` reflects the enabled
   * scheme so A2A-aware clients discover it.
   *
   * v0.1 ships shared-secret only. OIDC / OAuth2 / custom AuthPlugin
   * arrive in v0.1.5.
   */
  auth?: AuthConfig;
  /**
   * Opt-in multi-tenancy. When set, every incoming request is mapped
   * to a `tenantId` via the adopter-supplied `TenantAuthorizer`, and
   * the runtime scopes DO names, registry shards, and analytics
   * dimensions per tenant so two agents with the same id under
   * different tenants stay isolated.
   *
   * When `tenancy` is undefined (default), the worker runs
   * single-tenant — the pre-M6 behavior. Existing deploys upgrading
   * from M5 see no change to their DO addresses or state keys.
   *
   * See `../README.md#tenancy` for the full invariant list (data
   * isolation at the DO layer, cross-tenant address rejection,
   * admin-route scoping, analytics tagging).
   */
  tenancy?: TenancyConfig;
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
          // Mutation routes (every non-GET in /agents/*) require
          // bearer auth when configured. Reads (GET /agents/:id,
          // GET /agents/:id/inbox) stay open — same policy as the
          // AgentCard discovery endpoint.
          if (req.method !== "GET") {
            enforceBearer(req, config.auth);
          }
          // Resolve tenant context AFTER bearer check: bearer
          // validates the token is well-formed; the authorizer then
          // maps the authenticated request to its tenant. When
          // tenancy is off, this returns the SINGLE_TENANT_CONTEXT
          // stub and DO naming stays unchanged.
          const tenant = await resolveTenantContext(req, config.tenancy);
          return await handleAgentRoute(req, env, agentId, subPath, tenant);
        }

        // /admin/* routes — EVERY method gated by bearer auth when
        // configured, including reads. These expose operational data
        // (state keys, usage rollups, full agent list) that adopters
        // don't want enumerable without a token. `GET /admin/domains`
        // and `GET /admin/agents/:id` land here.
        if (url.pathname.startsWith("/admin/")) {
          enforceBearer(req, config.auth);
          const tenant = await resolveTenantContext(req, config.tenancy);
          return await handleAdminRoute(req, env, url, tenant);
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
  // AgentCard shape follows the A2A convention at a high level.
  // `securitySchemes` reflects the auth configured on the worker so
  // A2A-aware clients can discover the required scheme without a
  // separate probe. When `auth.bearer` is set, we advertise the
  // http-bearer scheme; otherwise the object stays empty (explicitly
  // signalling an open worker — adopters who forgot to configure
  // auth see this in their deployment smoke check).
  const securitySchemes: Record<string, unknown> = {};
  if (config.auth?.bearer) {
    securitySchemes["bearer"] = {
      type: "http",
      scheme: "bearer",
      description:
        "Shared-secret bearer token. Send `Authorization: Bearer <MERIDIAN_ADMIN_TOKEN>` on all mutation routes.",
    };
  }
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
    securitySchemes,
  };
  return jsonResponse(card);
}

async function handleAgentRoute(
  req: Request,
  env: AgentEnv,
  agentId: AgentId,
  subPath: string,
  tenant: TenantContext,
): Promise<Response> {
  // `scopedAgentName` returns the raw agentId in single-tenant mode
  // so existing DO addresses stay unchanged. Multi-tenant mode
  // prefixes with tenantId so two tenants' same-named agents hash
  // to different DOs.
  const stub = env.AGENT.get(
    env.AGENT.idFromName(scopedAgentName(agentId, tenant)),
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
    // Force the authorizer-resolved tenantId onto the spawn — the
    // adopter cannot spoof a tenant via the request body. Single-
    // tenant deploys pass undefined here, preserving pre-M6 meta
    // shape for existing DOs.
    const spawnConfig: SpawnConfig = {
      id: agentId,
      domain: body.domain,
    };
    if (tenant.enabled) {
      spawnConfig.tenantId = tenant.tenantId;
    }
    const handle: AgentHandle = await stub.spawn(spawnConfig);
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

// ── admin routes ────────────────────────────────────────────
//
// Operational surface for adopters / the `meridian-cli`. Read-only in
// v0.1 — no agent mutations land here (spawn / terminate stay on the
// `/agents/*` surface). Every route is bearer-gated by the dispatcher
// above, including GETs, because the shape of the data (full agent
// list, state key enumeration, usage rollups) is sensitive enough to
// not be enumerable without a token.
//
// v0.1 GA:
//   GET /admin/domains           → { domains: [{ domain, agentIds }] }
//   GET /admin/agents/:id        → unified inspect: handle +
//                                   schedules + usage + stateKeys +
//                                   inboxLength
//
// Experimental surface (tail, queue, etc.) lands in M4c behind
// `--experimental`. Shape there may shift across v0.1.x.

async function handleAdminRoute(
  req: Request,
  env: AgentEnv,
  url: URL,
  tenant: TenantContext,
): Promise<Response> {
  // /admin/domains — list registered agents grouped by domain,
  // tenant-scoped. Multi-tenant worker → only the caller's agents.
  if (url.pathname === "/admin/domains") {
    if (req.method !== "GET") return methodNotAllowed(["GET"]);
    return handleAdminDomains(env, tenant);
  }

  // /admin/agents/:id — inspect one agent within the caller's
  // tenant. Cross-tenant access returns MRD-CF-LC-002 (not_found)
  // because the agent simply doesn't exist under this tenant's DO.
  const inspectMatch = url.pathname.match(/^\/admin\/agents\/([^/]+)$/);
  if (inspectMatch) {
    if (req.method !== "GET") return methodNotAllowed(["GET"]);
    const agentId = decodeURIComponent(inspectMatch[1]!);
    return handleAdminInspect(env, agentId, tenant);
  }

  return jsonResponse(
    { error: { message: `Unknown admin path: ${url.pathname}` } },
    { status: 404 },
  );
}

async function handleAdminDomains(
  env: AgentEnv,
  tenant: TenantContext,
): Promise<Response> {
  // Registry shard keyed per-tenant when tenancy is on. Because the
  // registry DO IS the tenant, `list()` here can only ever return
  // agents registered under the caller's tenant — cross-tenant
  // enumeration is impossible by construction.
  const registry = env.REGISTRY.get(
    env.REGISTRY.idFromName(scopedRegistryKey(tenant)),
  ) as unknown as DurableObjectStub<RegistryDurableObject>;
  const entries = await registry.list();

  // Group entries by domain and sort both the domains and their
  // agentIds so the response is deterministic (nice for cache
  // keys + test assertions).
  const byDomain = new Map<DomainId, AgentId[]>();
  for (const entry of entries) {
    const bucket = byDomain.get(entry.domain) ?? [];
    bucket.push(entry.id);
    byDomain.set(entry.domain, bucket);
  }
  const domains = Array.from(byDomain.entries())
    .map(([domain, agentIds]) => ({
      domain,
      agentIds: [...agentIds].sort(),
    }))
    .sort((a, b) => a.domain.localeCompare(b.domain));

  return jsonResponse({ domains });
}

async function handleAdminInspect(
  env: AgentEnv,
  agentId: AgentId,
  tenant: TenantContext,
): Promise<Response> {
  // Scope target DO by caller's tenant. If agent id "X" exists
  // under tenant A and B, the admin caller sees only their tenant's
  // "X"; calling across tenants naturally returns 404.
  const stub = env.AGENT.get(
    env.AGENT.idFromName(scopedAgentName(agentId, tenant)),
  ) as unknown as DurableObjectStub<AgentDurableObject>;

  // Pull everything in parallel. `stub.get()` throws MRD-CF-LC-002
  // when the agent has never been spawned on this DO; that error
  // propagates through `errorResponse()` to a 404 with the stable
  // MRD code — which is exactly the shape adopters need.
  //
  // Every other call gates on `requireMeta()` internally so a
  // pre-spawn inspect fails fast on the handle fetch and the rest
  // never run. Running them in parallel still works because
  // `Promise.all` rejects on the first throw.
  const [handle, schedules, usage, stateList, inbox] = await Promise.all([
    stub.get(),
    stub.listSchedules(),
    stub.getUsage(),
    stub.list({ prefix: "" }),
    stub.receiveAll(),
  ]);

  return jsonResponse({
    agent: handle,
    schedules,
    usage,
    state: {
      keys: stateList.keys,
      cursor: stateList.cursor,
    },
    inbox: {
      length: inbox.length,
    },
  });
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
          docUrl: `https://meridianprotocol.dev/errors/${fromMessage.code}`,
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
