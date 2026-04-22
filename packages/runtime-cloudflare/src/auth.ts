/**
 * Bearer-auth helpers for the adopter-facing HTTP surface.
 *
 * v0.1 ships a shared-secret scheme: the adopter configures
 * `createMeridianWorker({auth: {bearer: <token>}})` and every
 * request to a gated route must carry `Authorization: Bearer <token>`.
 *
 * Compared via constant-time equality so timing-attack mitigations
 * are correct by default. Adopters rotating tokens should deploy
 * the new config and drop the old token after all clients flip.
 *
 * The `AuthPlugin` interface is intentionally NOT exported in v0.1
 * (eng-review decision 2026-04-21). OIDC / OAuth2 / custom schemes
 * land in v0.1.5 when the interface stabilizes against a real
 * second implementation. The shared-secret path inside this module
 * is the ENTIRE v0.1 auth surface.
 */

import { meridianError } from "./errors.js";

/**
 * Bearer-token configuration. Pass to `createMeridianWorker({auth})`.
 * Leaving `auth` undefined keeps the worker open (v0.1 behavior
 * before M4a); adopters who need this MUST restrict via Cloudflare
 * Access or a private URL.
 */
export interface BearerAuthConfig {
  /**
   * The expected bearer token. Typically read from a Worker secret:
   *
   *     createMeridianWorker({
   *       auth: { bearer: env.MERIDIAN_ADMIN_TOKEN },
   *       agents: [...]
   *     })
   *
   * Empty string or undefined disables auth (same as omitting
   * `auth` entirely). Set it via `wrangler secret put`, never
   * commit the token to source control.
   */
  bearer: string;
}

export interface AuthConfig {
  /** Shared-secret bearer auth. Mutually exclusive with future AuthPlugin (v0.1.5+). */
  bearer?: string;
}

/**
 * Validate `Authorization: Bearer <token>` against the configured
 * bearer secret. Throws a MeridianError with a stable MRD-CF-AU-*
 * code on any failure (missing header, wrong scheme, token mismatch).
 *
 * If `config.bearer` is falsy, this is a no-op — adopters who don't
 * configure auth get the old open behavior.
 */
export function enforceBearer(
  req: Request,
  config: AuthConfig | undefined,
): void {
  const expected = config?.bearer;
  if (!expected) return; // auth not configured → pass through

  const header = req.headers.get("authorization");
  if (!header) {
    throw meridianError("MRD-CF-AU-001");
  }

  // Accept `Bearer <token>` exactly. Case-insensitive on the scheme
  // per RFC 7235 §2.1 ("Bearer" is case-insensitive), case-sensitive
  // on the token itself.
  const match = header.match(/^\s*([A-Za-z]+)\s+(.+?)\s*$/);
  if (!match) {
    throw meridianError("MRD-CF-AU-003");
  }
  const [, scheme, token] = match;
  if (!/^Bearer$/i.test(scheme!)) {
    throw meridianError("MRD-CF-AU-003");
  }

  if (!constantTimeEquals(token!, expected)) {
    throw meridianError("MRD-CF-AU-002");
  }
}

/**
 * Constant-time string comparison. Crucial for bearer validation —
 * a naive `===` leaks token length and prefix-match progress via
 * timing.
 *
 * Uses a simple XOR-accumulate loop. Both strings are compared
 * up to the longer length so mismatched lengths still take the
 * same amount of time.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  const len = Math.max(aBytes.byteLength, bBytes.byteLength);
  let diff = aBytes.byteLength ^ bBytes.byteLength;
  for (let i = 0; i < len; i++) {
    const ax = i < aBytes.byteLength ? aBytes[i]! : 0;
    const bx = i < bBytes.byteLength ? bBytes[i]! : 0;
    diff |= ax ^ bx;
  }
  return diff === 0;
}
