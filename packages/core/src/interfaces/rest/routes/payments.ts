import { OpenAPIHono } from "@hono/zod-openapi";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { Kernel } from "../../../runtime/kernel.js";
import { type AppEnv, mapErrorToResponse, mapErrorToStatus } from "../utils.js";
import { processedWebhookEvents } from "../../../modules/webhooks/schema.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export function paymentRoutes(kernel: Kernel) {
  const router = new OpenAPIHono<AppEnv>();

  router.post("/webhook", async (c) => {
    const result = await kernel.services.payments.verifyWebhook(c.req.raw);
    if (!result.ok) {
      return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    }

    const event = result.value;
    const db = kernel.database.db as Db;

    // Atomic idempotency: INSERT ... ON CONFLICT DO NOTHING ... RETURNING
    // If the row already exists, RETURNING yields zero rows → duplicate.
    // If the row is new, RETURNING yields one row → process the event.
    // No TOCTOU race: the UNIQUE constraint on event_id is the single source of truth.
    const [inserted] = await db
      .insert(processedWebhookEvents)
      .values({
        eventId: event.id,
        provider: "stripe",
        eventType: event.type,
      })
      .onConflictDoNothing()
      .returning({ id: processedWebhookEvents.id });

    if (!inserted) {
      // Row already existed — this is a duplicate delivery
      return c.json({ data: { received: true, duplicate: true } });
    }

    // Process the event (first time only)
    if (event.type === "payment_intent.succeeded") {
      const data = event.data as Record<string, unknown> | undefined;
      const metadata = data?.metadata as Record<string, unknown> | undefined;
      if (typeof metadata?.orderId === "string") {
        await kernel.services.orders.changeStatus(
          {
            orderId: metadata.orderId,
            newStatus: "confirmed",
            reason: "stripe_webhook_payment_intent_succeeded",
          },
          null,
        );
      }
    }

    return c.json({ data: { received: true } });
  });

  return router;
}
