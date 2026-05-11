import type { TaskDefinition } from "../../kernel/jobs/types.js";
import { WebhookDeliveryWorker } from "./worker.js";
import type { WebhooksRepository } from "./repository/index.js";

const WEBHOOK_DELIVERY_RETRY_BACKOFF = {
  type: "exponential" as const,
  delay: 2000,
};

/**
 * Background task for async webhook delivery.
 *
 * Instead of blocking the HTTP response with inline webhook HTTP calls,
 * the deliverWebhooks hook enqueues this task. The job runner picks it up
 * and delivers asynchronously with retries.
 */
export const webhookDeliveryTask: TaskDefinition<{
  endpointId: string;
  endpointUrl: string;
  endpointSecret: string;
  eventName: string;
  payload: unknown;
}> = {
  slug: "webhooks/deliver",

  async handler({ input, ctx, job }) {
    const webhooksService = ctx.services.webhooks as {
      repository?: WebhooksRepository;
    };

    // Build a minimal worker — the repository is needed for delivery tracking
    const repository = webhooksService?.repository;
    if (!repository) {
      ctx.logger.warn("Webhook delivery skipped: no webhooks repository available");
      return { output: {} };
    }

    const worker = new WebhookDeliveryWorker({ repository });

    await worker.deliver({
      endpoint: {
        id: input.endpointId,
        url: input.endpointUrl,
        secret: input.endpointSecret,
      },
      eventName: input.eventName,
      payload: input.payload,
      jobAttempt: job?.attemptNumber ?? 1,
      jobMaxAttempts: job?.maxAttempts ?? 1,
      retryBackoff: WEBHOOK_DELIVERY_RETRY_BACKOFF,
    });

    return { output: {} };
  },

  retries: {
    attempts: 5,
    backoff: WEBHOOK_DELIVERY_RETRY_BACKOFF,
  },
};
