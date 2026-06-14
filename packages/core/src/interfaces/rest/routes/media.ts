import { OpenAPIHono } from "@hono/zod-openapi";
import type { Kernel } from "../../../runtime/kernel.js";
import type { AttachMediaInput } from "../../../modules/media/service.js";
import { attachMediaRoute, getMediaRoute, deleteMediaRoute } from "../schemas/media.js";
import { type AppEnv, mapErrorToResponse, mapErrorToStatus, requirePerm } from "../utils.js";

export function mediaRoutes(kernel: Kernel) {
  const router = new OpenAPIHono<AppEnv>();

  // Upload requires authentication + media:write permission
  router.use("/upload", requirePerm("media:write"));

  router.post("/upload", async (c) => {
    // No storage configured (the default no-op adapter) → media is disabled.
    if (kernel.config.storage?.providerId === "noop") {
      return c.json({
        error: { code: "storage_not_supported", message: "Media storage is not configured." },
      }, 501);
    }

    const body = await c.req.parseBody();
    const file = body.file as File;

    if (!file) {
      return c.json({ error: { code: "VALIDATION_FAILED", message: "file is required" } }, 422);
    }

    const buffer = await file.arrayBuffer();
    const actor = c.get("actor");
    const result = await kernel.services.media.upload({
      filename: file.name,
      contentType: file.type,
      data: buffer,
      alt: String(body.alt ?? ""),
    }, actor);

    if (!result.ok) {
      return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    }

    return c.json({ data: result.value }, 201);
  });

  router.openapi(getMediaRoute, async (c) => {
    const signed = c.req.query("signed") === "true";

    // Signed URLs require authentication
    if (signed && !c.get("actor")) {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Authentication required for signed URLs." } },
        401,
      );
    }

    const actor = c.get("actor");
    const result = signed
      ? await kernel.services.media.getSignedUrl(c.req.param("id"), undefined, actor)
      : await kernel.services.media.getUrl(c.req.param("id"), actor);

    if (!result.ok) {
      return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    }

    return c.redirect(result.value, 302);
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(deleteMediaRoute, async (c) => {
    const actor = c.get("actor");
    if (!actor || (!actor.permissions.includes("media:write") && !actor.permissions.includes("*:*"))) {
      return c.json({ error: { code: "FORBIDDEN", message: "media:write permission required." } }, 403);
    }
    const result = await kernel.services.media.delete(c.req.param("id"), actor);
    if (!result.ok) {
      return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    }
    return c.json({ data: { deleted: true } });
  });

  // Attach requires media:write
  router.use("/attach", requirePerm("media:write"));

  // @ts-expect-error -- openapi handler union return type
  router.openapi(attachMediaRoute, async (c) => {
    const body = c.req.valid("json") as AttachMediaInput;
    const result = await kernel.services.media.attachToEntity(body, c.get("actor"));
    if (!result.ok) {
      return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    }
    return c.json({ data: { attached: true } }, 201);
  });

  return router;
}
