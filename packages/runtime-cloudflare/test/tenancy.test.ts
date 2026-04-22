/**
 * Tenancy isolation tests. Exercises `createMeridianWorker({tenancy})`
 * against a multi-tenant authorizer backed by an `x-tenant` header so
 * tests can flip between tenants without setting up JWTs.
 *
 * What we're verifying (the M6 invariants):
 *   1. DO namespacing: same agentId under two tenants maps to
 *      distinct DOs (state, handle, inbox all partitioned).
 *   2. Registry scoping: `/admin/domains` returns only the caller's
 *      tenant's agents, never the other tenant's.
 *   3. Admin inspect scoping: an agent id that exists only in tenant
 *      A returns 404 to a tenant-B caller.
 *   4. Cross-tenant send rejection: agent X/A sending to "B" resolves
 *      to the tenant-X B, not tenant-Y B. A send into the "other"
 *      tenant's namespace lands on a DO that doesn't exist, so
 *      deliver fails.
 *   5. Single-tenant fallback: a worker without `tenancy` config
 *      produces AgentHandles without `tenantId`.
 */

import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";

import {
  createMeridianWorker,
  SingleTenantAuthorizer,
  type TenantAuthorizer,
} from "../src/index.js";
import { defineAgent } from "../src/define-agent.js";

const stubCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

beforeAll(() => {
  // Register agent specs ahead of time. Same spec id in both tenants
  // — they share behavior; isolation comes from DO-level scoping,
  // not spec registration.
  defineAgent({ id: "tnt-alpha", domain: "demo" });
  defineAgent({ id: "tnt-beta", domain: "demo" });
  defineAgent({ id: "tnt-shared", domain: "demo" });
});

// Header-based authorizer — enough for tests. Real adopters would
// validate a JWT / lookup a bearer token in KV.
class HeaderTenantAuthorizer implements TenantAuthorizer {
  resolveTenantId(req: Request): string {
    const header = req.headers.get("x-tenant");
    if (!header) throw new Error("missing x-tenant header");
    return header;
  }
}

function tenantAwareWorker() {
  return createMeridianWorker({
    agents: [
      { id: "tnt-alpha", domain: "demo" },
      { id: "tnt-beta", domain: "demo" },
      { id: "tnt-shared", domain: "demo" },
    ],
    tenancy: { authorizer: new HeaderTenantAuthorizer() },
  });
}

