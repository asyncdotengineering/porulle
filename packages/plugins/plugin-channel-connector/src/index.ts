import { createHash } from "node:crypto";
import {
  CommerceConflictError,
  CommerceInvalidTransitionError,
  CommerceNotFoundError,
  CommerceValidationError,
  defineCommercePlugin,
  router,
  createSystemActor,
  isValidFieldPath,
  requireUserId,
  TaskNonRetryableError,
} from "@porulle/core";
import type { FieldPath, JobsAdapter, PluginResult, PluginRouteRegistration, TaskDefinition } from "@porulle/core";
import { z } from "@hono/zod-openapi";
import { and, eq } from "@porulle/core/drizzle";
import { processedWebhookEvents } from "@porulle/core/schema";
import {
  channelCatalogPushEvents,
  channelCatalogPushes,
  channelCatalogConflicts,
  channelCatalogConflictEvents,
  channelEntityMap,
  channelExportEvents,
  channelOrderExports,
  channelRefundEvents,
  channelRefundRequests,
  connectedStores,
} from "./schema.js";
import {
  ChannelConnectorService,
  catalogPushConcurrencyKey,
  CHANNEL_INVENTORY_MAX_ITEMS_PER_INVOCATION,
  type CatalogConflictState,
  type ChannelComplianceData,
  type ChannelConnectorPluginOptions,
} from "./service.js";
import { buildHooks } from "./hooks.js";
import { oauthStateEventId, signState, verifyState } from "./oauth-state.js";

type ChannelRouteContext = {
  input: unknown;
  query?: unknown;
  params: Record<string, string>;
  orgId: string;
  actor: { userId: string | null } | null;
  /**
   * Core's documented request escape hatch, already present on `RouteHandlerContext` and simply
   * never declared here. Read by `confineStoreReads` so a consumer can resolve the caller from the
   * request — core's `actor.vendorId` cannot serve that purpose: core sources it from a column on
   * `user` that this deployment never writes, and sets it to `null` outright for API-key actors.
   */
  raw?: unknown;
};

export { mockChannelConnector } from "./mock-connector.js";
export type { MockChannelConnectorOptions } from "./mock-connector.js";
export {
  ChannelConnectorService,
  CATALOG_OUTBOUND_SUPPRESSION_WINDOW_MS,
  CATALOG_PUSH_BATCH_SIZES,
  CATALOG_PUSH_MAX_ATTEMPTS,
  canCatalogPushTransition,
  canExportTransition,
  catalogPushConcurrencyKey,
  catalogPushRetryDelayMs,
  CHANNEL_INVENTORY_MAX_ITEMS_PER_INVOCATION,
  isCatalogPushBreakerOpen,
} from "./service.js";
export {
  isValidCatalogMappingFieldPath,
  matchFieldPath,
  mergeCatalogFieldMapping,
  normalizeCatalogFieldMapping,
  compareCatalogFieldMappingSpecificity,
  providerCatalogFieldMappingDefaults,
  selectCatalogFieldMapping,
  validateCatalogMappingRow,
} from "./catalog-field-mapping.js";
export type {
  CatalogFieldMapping,
  CatalogFieldMappingInput,
  CatalogFieldMappingRow,
  CatalogFieldTarget,
} from "./catalog-field-mapping.js";
/** ~320 Neon HTTP subrequests per product against a 10,000 per-invocation cap → hard ceiling near 31; 20 leaves margin for heavier products. */
export const CHANNEL_IMPORT_MAX_ITEMS_PER_INVOCATION = 20;

/**
 * How many bounded batches one sweep may walk before it refuses rather than loops.
 *
 * A batched task walks its whole store inside ONE Workflow instance, so the ceiling that matters is
 * the Workflows steps-per-instance limit: 10,000 on Workers Paid by default, raisable to 25,000
 * (`limits.steps`), and 1,024 on Free. Every batch is one step. A 1,000-product merchant is roughly
 * 650 inventory batches, so this bound is about eight times the largest real sweep and still an
 * order of magnitude under the platform default — it exists to turn a cursor that stops advancing
 * into a loud failure, not to ration normal work.
 *
 * It is NOT the limit that used to kill these sweeps. That was the request-chain depth of 32 Worker
 * invocations, which a self-enqueueing continuation spends one of per batch; see the comment on the
 * sweep loop below.
 */
