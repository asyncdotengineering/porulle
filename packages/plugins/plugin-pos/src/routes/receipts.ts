import { router } from "@porulle/core";
import { z } from "@hono/zod-openapi";
import type { ReceiptService } from "../services/receipt-service.js";
import type { PluginRouteRegistration } from "@porulle/core";

export function buildReceiptRoutes(
  service: ReceiptService,
  ctx: { services?: Record<string, unknown>; database?: { db: unknown } },
): PluginRouteRegistration[] {
  const r = router("POS Receipts", "/pos/transactions", ctx);

  r.get("/{id}/receipt")
    .summary("Get receipt")
    .permission("pos:operate")
    .handler(async ({ params, orgId }) => {
      const result = await service.getReceipt(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/{id}/receipt/email")
    .summary("Email receipt")
    .permission("pos:operate")
    .input(z.object({
      email: z.string().email(),
    }))
    .handler(async ({ params, input, orgId }) => {
      const body = input as { email: string };
      const result = await service.emailReceipt(orgId, params.id!, body.email);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  return r.routes();
}
