import { router } from "@porulle/core";
import { z } from "@hono/zod-openapi";
import type { GiftCardService } from "../services/gift-card-service.js";
import type { PluginRouteRegistration } from "@porulle/core";

export function buildPublicRoutes(
  service: GiftCardService,
  ctx: { services?: Record<string, unknown>; database?: { db: unknown } },
): PluginRouteRegistration[] {
  const r = router("Gift Cards", "/gift-cards", ctx);

  // ─── Check Balance (Public) ───────────────────────────────────────

  r.post("/check-balance")
    .summary("Check gift card balance")
    .description("Public endpoint — no authentication required. Rate-limited.")
    .input(
      z.object({
        code: z.string().min(4).max(30).describe("Gift card code (hyphens optional)"),
      }),
    )
    .handler(async ({ input }) => {
      const body = input as { code: string };
      // Public endpoint: codes are globally unique, no org scoping needed
      const result = await service.checkBalance("_any", body.code);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  return r.routes();
}
