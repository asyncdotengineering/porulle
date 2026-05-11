import { OpenAPIHono } from "@hono/zod-openapi";
import type { Kernel } from "../../../../runtime/kernel.js";
import type { CommerceConfig } from "../../../../config/types.js";
import { assertPermission } from "../../../../auth/permissions.js";
import { listAdminPermissionsRoute } from "../../schemas/admin-permissions.js";
import type { AppEnv } from "../../utils.js";

function flattenCoreRolePermissions(config: CommerceConfig): string[] {
  const roles = config.auth?.roles ?? {};
  const set = new Set<string>();
  for (const def of Object.values(roles)) {
    for (const p of def.permissions) {
      set.add(p);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

export function adminPermissionsRoutes(kernel: Kernel) {
  const router = new OpenAPIHono<AppEnv>();

  router.openapi(listAdminPermissionsRoute, (c) => {
    const actor = c.get("actor");
    assertPermission(actor, "admin");

    const core = flattenCoreRolePermissions(kernel.config);
    const plugin = kernel.pluginPermissions.map((p) => ({
      scope: p.scope,
      description: p.description,
      plugin: p.pluginId ?? "(unknown)",
    }));

    return c.json({ core, plugin });
  });

  return router;
}
