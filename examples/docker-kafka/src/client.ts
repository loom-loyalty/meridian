/**
 * Minimal Meridian HTTP client.
 *
 * Hits the REST surface exposed by `createMeridianWorker` — the same
 * endpoints documented in `packages/runtime-cloudflare/README.md`.
 * Base64-encodes outbound payloads + decodes inbound ones.
 *
 * Adopters shipping their own external agent typically drop this file
 * into their project directly. It's ~120 lines of plain fetch + no
 * other Meridian runtime deps. Copy, paste, tweak.
 *
 * v0.1 NO AUTH. The `MERIDIAN_TOKEN` env var is accepted but the
 * current worker doesn't enforce it — documented as a future M4
 * requirement. Sending a bearer header now means your external agent
 * won't need to change when auth lands.
 */

import type {
  AgentHandle,
  BroadcastReceipt,
  IncomingMessage,
  MessageReceipt,
} from "@loom-loyalty/meridian-types";

export interface MeridianClientOptions {
  /** Base URL of the Meridian worker, e.g. `https://pg-monitor.example.workers.dev` */
  endpoint: string;
  /**
   * Bearer token for future auth (v0.1 ignores it server-side, but
   * supplying it now means forward-compatible clients work when M4
   * ships). Read from `MERIDIAN_TOKEN` env var by default in the
   * factory below.
   */
  token?: string;
  /** Custom fetch for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

/**
 * Incoming message as returned by the HTTP inbox endpoint. Same
 * shape as `IncomingMessage` from `@loom-loyalty/meridian-types`
 * except `payload` is a base64 string on the wire.
 */
export interface HttpIncomingMessage extends Omit<IncomingMessage, "payload"> {
  payload: string;
}

export interface MeridianClient {
  spawn(id: string, domain: string): Promise<AgentHandle>;
  terminate(id: string): Promise<void>;
  send(
    fromId: string,
    toId: string,
    payload: Uint8Array,
  ): Promise<MessageReceipt>;
  broadcast(
    fromId: string,
    domain: string | undefined,
    payload: Uint8Array,
  ): Promise<BroadcastReceipt>;
  inbox(id: string): Promise<IncomingMessage[]>;
  drainInbox(id: string): Promise<IncomingMessage[]>;
}

export function createMeridianClient(
  opts: MeridianClientOptions,
): MeridianClient {
  const f = opts.fetch ?? fetch;
  const base = opts.endpoint.replace(/\/$/, "");

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;

    const res = await f(`${base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.status === 204) return undefined as T;

    const text = await res.text();
    const parsed = text.length > 0 ? safeJson(text) : null;

    if (!res.ok) {
      // Server returns `{error: {code, category, message, docUrl, ...}}` for
      // MRD-CF-* throws. Re-raise with the structured payload so callers
      // can pattern-match on `.code`.
      const err = (parsed as { error?: MeridianHttpError })?.error;
      throw new MeridianHttpError(
        err?.code ?? `HTTP ${res.status}`,
        err?.message ?? res.statusText,
        res.status,
        err?.category,
        err?.docUrl,
      );
    }
    return parsed as T;
  }

  return {
    spawn: (id, domain) =>
      request<AgentHandle>("POST", `/agents/${encodeURIComponent(id)}/spawn`, {
        domain,
      }),
    terminate: (id) =>
      request<void>("DELETE", `/agents/${encodeURIComponent(id)}`),
    send: (fromId, toId, payload) =>
      request<MessageReceipt>(
        "POST",
        `/agents/${encodeURIComponent(fromId)}/messages`,
        { to: toId, payload: toBase64(payload) },
      ),
    broadcast: (fromId, domain, payload) =>
      request<BroadcastReceipt>(
        "POST",
        `/agents/${encodeURIComponent(fromId)}/broadcast`,
        {
          selector: domain ? { domain } : {},
          payload: toBase64(payload),
        },
      ),
    inbox: async (id) => {
      const r = await request<{ messages: HttpIncomingMessage[] }>(
        "GET",
        `/agents/${encodeURIComponent(id)}/inbox`,
      );
      return r.messages.map(decodeMessage);
    },
    drainInbox: async (id) => {
      const r = await request<{ messages: HttpIncomingMessage[] }>(
        "POST",
        `/agents/${encodeURIComponent(id)}/inbox/drain`,
      );
      return r.messages.map(decodeMessage);
    },
  };
}

export class MeridianHttpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number,
    public readonly category?: string,
    public readonly docUrl?: string,
  ) {
    super(message);
    this.name = "MeridianHttpError";
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function toBase64(bytes: Uint8Array): string {
  // Node 18+ has native btoa; this loop matches what's in the
  // runtime-cloudflare worker helper so clients + server agree on
  // encoding.
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return Buffer.from(binary, "binary").toString("base64");
}

function decodeMessage(m: HttpIncomingMessage): IncomingMessage {
  return {
    ...m,
    payload: new Uint8Array(Buffer.from(m.payload, "base64")),
  };
}
