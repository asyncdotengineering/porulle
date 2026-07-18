import { createHash } from "node:crypto";
import {
  CommerceConflictError,
  CommerceInvalidTransitionError,
  CommerceNotFoundError,
  CommerceValidationError,
  defineCommercePlugin,
  router,
  createSystemActor,
} from "@porulle/core";
import type { JobsAdapter, PluginResult, PluginRouteRegistration, TaskDefinition } from "@porulle/core";
import { z } from "@hono/zod-openapi";
import { and, eq } from "@porulle/core/drizzle";
import { processedWebhookEvents } from "@porulle/core/schema";
import {
  channelEntityMap,
  channelExportEvents,
  channelOrderExports,
  channelRefundEvents,
  channelRefundRequests,
  connectedStores,
} from "./schema.js";
import {
  ChannelConnectorService,
  type ChannelConnectorPluginOptions,
} from "./service.js";
import { buildHooks } from "./hooks.js";

type ChannelRouteContext = {
  input: unknown;
  params: Record<string, string>;
  orgId: string;
  actor: { userId: string } | null;
};

export { mockChannelConnector } from "./mock-connector.js";
export type { MockChannelConnectorOptions } from "./mock-connector.js";
export {
  ChannelConnectorService,
  canExportTransition,
} from "./service.js";
export type {
  ChannelConnectorPluginOptions,
  ChannelStockLine,
  ExportState,
  PublicConnectedStore,
  ReconcileReport,
} from "./service.js";
export type {
  ChannelEntityMapEntry,
  ChannelExportEvent,
  ChannelOrderExport,
  ChannelRefundEvent,
  ChannelRefundRequest,
  ConnectedStore,
} from "./schema.js";

function unwrap<T>(result: PluginResult<T>): T {
  if (result.ok) return result.value;
  switch (result.code) {
    case "NOT_FOUND":
      throw new CommerceNotFoundError(result.error);
    case "INVALID_TRANSITION":
      throw new CommerceInvalidTransitionError(result.error);
    case "CONFLICT":
      throw new CommerceConflictError(result.error);
    default:
      throw new CommerceValidationError(result.error);
  }
}

