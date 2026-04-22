/**
 * Tenancy hooks for `createMeridianWorker`.
 *
 * Tenancy is OPT-IN in v0.1. When `config.tenancy` is undefined, the
 * worker runs single-tenant — all agents share one global namespace,
 * matching pre-M6 behavior. When `config.tenancy` is set, every
 * incoming request is mapped to a `tenantId` via the adopter-supplied
 * `TenantAuthorizer`, and the runtime scopes:
 *
 *   • DO names: `env.AGENT.idFromName("${tenantId}::${agentId}")`
 *   • Registry shard: `env.REGISTRY.idFromName("${tenantId}::default")`
 *   • Analytics Engine blobs: `meridian.tenant_id=<id>`
 *
 * State does NOT need a per-key prefix because DOs are already
 * per-tenant — each `(tenant, agent)` pair maps to a distinct Durable
 * Object with its own SQLite database. Same goes for mailbox /
 * schedule storage.
 *
 * Cross-tenant isolation invariants (server-enforced when tenancy
 * is active):
 *
 *   1. Agent A in tenant X cannot address agent B in tenant Y —
 *      `send()` resolves target via the sender's own tenantId stored
 *      in meta.
 *   2. Broadcasts query only the sender's tenant-scoped registry
 *      shard, so zero cross-tenant fan-out.
 *   3. Admin routes call `authorizer.resolveTenantId(req)` at the
 *      top of dispatch; `/admin/domains` and `/admin/agents/:id`
 *      operate within the caller's tenant only.
 *   4. Spawn through the worker surface forces the caller's tenantId
 *      onto the `SpawnConfig` — adopters cannot spoof a tenant via
 *      the request body.
 *
 * Shuttle (Loom Loyalty's commercial product) implements a concrete
 * `TenantAuthorizer` against its multi-tenant auth plane; the hooks
 * here let the same runtime library power both Shuttle and
 * single-tenant adopter deploys without forking.
 */

import { meridianError } from "./errors.js";

/**
 * Adopter-implemented hook that maps an incoming request to a
 * `tenantId`. Called once per request, before any routing.
 *
 * Typical implementations:
 *   • Validate a JWT and read `tid` claim
 *   • Look up a bearer token in KV to find its tenant binding
 *   • Parse a custom header like `x-tenant-id` (dev only —
 *     adopters SHOULD authenticate before trusting a header)
 *
 * Throw a `MeridianError` from this method to reject the request
 * with a specific `MRD-CF-AU-*` code; any other throw is treated
 * as an opaque 500.
 */
export interface TenantAuthorizer {
  resolveTenantId(req: Request): Promise<string> | string;
}

/**
 * Default single-tenant authorizer. Always returns `"default"`.
 * Used internally whenever `config.tenancy` is undefined so the
 * downstream plumbing has a consistent tenantId to pass around.
 */
export class SingleTenantAuthorizer implements TenantAuthorizer {
  resolveTenantId(): string {
    return "default";
  }
}

export interface TenancyConfig {
  /**
   * Required. Resolves `tenantId` per incoming request. Called on
   * the Worker fetch path before any route dispatch.
   */
  authorizer: TenantAuthorizer;
}

/**
 * Per-request tenancy context. Produced by the worker's
 * `resolveTenantContext()` helper and passed through to route
 * handlers so every DO lookup, registry query, and observability
 * emission lands under the right tenant.
 */
export interface TenantContext {
  tenantId: string;
  /**
   * True when the adopter configured `tenancy` on
   * `createMeridianWorker`. False when running single-tenant. Lets
   * helpers decide whether to prefix DO names or not.
   */
  enabled: boolean;
}

export const SINGLE_TENANT_CONTEXT: TenantContext = {
  tenantId: "default",
  enabled: false,
};

/**
 * Compute the name to pass to `env.AGENT.idFromName()` given an
 * agent id + tenant context. Single-tenant runtimes pass the agent
 * id through untouched (preserves pre-M6 DO naming, so existing
 * deploys stay on their existing state). Multi-tenant runtimes
 * prefix with the tenantId so cross-tenant agents never collide.
 */
export function scopedAgentName(
  agentId: string,
  tenant: TenantContext,
): string {
  return tenant.enabled ? `${tenant.tenantId}::${agentId}` : agentId;
}

/**
 * Compute the registry shard key for a tenant. Single-tenant uses
 * the pre-M6 fixed `"default"` key so existing registry state keeps
 * working. Multi-tenant deploys partition the registry by tenantId
 * so `registry.list()` only returns agents for the caller.
 */
export function scopedRegistryKey(tenant: TenantContext): string {
  return tenant.enabled ? `${tenant.tenantId}::default` : "default";
}

/**
 * Resolve the request's tenant context. Throws the adopter's
 * authorizer error directly (typically a `MeridianError` with a
 * `MRD-CF-AU-*` code).
 */
export async function resolveTenantContext(
  req: Request,
  config: TenancyConfig | undefined,
): Promise<TenantContext> {
  if (!config) return SINGLE_TENANT_CONTEXT;
  const tenantId = await config.authorizer.resolveTenantId(req);
  if (!tenantId || typeof tenantId !== "string") {
    throw meridianError(
      "MRD-CF-AU-001",
      "TenantAuthorizer.resolveTenantId returned an invalid value",
    );
  }
  return { tenantId, enabled: true };
}
