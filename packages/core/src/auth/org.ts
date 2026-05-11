import type { CommerceConfig } from "../config/types.js";
import { OrgResolutionError } from "../kernel/errors.js";
import { OrganizationService } from "../modules/organization/service.js";
import { isStrictOrgResolution } from "./strict-org-resolution.js";

const LEGACY_ORG_DEFAULT_WARN_COOLDOWN_MS = 60_000;
let lastLegacyOrgDefaultWarnAt = 0;

function warnDeprecatedOrgDefaultFallback(): void {
  const now = Date.now();
  if (now - lastLegacyOrgDefaultWarnAt < LEGACY_ORG_DEFAULT_WARN_COOLDOWN_MS) return;
  lastLegacyOrgDefaultWarnAt = now;
  console.warn(
    "resolveOrgId fell back to deprecated DEFAULT_ORG_ID (org_default); set auth.defaultOrganizationId, pass defaultOrgId, or ensure the actor has organizationId.",
  );
}

/**
 * @deprecated Will be removed. Use `config.auth.defaultOrganizationId` instead.
 * Kept only for test utilities and backwards compatibility.
 */
export const DEFAULT_ORG_ID = "org_default";

/**
 * Module-level default set once at boot by `setBootDefaultOrgId()`.
 * Allows resolveOrgId to use the config value without requiring
 * every service caller to pass it explicitly.
 */
let _bootDefaultOrgId: string | undefined;

/**
 * Called once at boot by createCommerce/createServer to register
 * the config-driven default org ID. This bridges the gap between
 * config (available at boot) and services (which don't have config access).
 */
export function setBootDefaultOrgId(orgId: string): void {
  _bootDefaultOrgId = orgId;
}

/**
 * Extracts the organization ID from an actor.
 *
 * Resolution order:
 * 1. Actor's organizationId (set by middleware from session/API key/storeResolver)
 * 2. Explicit defaultOrgId parameter (caller override)
 * 3. Boot-time default (from config.auth.defaultOrganizationId via setBootDefaultOrgId)
 * 4. Deprecated fallback to DEFAULT_ORG_ID (will be removed)
 */
export function resolveOrgId(
  actor: unknown,
  defaultOrgId?: string,
  commerceConfig?: CommerceConfig,
): string {
  if (actor != null && typeof actor === "object" && "organizationId" in actor) {
    const orgId = (actor as { organizationId: unknown }).organizationId;
    if (typeof orgId === "string") return orgId;
  }
  if (defaultOrgId) return defaultOrgId;
  if (_bootDefaultOrgId) return _bootDefaultOrgId;
  if (isStrictOrgResolution(commerceConfig)) {
    throw new OrgResolutionError(
      "Organization could not be resolved: no actor organizationId, no defaultOrgId, and no configured default organization.",
    );
  }
  warnDeprecatedOrgDefaultFallback();
  return DEFAULT_ORG_ID;
}

/**
 * @deprecated Use seed script with `auth.api.createOrganization()` instead.
 * Kept for backwards compatibility during migration. Will be removed.
 */
export async function ensureDefaultOrg(
  db: unknown,
  storeName = "Default Store",
): Promise<void> {
  const orgService = new OrganizationService(db);
  await orgService.create({
    id: DEFAULT_ORG_ID,
    name: storeName,
    slug: "default",
  });
}
