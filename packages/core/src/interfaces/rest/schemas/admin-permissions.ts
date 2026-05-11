import { z, createRoute } from "@hono/zod-openapi";

const PluginPermissionEntrySchema = z.object({
  scope: z.string(),
  description: z.string(),
  plugin: z.string(),
});

export const listAdminPermissionsRoute = createRoute({
  method: "get",
  path: "/permissions",
  tags: ["Admin"],
  summary: "List core and plugin permission scopes",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            core: z.array(z.string()),
            plugin: z.array(PluginPermissionEntrySchema),
          }),
        },
      },
      description: "Role-derived core permissions and plugin-declared scopes",
    },
  },
});
