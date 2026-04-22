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
