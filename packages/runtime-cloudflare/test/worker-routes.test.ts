/**
 * M3a `createMeridianWorker` HTTP surface tests.
 *
 * Exercises the adopter-facing REST API by invoking the Worker's
 * fetch handler directly with synthetic `Request` objects. Miniflare
 * boots the DOs the routes delegate to, so every response reflects
 * real primitive behavior.
 *
 * Auth coverage: v0.1 has no auth. Tests assert the current "no
 * auth enforcement" state explicitly so the contract is pinned —
 * when M4 lands, the corresponding auth-enforcement tests replace
 * these assertions without silently shifting behavior.
 */

import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";

import { createMeridianWorker } from "../src/create-meridian-worker.js";
import { defineAgent } from "../src/define-agent.js";

// The worker handler is environment-bound at construction time. The
// `env` we get from `cloudflare:test` already has AGENT + REGISTRY
// wired, so we can spin up a handler that treats it as its env.
// `ExecutionContext` isn't actually used by any built-in route, so
// we pass a minimal stub.
const stubCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

// A tiny agent spec for broadcast targeting + message routing tests.
beforeAll(() => {
  defineAgent({ id: "wk-demo-a", domain: "demo" });
  defineAgent({ id: "wk-demo-b", domain: "demo" });
  defineAgent({ id: "wk-demo-other", domain: "other" });
});

function makeWorker(opts?: Parameters<typeof createMeridianWorker>[0]) {
  return createMeridianWorker(
    opts ?? {
      agents: [
        { id: "wk-demo-a", domain: "demo" },
        { id: "wk-demo-b", domain: "demo" },
        { id: "wk-demo-other", domain: "other" },
      ],
    },
  );
}

