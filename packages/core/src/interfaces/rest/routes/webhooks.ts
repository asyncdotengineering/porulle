import { OpenAPIHono } from "@hono/zod-openapi";
import type { Kernel } from "../../../runtime/kernel.js";
import { createWebhookEndpointRoute, listWebhookEndpointsRoute, deleteWebhookEndpointRoute } from "../schemas/webhooks.js";
import { type AppEnv, mapErrorToResponse, mapErrorToStatus, requirePerm } from "../utils.js";

export function webhookRoutes(kernel: Kernel) {
  const router = new OpenAPIHono<AppEnv>();

  router.use("/*", requirePerm("webhooks:manage"));

  // @ts-expect-error -- openapi handler union return type
  router.openapi(createWebhookEndpointRoute, async (c) => {
    const body = c.req.valid("json") as Parameters<typeof kernel.services.webhooks.createEndpoint>[0];
    // Generate a default secret if none provided (Zod schema marks it optional for API convenience)
    if (!body.secret) {
      body.secret = `whsec_${crypto.randomUUID().replace(/-/g, "")}`;
    }
    const actor = c.get("actor");
    const result = await kernel.services.webhooks.createEndpoint(body, actor);
    if (!result.ok) {
      return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    }
    return c.json({ data: result.value }, 201);
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(listWebhookEndpointsRoute, async (c) => {
    const result = await kernel.services.webhooks.listEndpoints(c.get("actor"));
    if (!result.ok) {
      return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    }
    const sanitized = result.value.map(({ secret: _secret, ...rest }) => rest);
    return c.json({ data: sanitized });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(deleteWebhookEndpointRoute, async (c) => {
    const result = await kernel.services.webhooks.deleteEndpoint(
      c.req.param("id"),
      c.get("actor"),
    );
    if (!result.ok) {
      return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    }
    return c.json({ data: { deleted: true } });
  });

  return router;
}
