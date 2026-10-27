/**
 * `onRequest` hook + custom-route tenant context.
 *
 * The hook is the adopter seam for per-tenant quotas, metering and
 * audit: it sees the resolved tenant and a classified route before
 * dispatch, can short-circuit, and can observe or replace the
 * response afterwards (errors already mapped to HTTP status).
 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import {
  createMeridianWorker,
  type MeridianRequestInfo,
  type MeridianWorkerConfig,
  type TenantAuthorizer,
} from "../src/index.js";
import { defineAgent } from "../src/define-agent.js";

const stubCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

class HeaderTenantAuthorizer implements TenantAuthorizer {
  resolveTenantId(req: Request): string {
    const t = req.headers.get("x-tenant");
    if (!t) throw new Error("missing x-tenant header");
    return t;
  }
}

beforeAll(() => {
  defineAgent({ id: "hk-a", domain: "demo" });
  defineAgent({ id: "hk-b", domain: "demo" });
});

function worker(extra: Partial<MeridianWorkerConfig>) {
  return createMeridianWorker({
    agents: [
      { id: "hk-a", domain: "demo" },
      { id: "hk-b", domain: "demo" },
    ],
    tenancy: { authorizer: new HeaderTenantAuthorizer() },
    ...extra,
  });
}

async function call(
  w: ReturnType<typeof worker>,
  method: string,
  path: string,
  opts: { tenant?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.tenant) headers["x-tenant"] = opts.tenant;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await w.fetch!(
    new Request(`https://example.com${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
    env,
    stubCtx,
  );
  return {
    status: res.status,
    body: (await res.json().catch(() => null)) as unknown,
  };
}

describe("onRequest", () => {
  it("classifies every built-in route with the resolved tenant", async () => {
    const seen: Array<Pick<MeridianRequestInfo, "route"> & { tenant: string }> =
      [];
    const w = worker({
      onRequest: ({ tenant, route }) => {
        seen.push({ tenant: tenant.tenantId, route });
      },
    });
    const t = { tenant: "hk-t1" };
    await call(w, "POST", "/agents/hk-a/spawn", {
      ...t,
      body: { domain: "demo" },
    });
    await call(w, "POST", "/agents/hk-b/spawn", {
      ...t,
      body: { domain: "demo" },
    });
    await call(w, "GET", "/agents/hk-a", t);
    await call(w, "POST", "/agents/hk-a/messages", {
      ...t,
      body: { to: "hk-b", payload: btoa("hi") },
    });
    await call(w, "POST", "/agents/hk-a/broadcast", {
      ...t,
      body: { payload: btoa("x") },
    });
    await call(w, "GET", "/agents/hk-b/inbox", t);
    await call(w, "POST", "/agents/hk-b/inbox/drain", t);
    await call(w, "PUT", "/agents/hk-a/spawn", t);
    await call(w, "GET", "/admin/domains", t);
    await call(w, "GET", "/admin/agents/hk-a", t);
    await call(w, "GET", "/admin/nope", t);
    await call(w, "DELETE", "/agents/hk-a", t);

    expect(seen.every((s) => s.tenant === "hk-t1")).toBe(true);
    expect(seen.map((s) => s.route)).toEqual([
      { kind: "agent", agentId: "hk-a", action: "spawn" },
      { kind: "agent", agentId: "hk-b", action: "spawn" },
      { kind: "agent", agentId: "hk-a", action: "get" },
      { kind: "agent", agentId: "hk-a", action: "send" },
      { kind: "agent", agentId: "hk-a", action: "broadcast" },
      { kind: "agent", agentId: "hk-b", action: "inbox" },
      { kind: "agent", agentId: "hk-b", action: "inbox-drain" },
      { kind: "agent", agentId: "hk-a", action: "unknown" },
      { kind: "admin", action: "domains" },
      { kind: "admin", action: "inspect", agentId: "hk-a" },
      { kind: "admin", action: "unknown" },
      { kind: "agent", agentId: "hk-a", action: "terminate" },
    ]);
  });

  it("short-circuits with a returned Response (built-in route never runs)", async () => {
    const w = worker({
      onRequest: ({ route }) =>
        route.kind === "agent" && route.action === "spawn"
          ? Response.json({ error: "quota" }, { status: 429 })
          : undefined,
    });
    const denied = await call(w, "POST", "/agents/hk-a/spawn", {
      tenant: "hk-t2",
      body: { domain: "demo" },
    });
    expect(denied).toEqual({ status: 429, body: { error: "quota" } });
    // Not spawned: the DO never saw the request.
    const get = await call(w, "GET", "/agents/hk-a", { tenant: "hk-t2" });
    expect(get.status).toBe(404);
  });

  it("onResponse sees mapped error statuses and can replace the response", async () => {
    const statuses: number[] = [];
    const w = worker({
      onRequest: () => ({
        onResponse(res) {
          statuses.push(res.status);
          if (res.status === 404)
            return Response.json({ replaced: true }, { status: 410 });
        },
      }),
    });
    // Unspawned agent → MRD-CF-LC-002 → 404, replaced with 410.
    const res = await call(w, "GET", "/agents/hk-a", { tenant: "hk-t3" });
    expect(res).toEqual({ status: 410, body: { replaced: true } });
    const ok = await call(w, "POST", "/agents/hk-a/spawn", {
      tenant: "hk-t3",
      body: { domain: "demo" },
    });
    expect(ok.status).toBe(201);
    expect(statuses).toEqual([404, 201]);
  });

  it("does not run when the authorizer rejects, or for health / custom routes", async () => {
    let calls = 0;
    const w = worker({
      onRequest: () => {
        calls++;
      },
      routes: { "GET /ping": () => new Response("pong") },
    });
    expect((await call(w, "GET", "/agents/hk-a")).status).toBe(500);
    await call(w, "GET", "/");
    const ping = await w.fetch!(
      new Request("https://example.com/ping"),
      env,
      stubCtx,
    );
    expect(await ping.text()).toBe("pong");
    expect(calls).toBe(0);
  });

  it("a thrown MeridianError maps to its HTTP status", async () => {
    const { meridianError } = await import("../src/errors.js");
    const w = worker({
      onRequest: () => {
        throw meridianError("MRD-CF-AU-002");
      },
    });
    const res = await call(w, "GET", "/agents/hk-a", { tenant: "hk-t4" });
    expect(res.status).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      "MRD-CF-AU-002",
    );
  });
});

describe("custom routes: meridian.tenant()", () => {
  it("resolves the tenant lazily and only once", async () => {
    let resolutions = 0;
    const w = createMeridianWorker({
      agents: [],
      tenancy: {
        authorizer: {
          resolveTenantId(req) {
            resolutions++;
            return req.headers.get("x-tenant") ?? "anon";
          },
        },
      },
      routes: {
        "GET /whoami": async (_req, _env, _ctx, meridian) => {
          const a = await meridian.tenant();
          const b = await meridian.tenant();
          return Response.json({ a: a.tenantId, same: a === b });
        },
        "GET /public": () => new Response("ok"),
      },
    });
    const who = await w.fetch!(
      new Request("https://example.com/whoami", {
        headers: { "x-tenant": "hk-t5" },
      }),
      env,
      stubCtx,
    );
    expect(await who.json()).toEqual({ a: "hk-t5", same: true });
    expect(resolutions).toBe(1);
    await w.fetch!(new Request("https://example.com/public"), env, stubCtx);
    expect(resolutions).toBe(1);
  });

  it("maps an authorizer rejection inside a custom route to an error response", async () => {
    const w = worker({
      routes: {
        "GET /mine": async (_r, _e, _c, meridian) =>
          Response.json(await meridian.tenant()),
      },
    });
    const res = await w.fetch!(
      new Request("https://example.com/mine"),
      env,
      stubCtx,
    );
    expect(res.status).toBe(500);
  });
});