async function call(
  worker: ReturnType<typeof makeWorker>,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const req = new Request(`https://example.com${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await worker.fetch!(req, env, stubCtx);
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    // keep raw text
  }
  return { status: res.status, body: parsed };
}

describe("createMeridianWorker", () => {
  it("GET / returns healthy", async () => {
    const worker = makeWorker();
    const res = await call(worker, "GET", "/");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      runtime: "meridian-cloudflare",
      healthy: true,
    });
  });

  it("GET /.well-known/agent-card.json returns discovery card", async () => {
    const worker = makeWorker({
      agents: [{ id: "wk-card-a", domain: "demo" }],
      agentCard: {
        name: "test-worker",
        description: "A test worker",
        version: "0.0.1",
      },
    });
    const res = await call(worker, "GET", "/.well-known/agent-card.json");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      protocolVersion: "v1",
      name: "test-worker",
      description: "A test worker",
      version: "0.0.1",
      agents: [{ id: "wk-card-a", domain: "demo" }],
      securitySchemes: {},
    });
    // transports.http.url should be derived from the request URL.
    const card = res.body as { transports: { http: { url: string } } };
    expect(card.transports.http.url).toBe("https://example.com");
  });

  it("POST /agents/:id/spawn creates the agent and returns AgentHandle", async () => {
    const worker = makeWorker();
    const res = await call(worker, "POST", "/agents/wk-demo-a/spawn", {
      domain: "demo",
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: "wk-demo-a",
      domain: "demo",
      status: "running",
    });

    // Cleanup via DELETE.
    const del = await call(worker, "DELETE", "/agents/wk-demo-a");
    expect(del.status).toBe(204);
  });

  it("POST spawn without `domain` returns 400", async () => {
    const worker = makeWorker();
    const res = await call(worker, "POST", "/agents/wk-no-domain/spawn", {});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: { code: "invalid_argument" },
    });
  });

  it("POST spawn with different domain on existing agent → 409 + MRD-CF-LC-001", async () => {
    const worker = makeWorker();
    // First spawn succeeds.
    await call(worker, "POST", "/agents/wk-conflict/spawn", {
      domain: "demo",
    });
    // Second spawn with different domain rejects with LC-001 (already_exists → 409).
    const res = await call(worker, "POST", "/agents/wk-conflict/spawn", {
      domain: "other",
    });
    expect(res.status).toBe(409);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe("MRD-CF-LC-001");

    await call(worker, "DELETE", "/agents/wk-conflict");
  });

  it("GET /agents/:id returns the handle; 404-category when not spawned", async () => {
    const worker = makeWorker();
    // Unspawned agent → MRD-CF-LC-002 (not_found → 404).
    const miss = await call(worker, "GET", "/agents/wk-unspawned");
    expect(miss.status).toBe(404);
    const body = miss.body as { error: { code: string } };
    expect(body.error.code).toBe("MRD-CF-LC-002");

    // Spawn then GET.
    await call(worker, "POST", "/agents/wk-handle/spawn", { domain: "demo" });
    const hit = await call(worker, "GET", "/agents/wk-handle");
    expect(hit.status).toBe(200);
    expect(hit.body).toMatchObject({ id: "wk-handle", domain: "demo" });

    await call(worker, "DELETE", "/agents/wk-handle");
  });

  it("POST /agents/:id/messages sends; payload base64 round-trips via inbox", async () => {
    const worker = makeWorker();
    await call(worker, "POST", "/agents/wk-msg-a/spawn", { domain: "demo" });
    await call(worker, "POST", "/agents/wk-msg-b/spawn", { domain: "demo" });

    const payloadText = "hello from http";
    const payloadB64 = btoa(payloadText);

    const send = await call(worker, "POST", "/agents/wk-msg-a/messages", {
      to: "wk-msg-b",
      payload: payloadB64,
    });
    expect(send.status).toBe(202);
    expect(send.body).toMatchObject({ messageId: expect.any(String) });

    // Recipient inbox should have the message with base64-encoded payload.
    const inbox = await call(worker, "GET", "/agents/wk-msg-b/inbox");
    expect(inbox.status).toBe(200);
    const messages = (
      inbox.body as {
        messages: Array<{ payload: string; fromAgentId: string }>;
      }
    ).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.fromAgentId).toBe("wk-msg-a");
    expect(atob(messages[0]!.payload)).toBe(payloadText);

    // Drain clears the inbox.
    const drain = await call(worker, "POST", "/agents/wk-msg-b/inbox/drain");
    expect(drain.status).toBe(200);
    expect((drain.body as { messages: unknown[] }).messages).toHaveLength(1);
    const after = await call(worker, "GET", "/agents/wk-msg-b/inbox");
    expect((after.body as { messages: unknown[] }).messages).toHaveLength(0);

    await call(worker, "DELETE", "/agents/wk-msg-a");
    await call(worker, "DELETE", "/agents/wk-msg-b");
  });

  it("POST /agents/:id/messages with non-base64 payload returns 400", async () => {
    const worker = makeWorker();
    await call(worker, "POST", "/agents/wk-bad-a/spawn", { domain: "demo" });
    await call(worker, "POST", "/agents/wk-bad-b/spawn", { domain: "demo" });

    const res = await call(worker, "POST", "/agents/wk-bad-a/messages", {
      to: "wk-bad-b",
      payload: "not!!base64!!",
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: { message: string } }).error.message).toMatch(
      /base64/,
    );

    await call(worker, "DELETE", "/agents/wk-bad-a");
    await call(worker, "DELETE", "/agents/wk-bad-b");
  });

  it("POST /agents/:id/broadcast delivers to same-domain peers", async () => {
    const worker = makeWorker();
    await call(worker, "POST", "/agents/wk-bc-s/spawn", { domain: "bc-test" });
    await call(worker, "POST", "/agents/wk-bc-r1/spawn", {
      domain: "bc-test",
    });
    await call(worker, "POST", "/agents/wk-bc-r2/spawn", {
      domain: "bc-test",
    });

    const bc = await call(worker, "POST", "/agents/wk-bc-s/broadcast", {
      payload: btoa("ping"),
    });
    expect(bc.status).toBe(202);
    expect((bc.body as { recipientCount: number }).recipientCount).toBe(2);

    const r1 = await call(worker, "GET", "/agents/wk-bc-r1/inbox");
    expect((r1.body as { messages: unknown[] }).messages).toHaveLength(1);

    await call(worker, "DELETE", "/agents/wk-bc-s");
    await call(worker, "DELETE", "/agents/wk-bc-r1");
    await call(worker, "DELETE", "/agents/wk-bc-r2");
  });

  it("unknown routes return 404", async () => {
    const worker = makeWorker();
    const res = await call(worker, "GET", "/nope");
    expect(res.status).toBe(404);
  });

  it("wrong method on a known route returns 405 with Allow header", async () => {
    const worker = makeWorker();
    await call(worker, "POST", "/agents/wk-allow/spawn", { domain: "demo" });

    const req = new Request("https://example.com/agents/wk-allow", {
      method: "PUT",
    });
    const res = await worker.fetch!(req, env, stubCtx);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, DELETE");

    await call(worker, "DELETE", "/agents/wk-allow");
  });

  it("custom routes shadow + extend the built-in surface", async () => {
    const worker = createMeridianWorker({
      agents: [],
      routes: {
        "GET /custom": () =>
          new Response(JSON.stringify({ custom: true }), {
            headers: { "content-type": "application/json" },
          }),
        // Shadow `/` to verify precedence.
        "GET /": () =>
          new Response(JSON.stringify({ overridden: true }), {
            headers: { "content-type": "application/json" },
          }),
      },
    });
    const custom = await call(worker, "GET", "/custom");
    expect(custom.status).toBe(200);
    expect(custom.body).toEqual({ custom: true });

    const root = await call(worker, "GET", "/");
    expect(root.body).toEqual({ overridden: true });
  });
});

// ── Bearer auth ───────────────────────────────────────────
//
// Auth is off when `config.auth` is undefined (verified by every
// test above). This block exercises the enabled path.

const TOKEN = "test-token-s3cr3t";

function authedWorker() {
  return createMeridianWorker({
    agents: [],
    auth: { bearer: TOKEN },
  });
}

async function callWithHeaders(
  worker: ReturnType<typeof makeWorker>,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const req = new Request(`https://example.com${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await worker.fetch!(req, env, stubCtx);
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }
  return { status: res.status, body: parsed };
}

