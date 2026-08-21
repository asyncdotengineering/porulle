import type { CommerceConfig } from "../config/types.js";

let _bootStrictOrgResolution = false;

export function setBootStrictOrgResolution(strict: boolean): void {
  _bootStrictOrgResolution = strict;
}

export function isStrictOrgResolution(config?: CommerceConfig | null): boolean {
  // Fail closed by default. Without an actor there is no tenant, and silently
  // resolving to a default organization served one merchant's data to
  // unauthenticated callers on every unguarded or allowlisted read path.
  // Single-tenant deployments that relied on that fallback opt out explicitly.
  if (config?.auth?.strictOrgResolution === false) return false;
  if (process.env.STRICT_ORG_RESOLUTION === "false") return false;
  if (config?.auth?.strictOrgResolution === true) return true;
  if (process.env.STRICT_ORG_RESOLUTION === "true") return true;
  if ((config === undefined || config === null) && _bootStrictOrgResolution) return true;
  return true;
}