export const CHANNEL_MAX_BATCHES_PER_SWEEP = 5_000;

/** What one bounded batch reports back: whether the store is drained, how much work it did, and
 *  where it stopped. Everything here crosses a durable-step boundary, so it must stay JSON. */
import type { CatalogConvergenceFailure } from "./service.js";

interface BatchOutcome {
  exhausted: boolean;
  counted: number;
  cursor: unknown;
  warnings?: string[];
  /**
   * The entities this batch committed, in input order, failures excluded — so the caller can emit
   * ONE message naming the page instead of one enqueue per product.
   *
   * Optional in the type and unconditional in the value the service returns. `undefined` means no
   * batch produced an outcome (the initial `last` below, or a plugin build that predates this
   * field); `[]` means a batch ran and committed nothing. A caller that collapses those two enqueues
   * nothing and reports success.
   */
  entityIds?: string[];
  /** The items that did not land, so the caller can record them against the run rather than drop them. */
  failures?: CatalogConvergenceFailure[];
}

/**
 * Walks a store's bounded batches to exhaustion INSIDE THE CALLING INSTANCE, one durable step per
 * batch.
 *
 * WHY THIS SHAPE, in arithmetic rather than in adjectives. Each batch used to create its successor
 * by calling `jobs.enqueue` from inside its own running Workflow instance. Cloudflare caps a single
 * request chain at **32 Worker invocations** ("A single request has a maximum of 32 Worker
 * invocations, and each call to a Service binding counts towards this limit" — Service bindings,
 * Runtime APIs), and a continuation created inside its predecessor spends one, permanently. Two
 * deaths on the deployed Worker on 2026-09-15, same error, same step (`porulle-turn:acquire:0`, the
 * coordinator call, the chain's FIRST step):
 *
 *   chain begun inside the catalog import   -> died after 18 batches, at offset 360
 *   chain begun from a fetch handler        -> died after 30 batches, at offset 960
 *
 * 18 + the ~14 the import had already spent ≈ 32; 30 + 2 ≈ 32. What varied was never the volume of
 * work — it was the depth the chain STARTED at, which is why this read as an unreproducible "batch
 * 7 one day, batch 37 the next" for three sessions. gflock-100 needs 65 inventory batches. **No
 * chain survives a catalog of any real size at any batch size, and halving the batch doubles the
 * chain**, which is why the intuitive fix is backwards.
 *
 * A `ctx.step.do` is not an invocation of another Worker. It spends no chain depth, so the walk
 * below is flat however many batches it takes. Do not reintroduce an enqueue of the same slug here:
 * that is the defect, and it looks like a one-line convenience.
 *
 * THE BUDGET PER BATCH GOT BIGGER, NOT SMALLER. A Workflow step's default timeout is 10 minutes
 * (Workflows → Sleeping and retrying: limit 5, 10 s delay, exponential backoff, 10-minute timeout),
 * which is exactly the budget the WHOLE sweep used to have — instance 1428d7e0 died on it with
 * `WorkflowTimeoutError: Execution timed out after 600000ms`, having written 232 of ~1,299 levels.
 * Each batch now gets that budget on its own, and a failed batch retries alone from the cursor its
 * predecessor persisted rather than restarting the store.
 *
 * THE NAME IS LOAD-BEARING. The engine keys a step by its name and replays the cached result for a
 * repeat, so a loop naming every step the same finishes instantly, reports success, and writes one
 * batch. The batch index in the name is the only thing preventing that, and
 * `batched-tasks-do-not-chain.test.ts` asserts the names are distinct.
 */
