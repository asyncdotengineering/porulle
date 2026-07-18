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
import { oauthStateEventId, signState, verifyState } from "./oauth-state.js";

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
export { signState, verifyState } from "./oauth-state.js";
export type {
  ChannelComplianceData,
  ChannelConnectorPluginOptions,
  ChannelStockLine,
  ExportState,
  PublicConnectedStore,
  ReconcileReport,
} from "./service.js";
export type { OAuthStatePayload, OAuthStateResult } from "./oauth-state.js";
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

function oauthError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function oauthRedirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

function callbackUri(raw: unknown, redirect: string, provider: string): string {
  const request = (raw as { req: { raw: Request } }).req.raw;
  const requestUrl = new URL(request.url);
  let origin = requestUrl.origin;
  try {
    const configured = new URL(redirect);
    if (configured.protocol === "http:" || configured.protocol === "https:") origin = configured.origin;
  } catch {
    origin = requestUrl.origin;
  }
  return new URL(`/api/channels/oauth/${provider}/callback`, origin).toString();
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

      channels.get("/oauth/{provider}/start")
        .summary("Start channel OAuth onboarding")
        .permission("channels:manage")
        .params(z.object({ provider: z.string().min(1) }))
        .query(z.object({ shop: z.string().min(1).optional(), store: z.string().min(1).optional() }))
        .handler(async ({ params, query, orgId, raw }) => {
          const oauth = options.oauth;
          if (!oauth?.stateSecret || !oauth.postConnectRedirect) return oauthError(501, "OAUTH_NOT_CONFIGURED", "Channel OAuth is not configured.");
          const provider = params.provider!;
          const connector = service.getConnector(provider);
          if (!connector) return oauthError(404, "CONNECTOR_NOT_FOUND", `No connector registered for provider "${provider}".`);
          if (!connector.buildAuthUrl) return oauthError(501, "OAUTH_UNSUPPORTED", `Connector "${provider}" does not support OAuth onboarding.`);
          const storeDomain = String((query as { shop?: string; store?: string }).shop ?? (query as { store?: string }).store ?? "");
          if (!storeDomain) return oauthError(400, "STORE_DOMAIN_REQUIRED", "The shop or store query parameter is required.");
          const state = signState({
            provider,
            orgId,
            shopDomain: storeDomain,
            exp: Math.floor(Date.now() / 1000) + 300,
            jti: crypto.randomUUID(),
          }, oauth.stateSecret);
          const redirect = callbackUri(raw, oauth.postConnectRedirect, provider);
          const authUrl = connector.buildAuthUrl({
            storeDomain,
            state,
            redirectUri: redirect,
            callbackUri: redirect,
            scopes: [],
          });
          if (!authUrl.ok) return oauthError(422, authUrl.error.code, authUrl.error.message);
          return oauthRedirect(authUrl.value);
        });

      const handleOAuthCallback = async ({ params, raw }: { params: Record<string, string>; raw: unknown }) => {
        const oauth = options.oauth;
        if (!oauth?.stateSecret || !oauth.postConnectRedirect) return oauthError(501, "OAUTH_NOT_CONFIGURED", "Channel OAuth is not configured.");
        const provider = params.provider!;
        const connector = service.getConnector(provider);
        if (!connector) return oauthError(404, "CONNECTOR_NOT_FOUND", `No connector registered for provider "${provider}".`);
        if (!connector.completeAuth) return oauthError(501, "OAUTH_UNSUPPORTED", `Connector "${provider}" does not support OAuth onboarding.`);
        const request = (raw as { req: { raw: Request } }).req.raw;
        const requestUrl = new URL(request.url);
        const state = requestUrl.searchParams.get("state");
        if (!state) return oauthError(403, "INVALID_OAUTH_STATE", "OAuth state is missing.");
        const landing = provider === "woocommerce" && request.method === "GET" && requestUrl.searchParams.get("return") === "1";
        const verified = verifyState(state, oauth.stateSecret, Math.floor(Date.now() / 1000), !landing);
        if (!verified.ok || verified.value.provider !== provider) return oauthError(403, "INVALID_OAUTH_STATE", "OAuth state is invalid or expired.");
        if (landing) return oauthRedirect(oauth.postConnectRedirect);
        const [consumed] = await db.insert(processedWebhookEvents).values({
          eventId: oauthStateEventId(verified.value.jti),
          provider: `oauth:${provider}`,
          eventType: "oauth_state",
        }).onConflictDoNothing().returning({ id: processedWebhookEvents.id });
        if (!consumed) return oauthError(403, "OAUTH_STATE_REPLAYED", "OAuth state has already been used.");
        const completed = await connector.completeAuth(request, { storeDomain: verified.value.shopDomain });
        if (!completed.ok) return oauthError(400, completed.error.code, completed.error.message);
        if (completed.value.storeDomain !== verified.value.shopDomain) return oauthError(400, "OAUTH_STORE_MISMATCH", "OAuth callback store does not match the signed state.");
        const connected = await service.connectStore(verified.value.orgId, {
          provider,
          storeDomain: verified.value.shopDomain,
          credentials: completed.value.credentials,
        });
        if (!connected.ok) return oauthError(422, connected.code ?? "STORE_CONNECTION_FAILED", connected.error);
        return oauthRedirect(oauth.postConnectRedirect);
      };

      channels.get("/oauth/{provider}/callback")
        .summary("Complete channel OAuth onboarding")
        .params(z.object({ provider: z.string().min(1) }))
        .handler(handleOAuthCallback);

      channels.post("/oauth/{provider}/callback")
        .summary("Receive channel OAuth credentials")
        .params(z.object({ provider: z.string().min(1) }))
        .handler(handleOAuthCallback);

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
          return context.json({ data: {
            received: true,
            ...(handled.value.data ? { data: handled.value.data } : {}),
            ...(handled.value.redacted !== undefined ? { redacted: handled.value.redacted } : {}),
          } });
        });

      channels.post("/compliance/{provider}")
        .summary("Receive a compliance webhook")
        .params(z.object({ provider: z.string().min(1) }))
        .handler(async ({ params, raw }) => {
          const context = raw as { req: { raw: Request; header(name: string): string | undefined }; json(data: unknown, status?: number): Response };
          const provider = params.provider!;
          const connector = service.getConnector(provider);
          if (!connector) return context.json({ error: { code: "NOT_FOUND", message: `No connector registered for provider "${provider}".` } }, 404);
          if (!connector.verifyAppWebhook) return context.json({ error: { code: "NOT_IMPLEMENTED", message: `Compliance webhook is not supported for provider "${provider}".` } }, 501);
          const verified = await connector.verifyAppWebhook(context.req.raw);
          if (!verified.ok) return context.json({ error: { code: "UNAUTHORIZED", message: verified.error.message } }, 401);
          const request = context.req.raw;
          const eventId = request.headers.get("x-shopify-event-id") ?? createHash("sha256").update(`${verified.value.topic}:${verified.value.shopDomain}:${JSON.stringify(verified.value.data)}`).digest("hex");
          const [inserted] = await db.insert(processedWebhookEvents).values({ eventId, provider, eventType: verified.value.topic }).onConflictDoNothing().returning({ id: processedWebhookEvents.id });
          if (!inserted) return context.json({ data: { received: true, duplicate: true } });
          const store = await service.getStoreByDomain(verified.value.shopDomain);
          if (!store) return context.json({ data: { received: true } });
          const handled = await service.handleWebhook(store.organizationId, store.id, { id: eventId, type: verified.value.topic, data: verified.value.data });
          if (!handled.ok) return context.json({ error: { code: "WEBHOOK_PROCESSING_FAILED", message: handled.error } }, 422);
          return context.json({ data: {
            received: true,
            ...(handled.value.data ? { data: handled.value.data } : {}),
            ...(handled.value.redacted !== undefined ? { redacted: handled.value.redacted } : {}),
          } });
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
