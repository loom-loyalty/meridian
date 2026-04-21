/**
 * Permission scoping and invocation context types.
 * PermissionScope constrains WHAT an agent can access.
 * InvocationContext shapes permissions per invocation.
 *
 * @experimental - all types in this module
 */

import type { DomainId } from "./primitives.js";

export interface PermissionScope {
  /** Service/method patterns using glob syntax. e.g., ["crm.*", "support.getIssue"] */
  services: string[];
  /** Tool categories the agent can use. Runtime-defined. */
  tools?: Record<string, boolean>;
  /** Domain(s) this scope applies to. Empty = all domains. */
  domains?: DomainId[];
}

export interface InvocationContext {
  source: "interactive" | "webhook" | "scheduled" | "agent" | "system";
  sourceId?: string;
  permissions?: PermissionScope;
  auditLevel?: "full" | "summary" | "none";
}
