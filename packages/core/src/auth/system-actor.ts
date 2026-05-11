import type { Actor } from "./types.js";
import { DEFAULT_ORG_ID } from "./org.js";

/**
 * Creates a system actor for internal operations (webhooks, jobs, compensation chains).
 * System actors have full permissions and are scoped to a specific organization.
 */
export function createSystemActor(orgId: string = DEFAULT_ORG_ID): Actor {
  return {
    type: "api_key",
    userId: "system:internal",
    email: null,
    name: "System",
    vendorId: null,
    organizationId: orgId,
    role: "system",
    permissions: ["*:*"],
  };
}
