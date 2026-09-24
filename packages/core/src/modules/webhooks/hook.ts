import { resolveOrgIdForCommerce } from "../../auth/org.js";
import type { AfterHook } from "../../kernel/hooks/types.js";
import type { InventoryAdjustManyResult } from "../inventory/service.js";

/**
 * Webhook delivery hook — enqueues delivery jobs instead of blocking.
 *
 * Previously, this hook made synchronous HTTP calls to each webhook endpoint
 * inside the request handler, blocking the response for seconds if endpoints
 * were slow or down.
 *
 * Now it enqueues a background job per endpoint. The job runner delivers
 * asynchronously with retries. The HTTP response returns immediately.
 */
export const deliverWebhooks: AfterHook<unknown> = async ({ result, operation, context }) => {
  const eventName = `${String(context.context.moduleName ?? "unknown")}.${operation}`;
  const webhooksService = context.services.webhooks as {
    getEndpointsForEvent(event: string, orgId: string): Promise<{ ok: boolean; value: Array<{ id: string; url: string; secret: string }> }>;
  };

  // VAPT r2 (codex) finding: fan-out queried ALL endpoints across the
  // database, so Tenant B's webhooks fired on Tenant A's events —
  // payload-level cross-tenant data leak. Now scoped to the actor's org.
  const orgId = resolveOrgIdForCommerce(context.actor, context.commerceConfig);

  const endpoints = await webhooksService.getEndpointsForEvent(eventName, orgId);
  if (!endpoints.ok) return;

  for (const endpoint of endpoints.value) {
    await context.jobs.enqueue("webhooks/deliver", {
      endpointId: endpoint.id,
      endpointUrl: endpoint.url,
      endpointSecret: endpoint.secret,
      eventName,
      payload: result,
    }, {
      organizationId: orgId,
      maxAttempts: 5,
      queue: "webhooks",
    });
  }
};

/**
 * `inventory.afterAdjustMany` — a page of changed levels. Subscribers get exactly what
 * `inventory.afterAdjust` gave them: one `inventory.update` event per changed level, per endpoint.
 * Only the endpoint lookup is shared across the page.
 */
export const deliverWebhooksForAdjustMany: AfterHook<InventoryAdjustManyResult> = async ({ result, operation, context }) => {
  const eventName = `${String(context.context.moduleName ?? "unknown")}.${operation}`;
  const webhooksService = context.services.webhooks as {
    getEndpointsForEvent(event: string, orgId: string): Promise<{ ok: boolean; value: Array<{ id: string; url: string; secret: string }> }>;
  };
  const orgId = resolveOrgIdForCommerce(context.actor, context.commerceConfig);
  const levels = result.entities.flatMap((entity) => entity.levels);
  if (levels.length === 0) return;
  const endpoints = await webhooksService.getEndpointsForEvent(eventName, orgId);
  if (!endpoints.ok) return;
  for (const endpoint of endpoints.value) {
    for (const level of levels) {
      await context.jobs.enqueue("webhooks/deliver", {
        endpointId: endpoint.id,
        endpointUrl: endpoint.url,
        endpointSecret: endpoint.secret,
        eventName,
        payload: level,
      }, {
        organizationId: orgId,
        maxAttempts: 5,
        queue: "webhooks",
      });
    }
  }
};
