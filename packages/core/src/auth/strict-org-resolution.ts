import type { CommerceConfig } from "../config/types.js";

/**
 * Whether a request with no actor must fail rather than resolve to a default
 * organization. Fail closed by default: without an actor there is no tenant,
 * and silently resolving to a default organization served one merchant's data
 * to unauthenticated callers on every unguarded or allowlisted read path.
 * Single-tenant deployments that relied on that fallback opt out explicitly
 * with `auth.strictOrgResolution: false` or `STRICT_ORG_RESOLUTION=false`.
 */
export function isStrictOrgResolution(config?: CommerceConfig | null): boolean {
  return config?.auth?.strictOrgResolution !== false && process.env.STRICT_ORG_RESOLUTION !== "false";
}
