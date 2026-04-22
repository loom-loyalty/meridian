import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { CliHttpError, httpGet, httpPost } from "../src/util/http.js";

// Minimal fetch mock. Each test installs its own response.
let mockResponse: Response | undefined;
let lastCall:
  | {
      url: string;
      init: RequestInit;
    }
  | undefined;

beforeEach(() => {
  mockResponse = undefined;
  lastCall = undefined;
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    lastCall = { url: input, init: init ?? {} };
    if (!mockResponse) throw new Error("no mock response configured");
    return mockResponse;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function respond(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  mockResponse = new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    {
      status,
      headers: {
        "content-type":
          typeof body === "string" ? "text/plain" : "application/json",
        ...headers,
      },
    },
  );
}

describe("httpGet", () => {
  it("returns parsed JSON on 200", async () => {
    respond(200, { runtime: "x", healthy: true });
    const res = await httpGet<{ healthy: boolean }>(
      "https://meridian.example",
      "/",
    );
    expect(res.status).toBe(200);
    expect(res.body.healthy).toBe(true);
  });

  it("joins base + path correctly when base has trailing slash", async () => {
    respond(200, {});
    await httpGet("https://meridian.example/", "/admin/domains");
    expect(lastCall!.url).toBe("https://meridian.example/admin/domains");
  });

  it("joins when path lacks leading slash", async () => {
    respond(200, {});
    await httpGet("https://meridian.example", "admin/domains");
    expect(lastCall!.url).toBe("https://meridian.example/admin/domains");
  });

  it("adds Authorization: Bearer when token provided", async () => {
    respond(200, {});
    await httpGet("https://meridian.example", "/admin/domains", {
      token: "abc",
    });
    const headers = lastCall!.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer abc");
  });

  it("omits Authorization when token absent", async () => {
    respond(200, {});
    await httpGet("https://meridian.example", "/");
    const headers = lastCall!.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBeUndefined();
  });

  it("throws CliHttpError with code/message on 4xx response", async () => {
    respond(401, {
      error: {
        code: "MRD-CF-AU-001",
        category: "unauthenticated",
        message: "missing Authorization header",
        docUrl: "https://meridianprotocol.dev/errors/MRD-CF-AU-001",
      },
    });
    const err = await httpGet("https://meridian.example", "/admin/domains")
      .then(() => null)
      .catch((e) => e);
    expect(err).toBeInstanceOf(CliHttpError);
    const e = err as CliHttpError;
    expect(e.status).toBe(401);
    expect(e.code).toBe("MRD-CF-AU-001");
    expect(e.category).toBe("unauthenticated");
    expect(e.docUrl).toBe("https://meridianprotocol.dev/errors/MRD-CF-AU-001");
  });

  it("still throws CliHttpError when error body is not JSON", async () => {
    respond(500, "not json");
    const err = await httpGet("https://meridian.example", "/")
      .then(() => null)
      .catch((e) => e);
    expect(err).toBeInstanceOf(CliHttpError);
    expect((err as CliHttpError).status).toBe(500);
  });
});

describe("httpPost", () => {
  it("serializes body as JSON + sets content-type", async () => {
    respond(201, { ok: true });
    await httpPost("https://meridian.example", "/agents/x/spawn", {
      domain: "demo",
    });
    const headers = lastCall!.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(lastCall!.init.body).toBe(JSON.stringify({ domain: "demo" }));
  });
});