async function walkBatches(
  ctx: import("@porulle/core").TaskContext,
  label: string,
  storeId: string,
  runBatch: () => Promise<BatchOutcome>,
): Promise<{ counted: number; batches: number; last: BatchOutcome; warnings: string[] }> {
  let counted = 0;
  let batches = 0;
  const warnings: string[] = [];
  let last: BatchOutcome = { exhausted: true, counted: 0, cursor: null };
  // `ctx.step` is absent on engines that have not wired one (pg-boss, Inngest, Trigger). Running
  // the batch inline there is the same walk without durability — which is exactly what the drizzle
  // engine's own pass-through step does — so the plugin keeps working rather than throwing on a
  // property it only needs for resumability.
  const step = ctx.step ?? { do: <T,>(_name: string, fn: () => Promise<T>) => fn() };

  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- batches are sequential by construction: each one resumes from the cursor the previous one persisted.
    last = await step.do(`${label}:${storeId}:batch:${batches}`, runBatch);
    counted += last.counted;
    if (last.warnings) warnings.push(...last.warnings);
    batches += 1;
    if (last.exhausted) return { counted, batches, last, warnings };
    if (batches >= CHANNEL_MAX_BATCHES_PER_SWEEP) {
      // A cursor that stops advancing would otherwise spin until the step budget ran out and
      // report nothing useful. Refusing names the store and the count, which is what an operator
      // needs to tell "enormous catalog" from "cursor stuck".
      throw new TaskNonRetryableError(
        `channel/${label} for store ${storeId} did not exhaust within ${CHANNEL_MAX_BATCHES_PER_SWEEP} batches `
          + `(${counted} items walked). Either the catalog is larger than this sweep supports or the cursor is not advancing.`,
      );
    }
  }
}

