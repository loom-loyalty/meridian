/**
 * Thin HTTP client for the CLI. Uses global `fetch` (Node 22+),
 * handles bearer auth, normalizes error bodies from the adapter's
 * `MRD-*` envelope into a single `CliHttpError`.
 */

export interface CliHttpResponse<T> {
  status: number;
  body: T;
}

export class CliHttpError extends Error {
  status: number;
  code: string | undefined;
  category: string | undefined;
  docUrl: string | undefined;

  constructor(
    status: number,
    message: string,
    details: {
      code?: string;
      category?: string;
      docUrl?: string;
    } = {},
  ) {
    super(message);
    this.name = "CliHttpError";
    this.status = status;
    this.code = details.code;
    this.category = details.category;
    this.docUrl = details.docUrl;
  }
}

export async function httpGet<T>(
  endpoint: string,
  path: string,
  opts: { token?: string } = {},
): Promise<CliHttpResponse<T>> {
  return httpRequest<T>("GET", endpoint, path, opts);
}

export async function httpPost<T>(
  endpoint: string,
  path: string,
  body: unknown,
  opts: { token?: string } = {},
): Promise<CliHttpResponse<T>> {
  return httpRequest<T>("POST", endpoint, path, { ...opts, body });
}

export async function httpDelete<T>(
  endpoint: string,
  path: string,
  opts: { token?: string } = {},
): Promise<CliHttpResponse<T>> {
  return httpRequest<T>("DELETE", endpoint, path, opts);
}

async function httpRequest<T>(
  method: string,
  endpoint: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<CliHttpResponse<T>> {
  const url = joinUrl(endpoint, path);
  const headers: Record<string, string> = {};
  if (opts.token) {
    headers["authorization"] = `Bearer ${opts.token}`;
  }
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  const res = await fetch(url, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  let parsed: unknown = text;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  } else {
    parsed = null;
  }

  if (!res.ok) {
    const err = extractErrorEnvelope(parsed);
    throw new CliHttpError(
      res.status,
      err.message ?? `${method} ${url} → HTTP ${res.status}`,
      {
        code: err.code,
        category: err.category,
        docUrl: err.docUrl,
      },
    );
  }

  return { status: res.status, body: parsed as T };
}

function extractErrorEnvelope(body: unknown): {
  message?: string;
  code?: string;
  category?: string;
  docUrl?: string;
} {
  if (body === null || typeof body !== "object") return {};
  const envelope = (body as { error?: unknown }).error;
  if (envelope === null || typeof envelope !== "object") return {};
  const e = envelope as Record<string, unknown>;
  return {
    message: typeof e.message === "string" ? e.message : undefined,
    code: typeof e.code === "string" ? e.code : undefined,
    category: typeof e.category === "string" ? e.category : undefined,
    docUrl: typeof e.docUrl === "string" ? e.docUrl : undefined,
  };
}

function joinUrl(endpoint: string, path: string): string {
  const base = endpoint.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}