export function channelConnectorPlugin(options: ChannelConnectorPluginOptions = {}) {
  const jobs: TaskDefinition[] = [
    {
      slug: "channel/reconcile",
      concurrency: { key: (input: Record<string, unknown>) => String(input.storeId), supersedes: true },
      handler: async ({ input, ctx }: { input: Record<string, unknown>; ctx: import("@porulle/core").TaskContext }) => {
        const service = new ChannelConnectorService(ctx.db, ctx.services, options);
        const orgId = String(input.orgId);
        const result = await service.reconcile(orgId, String(input.storeId), createSystemActor(orgId));
        if (!result.ok) throw new Error(result.error);
        if (result.value.driftAlert) ctx.logger.warn("Channel reconciliation detected significant drift.", result.value);
        return { output: result.value };
      },
    },
    {
      slug: "channel/reconcile-sweep",
      handler: async ({ input, ctx }: { input: Record<string, unknown>; ctx: import("@porulle/core").TaskContext }) => {
        const orgId = String(input.orgId);
        const jobs = ctx.services.jobs as JobsAdapter;
        const stores = await ctx.db.select().from(connectedStores).where(and(eq(connectedStores.organizationId, orgId), eq(connectedStores.status, "connected")));
        const window = options.reconcileJitterWindowMs ?? 60 * 60 * 1000;
        for (const store of stores) {
          const offset = createHash("sha256").update(store.id).digest().readUInt32BE(0) % window;
          await jobs.enqueue("channel/reconcile", { orgId, storeId: store.id }, {
            organizationId: orgId,
            concurrencyKey: store.id,
            supersedes: true,
            delayMs: offset,
          });
        }
        return { output: { enqueued: stores.length } };
      },
    },
    {
      slug: "channel/import-catalog",
      concurrency: { key: (input: Record<string, unknown>) => String(input.storeId), supersedes: true },
      handler: async ({ input, ctx }: { input: Record<string, unknown>; ctx: import("@porulle/core").TaskContext }) => {
        const service = new ChannelConnectorService(ctx.db, ctx.services, options);
        const result = await service.importCatalog(String(input.orgId), String(input.storeId), createSystemActor(String(input.orgId)));
        if (!result.ok) throw new Error(result.error);
        return { output: { imported: result.value.imported, cursor: result.value.cursor } };
      },
    },
    {
      slug: "channel/sync-inventory",
      concurrency: { key: (input: Record<string, unknown>) => String(input.storeId) },
      handler: async ({ input, ctx }: { input: Record<string, unknown>; ctx: import("@porulle/core").TaskContext }) => {
        const service = new ChannelConnectorService(ctx.db, ctx.services, options);
        const result = await service.syncInventory(String(input.orgId), String(input.storeId), createSystemActor(String(input.orgId)));
        if (!result.ok) throw new Error(result.error);
        return { output: { synced: result.value.synced } };
      },
    },
    {
      slug: "channel/push-order",
      concurrency: { key: (input: Record<string, unknown>) => `push:${String(input.orderId)}:${String(input.storeId)}`, supersedes: true },
      handler: async ({ input, ctx }: { input: Record<string, unknown>; ctx: import("@porulle/core").TaskContext }) => {
        const service = new ChannelConnectorService(ctx.db, ctx.services, options);
        const orgId = String(input.orgId);
        const storeId = String(input.storeId);
        const orderId = String(input.orderId);
        const existing = await service.createExport(orgId, storeId, orderId);
        if (!existing.ok) throw new Error(existing.error);
        const slice = await service.buildOrderSlice(orgId, storeId, orderId);
        if (!slice.ok) {
          if (existing.value.state === "pending") await service.transitionExport(orgId, existing.value.id, "exported", "system", "Export attempt started.");
          await service.transitionExport(orgId, existing.value.id, "failed", "system", slice.error);
          return { output: { state: "failed" } };
        }
        const result = await service.exportOrder(orgId, storeId, slice.value, createSystemActor(orgId));
        if (!result.ok) throw new Error(result.error);
        return { output: { exportId: result.value.id, state: result.value.state } };
      },
    },
    {
      slug: "channel/reap-exports",
      handler: async ({ input, ctx }: { input: Record<string, unknown>; ctx: import("@porulle/core").TaskContext }) => {
        const service = new ChannelConnectorService(ctx.db, ctx.services, options);
        const result = await service.reapExports({
          definitiveMs: typeof input.definitiveMs === "number" ? input.definitiveMs : options.exportSla?.definitiveMs ?? 4 * 60 * 60 * 1000,
          transientMs: typeof input.transientMs === "number" ? input.transientMs : options.exportSla?.transientMs ?? 24 * 60 * 60 * 1000,
        });
        return { output: result };
      },
    },
  ];
  return defineCommercePlugin({
    id: "channel-connector",
    version: "1.0.0",
    permissions: [
      { scope: "channels:read", description: "Read connected stores and channel export status." },
      { scope: "channels:manage", description: "Connect stores and retry channel order exports." },
    ],
    schema: () => ({
      connectedStores,
      channelEntityMap,
      channelOrderExports,
      channelExportEvents,
      channelRefundRequests,
      channelRefundEvents,
    }),
    hooks: () => buildHooks(options),
    jobs: () => jobs,
    routes: (ctx) => {
      const db = ctx.database.db;
      if (!db) return [];
      const service = new ChannelConnectorService(
        db,
        ctx.services,
        options,
        ctx.database.transaction,
      );
      const channels = router("Channels", "/channels", ctx);

      channels.post("/webhooks/{storeId}")
        .summary("Receive a channel webhook")
        .handler(async ({ params, raw }) => {
          const context = raw as { req: { raw: Request; header(name: string): string | undefined }; json(data: unknown, status?: number): Response };
          const storeId = params.storeId!;
          const [store] = await db.select().from(connectedStores).where(eq(connectedStores.id, storeId));
          if (!store || !store.webhookSecret) return context.json({ error: { code: "UNAUTHORIZED", message: "Webhook store is not available." } }, 401);
          const connector = service.getConnector(store.provider);
          if (!connector) return context.json({ error: { code: "UNAUTHORIZED", message: "Webhook provider is not configured." } }, 401);
          const verified = await connector.verifyWebhook(store, context.req.raw);
          if (!verified.ok) return context.json({ error: { code: "UNAUTHORIZED", message: "Invalid webhook signature." } }, 401);
          const [inserted] = await db.insert(processedWebhookEvents).values({ eventId: verified.value.id, provider: store.provider, eventType: verified.value.type }).onConflictDoNothing().returning({ id: processedWebhookEvents.id });
          if (!inserted) return context.json({ data: { received: true, duplicate: true } });
          const handled = await service.handleWebhook(store.organizationId, store.id, verified.value);
          if (!handled.ok) return context.json({ error: { code: "WEBHOOK_PROCESSING_FAILED", message: handled.error } }, 422);
          return context.json({ data: { received: true } });
        });

      channels.post("/stores")
        .summary("Connect a channel store")
        .permission("channels:manage")
        .input(z.object({
          provider: z.string().min(1),
          credentials: z.record(z.string(), z.unknown()),
          storeDomain: z.string().min(1),
          webhookSecret: z.string().min(1).optional(),
        }))
        .handler(async ({ input, orgId }: ChannelRouteContext) => {
          return unwrap(await service.connectStore(
            orgId,
            input as {
              provider: string;
              credentials: Record<string, unknown>;
              storeDomain: string;
              webhookSecret?: string;
            },
          ));
        });

      channels.get("/stores")
        .summary("List connected channel stores")
        .permission("channels:read")
        .handler(async ({ orgId }: ChannelRouteContext) => unwrap(await service.listStores(orgId)));

      channels.get("/stores/{id}")
        .summary("Get a connected channel store")
        .permission("channels:read")
        .handler(async ({ params, orgId }: ChannelRouteContext) => unwrap(await service.getStore(orgId, params.id!)));

      channels.get("/stores/{storeId}/reconcile-status")
        .summary("Get channel reconciliation status")
        .permission("channels:read")
        .handler(async ({ params, orgId }: ChannelRouteContext) => unwrap(await service.getReconcileStatus(orgId, params.storeId!)));

      channels.post("/stores/{id}/disconnect")
        .summary("Disconnect a channel store")
        .permission("channels:manage")
        .handler(async ({ params, orgId }: ChannelRouteContext) => unwrap(await service.disconnectStore(orgId, params.id!)));

      channels.get("/exports/failed")
        .summary("List failed channel order exports")
        .permission("channels:read")
        .handler(async ({ orgId }: ChannelRouteContext) => unwrap(await service.listFailedExports(orgId)));

      channels.get("/refund-requests")
        .summary("List pending channel refund requests")
        .permission("channels:manage")
        .handler(async ({ orgId }: ChannelRouteContext) => unwrap(await service.listRefundRequests(orgId)));

      channels.post("/refund-requests/{id}/approve")
        .summary("Approve a channel refund request")
        .permission("channels:manage")
        .handler(async ({ params, orgId, actor }: ChannelRouteContext) => unwrap(await service.approveRefund(orgId, params.id!, actor!)));

      channels.post("/refund-requests/{id}/reject")
        .summary("Reject a channel refund request")
        .permission("channels:manage")
        .handler(async ({ params, orgId, actor }: ChannelRouteContext) => unwrap(await service.rejectRefund(orgId, params.id!, actor!)));

      channels.post("/exports/{id}/retry")
        .summary("Retry a failed channel order export")
        .permission("channels:manage")
        .handler(async ({ params, orgId, actor }: ChannelRouteContext) => unwrap(await service.retryExport(
          orgId,
          params.id!,
          actor!.userId,
        )));

      return channels.routes() as PluginRouteRegistration[];
    },
  });
}
