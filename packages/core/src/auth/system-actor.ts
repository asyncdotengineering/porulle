import type { Actor } from "./types.js";

/**
 * Creates a system actor for internal operations (webhooks, jobs, compensation chains).
 * System actors have full permissions, so the organization they act in is
 * always named by the caller — there is no default tenant to fall back to.
 */
export function createSystemActor(orgId: string): Actor {
  return {
    type: "api_key",
    userId: "system:internal",
    email: null,
    name: "System",
    vendorId: null,
    organizationId: orgId,
    role: "system",
    permissions: ["*:*"],
    // A job proved nothing to anybody. Said out loud so a step-up guard reads
    // "cannot establish" rather than inheriting the caller's freshness.
    sessionCreatedAt: null,
  };
}
