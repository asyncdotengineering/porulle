import { OpenAPIHono } from "@hono/zod-openapi";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { Kernel } from "../../../runtime/kernel.js";
import { type AppEnv, mapErrorToResponse, mapErrorToStatus } from "../utils.js";
import { processedWebhookEvents } from "../../../modules/webhooks/schema.js";
import type { Actor } from "../../../auth/types.js";
import { toCommerceError } from "../../../kernel/errors.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export function paymentRoutes(kernel: Kernel) {
  const router = new OpenAPIHono<AppEnv>();

  router.post("/webhook", async (c) => {
    const result = await kernel.services.payments.verifyWebhook(c.req.raw);
    if (!result.ok) {
      return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    }

    const event = result.value;
    const outcome = await kernel.database.transaction(async (transaction) => {
      const db = transaction as Db;

      // Claim and process in one transaction. If reconciliation throws, the
      // claim rolls back so Stripe can safely retry instead of receiving a
      // false 2xx for an event that never changed commerce state.
      const [inserted] = await db
        .insert(processedWebhookEvents)
        .values({
          eventId: event.id,
          provider: "stripe",
          eventType: event.type,
        })
        .onConflictDoNothing()
        .returning({ id: processedWebhookEvents.id });

      if (!inserted) return { duplicate: true };

      if (event.type === "payment_intent.succeeded") {
        const data = event.data as Record<string, unknown> | undefined;
        const metadata = data?.metadata as Record<string, unknown> | undefined;
        if (typeof metadata?.orderId === "string") {
          const actor: Actor = {
            type: "api_key",
            userId: "stripe-webhook",
            email: null,
            name: "Stripe webhook",
            vendorId: null,
            organizationId:
              typeof metadata.organizationId === "string"
                ? metadata.organizationId
                : null,
            role: "system",
            permissions: ["orders:update"],
          };
          const changed = await kernel.services.orders.changeStatus(
            {
              orderId: metadata.orderId,
              newStatus: "confirmed",
              reason: "stripe_webhook_payment_intent_succeeded",
            },
            actor,
            {
              tx: transaction,
              actor,
              requestId: c.get("requestId"),
            },
          );
          if (!changed.ok) throw toCommerceError(changed.error);
        }
      }

      return { duplicate: false };
    });

    return c.json({ data: { received: true, ...(outcome.duplicate ? { duplicate: true } : {}) } });
  });

  return router;
}
