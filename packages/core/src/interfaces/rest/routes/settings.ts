import { OpenAPIHono } from "@hono/zod-openapi";
import type { Kernel } from "../../../runtime/kernel.js";
import {
  KNOWN_GROUP_SCHEMAS,
  getAllSettingsRoute,
  getSettingsGroupRoute,
  patchSettingsGroupRoute,
} from "../schemas/settings.js";
import { type AppEnv, mapErrorToResponse, mapErrorToStatus, requirePerm } from "../utils.js";

export function settingsRoutes(kernel: Kernel) {
  const router = new OpenAPIHono<AppEnv>();

  router.use("/", requirePerm("settings:manage"));
  router.use("/:group", requirePerm("settings:manage"));

  // @ts-expect-error -- openapi handler union return type
  router.openapi(getAllSettingsRoute, async (c) => {
    const result = await kernel.services.settings.getAll(c.get("actor"));
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(getSettingsGroupRoute, async (c) => {
    const result = await kernel.services.settings.getGroup(c.req.param("group"), c.get("actor"));
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(patchSettingsGroupRoute, async (c) => {
    const group = c.req.param("group");
    const body = c.req.valid("json");

    // Known groups get typed validation; unknown groups accept any object.
    const groupSchema = KNOWN_GROUP_SCHEMAS[group];
    if (groupSchema) {
      const parsed = groupSchema.safeParse(body);
      if (!parsed.success) {
        const isProd = process.env.NODE_ENV === "production";
        return c.json({
          error: {
            code: "VALIDATION_FAILED",
            message: isProd
              ? "Invalid input."
              : parsed.error.issues
                  .map((i) => `${i.path.join(".")}: ${i.message}`)
                  .join("; "),
          },
        }, 422);
      }
    }

    const result = await kernel.services.settings.updateGroup(group, body, c.get("actor"));
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  return router;
}
