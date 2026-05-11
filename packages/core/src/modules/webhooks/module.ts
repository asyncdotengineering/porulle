import { defineModule } from "../../kernel/module/index.js";
import type { DrizzleDatabase } from "../../kernel/database/drizzle-db.js";
import { WebhooksRepository } from "./repository/index.js";
import { WebhookService } from "./service.js";
import {
  processedWebhookEvents,
  webhookDeliveries,
  webhookEndpoints,
} from "./schema.js";

export const webhooksModule = defineModule({
  id: "webhooks",
  schema: () => ({
    webhookEndpoints,
    processedWebhookEvents,
    webhookDeliveries,
  }),
  service: (deps) =>
    new WebhookService({
      repository: new WebhooksRepository(deps.db.db as DrizzleDatabase),
    }),
});