describe("createMeridianWorker bearer auth", () => {
  it("mutation routes require Authorization header → MRD-CF-AU-001", async () => {
    const worker = authedWorker();
    const res = await call(worker, "POST", "/agents/wk-auth-a/spawn", {
      domain: "demo",
    });
    expect(res.status).toBe(401);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe("MRD-CF-AU-001");
  });

  it("mutation routes reject non-Bearer schemes → MRD-CF-AU-003", async () => {
    const worker = authedWorker();
    const res = await callWithHeaders(
      worker,
      "POST",
      "/agents/wk-auth-b/spawn",
      { authorization: `Basic ${btoa("user:pass")}` },
      { domain: "demo" },
    );
    expect(res.status).toBe(401);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe("MRD-CF-AU-003");
  });

  it("mutation routes reject wrong token → MRD-CF-AU-002", async () => {
    const worker = authedWorker();
    const res = await callWithHeaders(
      worker,
      "POST",
      "/agents/wk-auth-c/spawn",
      { authorization: "Bearer wrong-token" },
      { domain: "demo" },
    );
    expect(res.status).toBe(401);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe("MRD-CF-AU-002");
  });

  it("mutation routes accept the correct token", async () => {
    const worker = authedWorker();
    const res = await callWithHeaders(
      worker,
      "POST",
      "/agents/wk-auth-ok/spawn",
      { authorization: `Bearer ${TOKEN}` },
      { domain: "demo" },
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: "wk-auth-ok", domain: "demo" });

    // Cleanup needs auth too.
    const del = await callWithHeaders(worker, "DELETE", "/agents/wk-auth-ok", {
      authorization: `Bearer ${TOKEN}`,
    });
    expect(del.status).toBe(204);
  });

  it("GET /.well-known/agent-card.json stays open and advertises the bearer scheme", async () => {
    const worker = authedWorker();
    const res = await call(worker, "GET", "/.well-known/agent-card.json");
    expect(res.status).toBe(200);
    const card = res.body as { securitySchemes: Record<string, unknown> };
    expect(card.securitySchemes).toMatchObject({
      bearer: { type: "http", scheme: "bearer" },
    });
  });

  it("GET /.well-known/agent-card.json shows empty securitySchemes when auth is off", async () => {
    const worker = createMeridianWorker({ agents: [] });
    const res = await call(worker, "GET", "/.well-known/agent-card.json");
    expect(res.status).toBe(200);
    const card = res.body as { securitySchemes: Record<string, unknown> };
    expect(card.securitySchemes).toEqual({});
  });

  it("GET /agents/:id + GET /agents/:id/inbox stay open (reads are not gated)", async () => {
    // First spawn with auth, then verify the GETs work without it.
    const worker = authedWorker();
    await callWithHeaders(
      worker,
      "POST",
      "/agents/wk-auth-reads/spawn",
      { authorization: `Bearer ${TOKEN}` },
      { domain: "demo" },
    );

    // GET handle, no auth header.
    const get = await call(worker, "GET", "/agents/wk-auth-reads");
    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({ id: "wk-auth-reads" });

    // GET inbox, no auth header.
    const inbox = await call(worker, "GET", "/agents/wk-auth-reads/inbox");
    expect(inbox.status).toBe(200);

    await callWithHeaders(worker, "DELETE", "/agents/wk-auth-reads", {
      authorization: `Bearer ${TOKEN}`,
    });
  });

  it("constant-time comparison rejects even tokens that differ only in the last byte", async () => {
    const worker = authedWorker();
    const almost = TOKEN.slice(0, -1) + "X";
    const res = await callWithHeaders(
      worker,
      "POST",
      "/agents/wk-auth-close/spawn",
      { authorization: `Bearer ${almost}` },
      { domain: "demo" },
    );
    expect(res.status).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      "MRD-CF-AU-002",
    );
  });

  it("empty bearer token disables auth (same as omitting auth)", async () => {
    const worker = createMeridianWorker({
      agents: [],
      auth: { bearer: "" },
    });
    // No auth header on a mutation — should succeed.
    const res = await call(worker, "POST", "/agents/wk-auth-empty/spawn", {
      domain: "demo",
    });
    expect(res.status).toBe(201);

    await call(worker, "DELETE", "/agents/wk-auth-empty");
  });
});