export { signState, verifyState } from "./oauth-state.js";
export type {
  BackfillCatalogOptions,
  BackfillCatalogReport,
  BuildCatalogPushItemsOptions,
  BuildCatalogPushItemsResult,
  CatalogPushAssemblyField,
  CatalogPushAssemblyImage,
  CatalogPushAssemblyItem,
  CatalogPushPreviewBefore,
  CatalogPushPreviewBeforeStatus,
  CatalogPushPreviewDiff,
  CatalogPushPreviewItem,
  CatalogPushPreviewResult,
  CatalogPushPreviewUnavailable,
  PushCatalogToStoreResult,
  CatalogPushJobResult,
  CatalogConvergenceFailure,
  CatalogFieldConflict,
  CatalogFieldSkip,
  CatalogPushFieldSkip,
  CatalogPushSkipReason,
  CatalogConflictState,
  CatalogWriteSettings,
  ChannelComplianceData,
  ChannelConnectorPluginOptions,
  ChannelStockLine,
  ExportState,
  PublicConnectedStore,
  ReconcileReport,
} from "./service.js";
export type { OAuthStatePayload, OAuthStateResult } from "./oauth-state.js";
export type {
  ChannelCatalogPush,
  ChannelCatalogPushEvent,
  ChannelCatalogConflict,
  ChannelCatalogConflictEvent,
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
      durableSteps: true,
      handler: async ({ input, ctx }: { input: Record<string, unknown>; ctx: import("@porulle/core").TaskContext }) => {
        const service = new ChannelConnectorService(ctx.db, ctx.services, options);
        const orgId = String(input.orgId);
        const storeId = String(input.storeId);
        const result = await walkBatches(
          ctx,
          "import-catalog",
          storeId,
          async () => {
            const page = await service.importCatalog(orgId, storeId, createSystemActor(orgId), {
              maxItems: CHANNEL_IMPORT_MAX_ITEMS_PER_INVOCATION,
            });
            if (!page.ok) throw new Error(page.error);
            return {
              exhausted: page.value.exhausted,
              counted: page.value.imported,
              cursor: page.value.cursor ?? null,
              ...(page.value.warnings ? { warnings: page.value.warnings } : {}),
              // UNCONDITIONAL, unlike `warnings` and `failures` beside it. The step's return value is
              // the only per-batch seam a host application has — `walkBatches` keeps just `last` — so
              // this is where a page gets its identity. Omitting it when empty would make "this batch
              // committed nothing" and "this plugin build does not report entities" the same
              // `undefined` at the seam, and a caller that collapses those enqueues nothing and
              // reports success. The service's own return declares it unconditional for the same
              // reason; dropping it here would have undone that one line later.
              entityIds: page.value.entityIds,
              ...(page.value.failures ? { failures: page.value.failures } : {}),
            };
          },
        );
        const jobs = ctx.services.jobs as JobsAdapter;
        // The catalog is always exhausted by the time the walk above returns, so this hand-off is
        // unconditional. It is the ONE enqueue this task is allowed: it starts a DIFFERENT task
        // once, spending a single level of the request chain's 32, rather than one per page the
        // way the continuation it replaced did.
        //
        // A finished catalog is not a usable one. `importCatalog` writes entities, variants and
          // prices and never touches `inventory_levels`, so a store whose sweep ends here has a
          // catalog in which every variant rolls up as out of stock — which is what a consumer
          // projection publishes and what a shopper is shown.
          //
          // Inventory used to arrive from `reconcile`, reachable only through the
          // `channel/reconcile-sweep` cron. A deployment that removes its crons therefore loses a
          // data-plane write silently, with every suite still green. Levelling inventory here keeps
          // it inside the one operator action — "import this store" — instead of behind a second
          // one somebody has to remember.
          await jobs.enqueue("channel/sync-inventory", { orgId, storeId }, {
            organizationId: orgId,
          concurrencyKey: storeId,
        });
        return {
          output: {
            imported: result.counted,
            cursor: result.last.cursor ?? null,
            exhausted: true,
            batches: result.batches,
            ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
          },
        };
      },
    },
    {
      slug: "channel/backfill-catalog",
      concurrency: { key: (input: Record<string, unknown>) => String(input.storeId) },
      handler: async ({ input, ctx }: { input: Record<string, unknown>; ctx: import("@porulle/core").TaskContext }) => {
        const service = new ChannelConnectorService(ctx.db, ctx.services, options);
        const orgId = String(input.orgId);
        const storeId = String(input.storeId);
        const dryRun = input.dryRun === true;
        const result = await service.backfillCatalog(orgId, storeId, createSystemActor(orgId), {
          dryRun,
          ...(input.restart === true ? { resume: false } : {}),
          ...(!dryRun ? { maxPages: 1 } : {}),
        });
        if (!result.ok) throw new Error(result.error);
        if (!result.value.complete && !dryRun) {
          const jobs = ctx.services.jobs as JobsAdapter;
          await jobs.enqueue("channel/backfill-catalog", { orgId, storeId, dryRun }, {
            organizationId: orgId,
            concurrencyKey: storeId,
            supersedes: false,
          });
        }
        return { output: result.value };
      },
    },
    {
      slug: "channel/sync-inventory",
      concurrency: { key: (input: Record<string, unknown>) => String(input.storeId) },
      durableSteps: true,
      handler: async ({ input, ctx }: { input: Record<string, unknown>; ctx: import("@porulle/core").TaskContext }) => {
        const service = new ChannelConnectorService(ctx.db, ctx.services, options);
        const orgId = String(input.orgId);
        const storeId = String(input.storeId);
        const result = await walkBatches(
          ctx,
          "sync-inventory",
          storeId,
          async () => {
            const batch = await service.syncInventory(orgId, storeId, createSystemActor(orgId), {
              maxItems: CHANNEL_INVENTORY_MAX_ITEMS_PER_INVOCATION,
            });
            if (!batch.ok) throw new Error(batch.error);
            // `exhausted` is optional on the sync result, and the shape this replaces read a
            // missing one as NOT exhausted (`if (!result.value.exhausted)` chained another batch).
            // Keeping that reading exactly: an absent flag continues, and a cursor that never
            // reports exhaustion is caught loudly by the batch ceiling rather than stopping the
            // sweep early and leaving the store half-levelled.
            return { exhausted: batch.value.exhausted === true, counted: batch.value.synced, cursor: null };
          },
        );
        return { output: { synced: result.counted, exhausted: true, batches: result.batches } };
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
      slug: "channel/push-catalog",
      concurrency: { key: catalogPushConcurrencyKey, supersedes: true },
      handler: async ({ input, ctx }: { input: Record<string, unknown>; ctx: import("@porulle/core").TaskContext }) => {
        const service = new ChannelConnectorService(ctx.db, ctx.services, options);
        const orgId = String(input.organizationId ?? input.orgId);
        const storeId = String(input.storeId);
        const entityIds = Array.isArray(input.entityIds)
          ? input.entityIds.map(String)
          : undefined;
        const forceFieldPaths = typeof input.forceFieldPaths === "object" && input.forceFieldPaths !== null
          ? Object.fromEntries(Object.entries(input.forceFieldPaths).flatMap(([entityId, paths]) => [
            [entityId, Array.isArray(paths) ? paths.filter((path): path is FieldPath => typeof path === "string" && isValidFieldPath(path)) : []],
          ]))
          : undefined;
        const cursor = typeof input.cursor === "string" ? input.cursor : undefined;
        const result = await service.executeCatalogPushJob(
          orgId,
          storeId,
          {
            ...(entityIds ? { entityIds } : {}),
            ...(forceFieldPaths ? { forceFieldPaths } : {}),
            ...(cursor ? { cursor } : {}),
          },
          createSystemActor(orgId),
          { jobs: ctx.services.jobs as JobsAdapter },
        );
        if (!result.ok) throw new Error(result.error);
        return { output: result.value };
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
      channelCatalogPushes,
      channelCatalogPushEvents,
      channelCatalogConflicts,
      channelCatalogConflictEvents,
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
          const stores = await service.getStoresByDomain(verified.value.shopDomain);
          if (stores.length === 0) return context.json({ data: { received: true } });
          let redacted = 0;
          let redactedSeen = false;
          let complianceData: ChannelComplianceData | undefined;
          for (const store of stores) {
            const handled = await service.handleWebhook(store.organizationId, store.id, { id: eventId, type: verified.value.topic, data: verified.value.data });
            if (!handled.ok) return context.json({ error: { code: "WEBHOOK_PROCESSING_FAILED", message: handled.error } }, 422);
            if (handled.value.redacted !== undefined) { redacted += handled.value.redacted; redactedSeen = true; }
            if (handled.value.data) {
              complianceData = complianceData
                ? { customer: complianceData.customer, exports: [...complianceData.exports, ...handled.value.data.exports] }
                : handled.value.data;
            }
          }
          return context.json({ data: {
            received: true,
            ...(complianceData ? { data: complianceData } : {}),
            ...(redactedSeen ? { redacted } : {}),
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
        .handler(async ({ orgId, actor, raw }: ChannelRouteContext) =>
          unwrap(await service.listStores(orgId, { orgId, actor, raw })));

      channels.get("/stores/{id}")
        .summary("Get a connected channel store")
        .permission("channels:read")
        .handler(async ({ params, orgId }: ChannelRouteContext) => unwrap(await service.getStore(orgId, params.id!)));

      channels.get("/stores/{storeId}/catalog-write")
        .summary("Get catalog write settings for a channel store")
        .permission("channels:manage")
        .handler(async ({ params, orgId }: ChannelRouteContext) => unwrap(await service.getCatalogWriteSettings(orgId, params.storeId!)));

      channels.put("/stores/{storeId}/catalog-write")
        .summary("Update catalog write settings for a channel store")
        .permission("channels:manage")
        .input(z.object({
          enabled: z.boolean().optional(),
          overrides: z.unknown().optional(),
        }).refine((value) => value.enabled !== undefined || value.overrides !== undefined))
        .handler(async ({ params, orgId, input }: ChannelRouteContext) => {
          const values = input as { enabled?: boolean; overrides?: unknown };
          if (values.overrides !== undefined) unwrap(await service.updateCatalogFieldMapping(orgId, params.storeId!, values.overrides));
          if (values.enabled !== undefined) unwrap(await service.updateCatalogWriteEnabled(orgId, params.storeId!, values.enabled));
          return unwrap(await service.getCatalogWriteSettings(orgId, params.storeId!));
        });

      channels.get("/stores/{storeId}/reconcile-status")
        .summary("Get channel reconciliation status")
        .permission("channels:read")
        .handler(async ({ params, orgId }: ChannelRouteContext) => unwrap(await service.getReconcileStatus(orgId, params.storeId!)));

      channels.get("/conflicts")
        .summary("List channel catalog conflicts")
        .permission("channels:read")
        .query(z.object({ storeId: z.string().min(1).optional(), state: z.enum(["open", "resolved"]).optional() }))
        .handler(async ({ query, orgId }: ChannelRouteContext) => {
          const values = query as { storeId?: string; state?: CatalogConflictState };
          return unwrap(await service.listCatalogConflicts(orgId, values.storeId, values.state));
        });

      channels.post("/conflicts/{id}/resolve")
        .summary("Resolve a channel catalog conflict")
        .permission("channels:manage")
        .params(z.object({ id: z.string().min(1) }))
        .input(z.object({ choose: z.enum(["platform", "store"]) }))
        .handler(async ({ params, orgId, input, actor }: ChannelRouteContext) => {
          const values = input as { choose: "platform" | "store" };
          return unwrap(await service.resolveCatalogConflict(orgId, params.id!, values.choose, actor!));
        });

      channels.post("/stores/{storeId}/backfill")
        .summary("Backfill a channel catalog into the PIM")
        .permission("channels:manage")
        .input(z.object({ dryRun: z.boolean().optional(), restart: z.boolean().optional() }))
        .handler(async ({ params, orgId, input }: ChannelRouteContext) => {
          const values = input as { dryRun?: boolean; restart?: boolean };
          if (values.dryRun === true) {
            return unwrap(await service.backfillCatalog(orgId, params.storeId!, createSystemActor(orgId), { dryRun: true }));
          }
          const jobs = ctx.services.jobs as JobsAdapter;
          await jobs.enqueue("channel/backfill-catalog", {
            orgId,
            storeId: params.storeId!,
            ...(values.restart === true ? { restart: true } : {}),
          }, {
            organizationId: orgId,
            concurrencyKey: params.storeId!,
            supersedes: false,
          });
          return { enqueued: true, storeId: params.storeId! };
        });

      channels.post("/stores/{storeId}/push-catalog")
        .summary("Enqueue a catalog push for a connected store")
        .permission("channels:manage")
        .input(z.object({ entityIds: z.array(z.string()).optional() }))
        .handler(async ({ params, orgId, input }: ChannelRouteContext) => {
          unwrap(await service.getStore(orgId, params.storeId!));
          const values = input as { entityIds?: string[] };
          const jobs = ctx.services.jobs as JobsAdapter;
          await jobs.enqueue("channel/push-catalog", {
            organizationId: orgId,
            storeId: params.storeId!,
            ...(values.entityIds ? { entityIds: values.entityIds } : {}),
          }, {
            organizationId: orgId,
            concurrencyKey: catalogPushConcurrencyKey({
              storeId: params.storeId!,
              ...(values.entityIds ? { entityIds: values.entityIds } : {}),
            }),
            supersedes: true,
          });
          return { enqueued: true, storeId: params.storeId! };
        });

      channels.post("/stores/{storeId}/push-catalog/preview")
        .summary("Preview a catalog push for a connected store")
        .permission("channels:manage")
        .input(z.object({ entityIds: z.array(z.string()).optional() }))
        .handler(async ({ params, orgId, input }: ChannelRouteContext) => {
          unwrap(await service.getStore(orgId, params.storeId!));
          const values = input as { entityIds?: string[] };
          return unwrap(await service.previewCatalogPush(orgId, params.storeId!, values.entityIds));
        });

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
        .handler(async ({ params, orgId, actor }: ChannelRouteContext) => unwrap(await service.approveRefund(orgId, params.id!, { userId: requireUserId(actor) })));

      channels.post("/refund-requests/{id}/reject")
        .summary("Reject a channel refund request")
        .permission("channels:manage")
        .handler(async ({ params, orgId, actor }: ChannelRouteContext) => unwrap(await service.rejectRefund(orgId, params.id!, { userId: requireUserId(actor) })));

      channels.post("/exports/{id}/retry")
        .summary("Retry a failed channel order export")
        .permission("channels:manage")
        .handler(async ({ params, orgId, actor }: ChannelRouteContext) => unwrap(await service.retryExport(
          orgId,
          params.id!,
          requireUserId(actor),
        )));

      return channels.routes() as PluginRouteRegistration[];
    },
  });
}
