import { router } from "@porulle/core";
import type { GiftCardService } from "../services/gift-card-service.js";
import type { PluginRouteRegistration } from "@porulle/core";
import { formatCode } from "../code-generator.js";

export function buildCustomerRoutes(
  service: GiftCardService,
  ctx: { services?: Record<string, unknown>; database?: { db: unknown } },
): PluginRouteRegistration[] {
  const r = router("Gift Cards (Customer)", "/me/gift-cards", ctx);

  // ─── List Customer's Gift Cards ───────────────────────────────────

  r.get("/")
    .summary("List my gift cards")
    .auth()
    .handler(async ({ actor, orgId }) => {
      if (!actor) throw new Error("Unauthorized");
      const result = await service.list(orgId, { purchaserId: actor.userId });
      if (!result.ok) throw new Error("Failed to list gift cards");
      return result.value.map((card) => ({
        ...card,
        displayCode: formatCode(card.code),
        // Mask the full code for security — show only last 4 chars
        maskedCode: `****-****-****-${card.code.slice(-4)}`,
      }));
    });

  return r.routes();
}