// ── Admin routes ──────────────────────────────────────────
//
// v0.1 admin surface:
//   GET /admin/domains       — agents grouped by domain
//   GET /admin/agents/:id    — unified inspect payload
//
// Every admin route is bearer-gated when `auth` is configured. Reads
// that enumerate operational state live here (unlike `GET /agents/:id`
// which stays open for polling).

describe("createMeridianWorker admin routes", () => {
  it("GET /admin/domains returns agents grouped by domain (no auth)", async () => {
    const worker = makeWorker();
    // Spawn a few agents across two domains. Use distinct ids per test
    // so isolate-shared state from other `worker-routes` tests doesn't
    // collide.
    await call(worker, "POST", "/agents/adm-domains-a/spawn", {
      domain: "adm-x",
    });
    await call(worker, "POST", "/agents/adm-domains-b/spawn", {
      domain: "adm-x",
    });
    await call(worker, "POST", "/agents/adm-domains-c/spawn", {
      domain: "adm-y",
    });

    const res = await call(worker, "GET", "/admin/domains");
    expect(res.status).toBe(200);
    const body = res.body as {
      domains: Array<{ domain: string; agentIds: string[] }>;
    };

    const admX = body.domains.find((d) => d.domain === "adm-x");
    const admY = body.domains.find((d) => d.domain === "adm-y");
    expect(admX).toBeDefined();
    expect(admY).toBeDefined();
    expect(admX!.agentIds).toEqual(
      expect.arrayContaining(["adm-domains-a", "adm-domains-b"]),
    );
    expect(admY!.agentIds).toEqual(expect.arrayContaining(["adm-domains-c"]));
    // Sorted output contract — agentIds ascending.
    expect([...admX!.agentIds]).toEqual([...admX!.agentIds].sort());

    await call(worker, "DELETE", "/agents/adm-domains-a");
    await call(worker, "DELETE", "/agents/adm-domains-b");
    await call(worker, "DELETE", "/agents/adm-domains-c");
  });

  it("GET /admin/agents/:id returns unified inspect payload", async () => {
    const worker = makeWorker();
    await call(worker, "POST", "/agents/adm-inspect/spawn", {
      domain: "adm-x",
    });

    // Queue a state write + a schedule + an inbound message via a
    // second agent so every field of the inspect response has
    // non-trivial data.
    await call(worker, "POST", "/agents/adm-inspect-peer/spawn", {
      domain: "adm-x",
    });
    await call(worker, "POST", "/agents/adm-inspect-peer/messages", {
      to: "adm-inspect",
      payload: btoa("inbox msg"),
    });

    const res = await call(worker, "GET", "/admin/agents/adm-inspect");
    expect(res.status).toBe(200);
    const body = res.body as {
      agent: { id: string; domain: string; status: string };
      schedules: unknown[];
      usage: { current: { tokensLifetime: number; costUsdLifetime: number } };
      state: { keys: string[] };
      inbox: { length: number };
    };
    expect(body.agent).toMatchObject({
      id: "adm-inspect",
      domain: "adm-x",
      status: "running",
    });
    expect(Array.isArray(body.schedules)).toBe(true);
    expect(body.usage.current.tokensLifetime).toBe(0);
    expect(body.usage.current.costUsdLifetime).toBe(0);
    expect(Array.isArray(body.state.keys)).toBe(true);
    expect(body.inbox.length).toBe(1);

    await call(worker, "DELETE", "/agents/adm-inspect");
    await call(worker, "DELETE", "/agents/adm-inspect-peer");
  });

  it("GET /admin/agents/:id on unspawned agent returns 404 with MRD-CF-LC-002", async () => {
    const worker = makeWorker();
    const res = await call(worker, "GET", "/admin/agents/adm-not-spawned");
    expect(res.status).toBe(404);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe("MRD-CF-LC-002");
  });

  it("unknown /admin/* path returns 404", async () => {
    const worker = makeWorker();
    const res = await call(worker, "GET", "/admin/unknown-path");
    expect(res.status).toBe(404);
  });

  it("non-GET on /admin/domains returns 405", async () => {
    const worker = makeWorker();
    const req = new Request("https://example.com/admin/domains", {
      method: "POST",
    });
    const res = await worker.fetch!(req, env, stubCtx);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });

  // ── Auth-gated variants ─────────────────────────────────

  it("GET /admin/domains requires bearer when auth configured → MRD-CF-AU-001", async () => {
    const worker = authedWorker();
    const res = await call(worker, "GET", "/admin/domains");
    expect(res.status).toBe(401);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe("MRD-CF-AU-001");
  });

  it("GET /admin/domains with valid bearer succeeds", async () => {
    const worker = createMeridianWorker({
      agents: [],
      auth: { bearer: TOKEN },
    });
    // Spawn through the same authed worker so the registry has an
    // entry to list.
    await callWithHeaders(
      worker,
      "POST",
      "/agents/adm-auth-a/spawn",
      { authorization: `Bearer ${TOKEN}` },
      { domain: "adm-auth" },
    );

    const res = await callWithHeaders(worker, "GET", "/admin/domains", {
      authorization: `Bearer ${TOKEN}`,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      domains: Array<{ domain: string; agentIds: string[] }>;
    };
    expect(
      body.domains.some(
        (d) => d.domain === "adm-auth" && d.agentIds.includes("adm-auth-a"),
      ),
    ).toBe(true);

    await callWithHeaders(worker, "DELETE", "/agents/adm-auth-a", {
      authorization: `Bearer ${TOKEN}`,
    });
  });

  it("GET /admin/agents/:id requires bearer when auth configured → MRD-CF-AU-001", async () => {
    const worker = authedWorker();
    const res = await call(worker, "GET", "/admin/agents/anything");
    expect(res.status).toBe(401);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe("MRD-CF-AU-001");
  });

  it("GET /admin/agents/:id with wrong bearer → MRD-CF-AU-002", async () => {
    const worker = authedWorker();
    const res = await callWithHeaders(worker, "GET", "/admin/agents/anything", {
      authorization: "Bearer wrong-token",
    });
    expect(res.status).toBe(401);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe("MRD-CF-AU-002");
  });
});