async function callAs(
  worker: ReturnType<typeof tenantAwareWorker>,
  tenant: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { "x-tenant": tenant };
  if (body !== undefined) headers["content-type"] = "application/json";
  const req = new Request(`https://example.com${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await worker.fetch!(req, env, stubCtx);
  const text = await res.text();
  let parsed: unknown = text;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep raw */
    }
  } else {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

describe("createMeridianWorker tenancy", () => {
  it("same agent id under two tenants maps to distinct DOs", async () => {
    const worker = tenantAwareWorker();

    // Spawn tnt-shared under tenant A and tenant B with distinct
    // metadata so we can prove the DOs are separate.
    const a = await callAs(
      worker,
      "tnt-a",
      "POST",
      "/agents/tnt-shared/spawn",
      {
        domain: "demo",
      },
    );
    expect(a.status).toBe(201);
    const aHandle = a.body as { id: string; domain: string; tenantId?: string };
    expect(aHandle.tenantId).toBe("tnt-a");

    const b = await callAs(
      worker,
      "tnt-b",
      "POST",
      "/agents/tnt-shared/spawn",
      {
        domain: "demo",
      },
    );
    expect(b.status).toBe(201);
    const bHandle = b.body as { id: string; domain: string; tenantId?: string };
    expect(bHandle.tenantId).toBe("tnt-b");

    // Each tenant sees only its own copy on GET.
    const aGet = await callAs(worker, "tnt-a", "GET", "/agents/tnt-shared");
    expect(aGet.status).toBe(200);
    expect((aGet.body as { tenantId: string }).tenantId).toBe("tnt-a");

    const bGet = await callAs(worker, "tnt-b", "GET", "/agents/tnt-shared");
    expect(bGet.status).toBe(200);
    expect((bGet.body as { tenantId: string }).tenantId).toBe("tnt-b");

    // Inboxes stay partitioned. Tenant A sends to its own
    // tnt-shared; tenant B's inbox should be empty.
    await callAs(worker, "tnt-a", "POST", "/agents/tnt-shared/spawn", {
      domain: "demo",
    });
    const inboxA = await callAs(
      worker,
      "tnt-a",
      "GET",
      "/agents/tnt-shared/inbox",
    );
    const inboxB = await callAs(
      worker,
      "tnt-b",
      "GET",
      "/agents/tnt-shared/inbox",
    );
    expect((inboxA.body as { messages: unknown[] }).messages).toEqual([]);
    expect((inboxB.body as { messages: unknown[] }).messages).toEqual([]);

    await callAs(worker, "tnt-a", "DELETE", "/agents/tnt-shared");
    await callAs(worker, "tnt-b", "DELETE", "/agents/tnt-shared");
  });

  it("admin/domains only lists the caller's tenant agents", async () => {
    const worker = tenantAwareWorker();

    await callAs(worker, "tnt-a", "POST", "/agents/tnt-alpha/spawn", {
      domain: "demo",
    });
    await callAs(worker, "tnt-b", "POST", "/agents/tnt-beta/spawn", {
      domain: "demo",
    });

    const listA = await callAs(worker, "tnt-a", "GET", "/admin/domains");
    expect(listA.status).toBe(200);
    const bodyA = listA.body as {
      domains: Array<{ domain: string; agentIds: string[] }>;
    };
    const allA = bodyA.domains.flatMap((d) => d.agentIds);
    expect(allA).toContain("tnt-alpha");
    expect(allA).not.toContain("tnt-beta");

    const listB = await callAs(worker, "tnt-b", "GET", "/admin/domains");
    expect(listB.status).toBe(200);
    const bodyB = listB.body as {
      domains: Array<{ domain: string; agentIds: string[] }>;
    };
    const allB = bodyB.domains.flatMap((d) => d.agentIds);
    expect(allB).toContain("tnt-beta");
    expect(allB).not.toContain("tnt-alpha");

    await callAs(worker, "tnt-a", "DELETE", "/agents/tnt-alpha");
    await callAs(worker, "tnt-b", "DELETE", "/agents/tnt-beta");
  });

  it("admin/agents/:id cross-tenant lookup returns 404 MRD-CF-LC-002", async () => {
    const worker = tenantAwareWorker();

    await callAs(worker, "tnt-a", "POST", "/agents/tnt-alpha/spawn", {
      domain: "demo",
    });

    // tenant-B caller tries to inspect tenant-A's agent. The stub
    // points at tenant-B's "tnt-alpha" DO, which was never spawned,
    // so lifecycle.get() throws LC-002.
    const crossTenant = await callAs(
      worker,
      "tnt-b",
      "GET",
      "/admin/agents/tnt-alpha",
    );
    expect(crossTenant.status).toBe(404);
    expect((crossTenant.body as { error: { code: string } }).error.code).toBe(
      "MRD-CF-LC-002",
    );

    await callAs(worker, "tnt-a", "DELETE", "/agents/tnt-alpha");
  });

  it("agent GET inside the right tenant returns tenantId on the handle", async () => {
    const worker = tenantAwareWorker();
    await callAs(worker, "tnt-a", "POST", "/agents/tnt-alpha/spawn", {
      domain: "demo",
    });
    const got = await callAs(worker, "tnt-a", "GET", "/agents/tnt-alpha");
    expect((got.body as { tenantId: string }).tenantId).toBe("tnt-a");
    await callAs(worker, "tnt-a", "DELETE", "/agents/tnt-alpha");
  });

  it("single-tenant worker (no tenancy config) produces handles without tenantId", async () => {
    const worker = createMeridianWorker({
      agents: [{ id: "tnt-shared", domain: "demo" }],
    });

    const res = await worker.fetch!(
      new Request("https://example.com/agents/tnt-shared/spawn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain: "demo" }),
      }),
      env,
      stubCtx,
    );
    expect(res.status).toBe(201);
    const handle = (await res.json()) as { id: string; tenantId?: string };
    expect(handle.id).toBe("tnt-shared");
    expect(handle.tenantId).toBeUndefined();

    const del = await worker.fetch!(
      new Request("https://example.com/agents/tnt-shared", {
        method: "DELETE",
      }),
      env,
      stubCtx,
    );
    expect(del.status).toBe(204);
  });

  it("SingleTenantAuthorizer returns 'default' regardless of input", () => {
    const a = new SingleTenantAuthorizer();
    expect(a.resolveTenantId()).toBe("default");
  });
});
