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
  channelEntityLinks,
  channelEntityMap,
  channelExportEvents,
  channelOrderExports,
  channelRefundEvents,
  channelRefundRequests,
  channelReturns,
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
   * never declared here. Read by `confineStores` so a consumer can resolve the caller from the
   * request — core's `actor.vendorId` cannot serve that purpose: core sources it from a column on
   * `user` that this deployment never writes, and sets it to `null` outright for API-key actors.
   */
  raw?: unknown;
};

export { ABSENT_ARCHIVE_FLOOR, ABSENT_ARCHIVE_FRACTION, planAbsentArchives } from "./deletion-policy.js";
export { channelOrderAddressSchema, channelSyncHash, withDistinctVariantSkus } from "./service.js";
export { resolveLiveCredentials, withLiveCredentials } from "./live-credentials.js";
export type { AbsentArchivePlan } from "./deletion-policy.js";
export { mockChannelConnector } from "./mock-connector.js";
export type { MockChannelConnectorOptions } from "./mock-connector.js";
export {
  ChannelConnectorService,
  HERO_IMAGE_BYTE_CAP,
  selectImportImages,
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
  CatalogDeferredMedia,
  CatalogMediaFailure,
  CatalogMediaFailureReason,
  CatalogPageConvergence,
  ImportImageSelection,
} from "./service.js";
export type {
  CatalogFieldMapping,
  CatalogFieldMappingInput,
  CatalogFieldMappingRow,
  CatalogFieldTarget,
} from "./catalog-field-mapping.js";

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
  AfterStoreConnected,
  BindConnectedStore,
  ChannelComplianceData,
  ChannelConnectorPluginOptions,
  ConfineStores,
  ConnectClaims,
  OnStoreCatalogChanged,
  StoreConnectActor,
  StoreReadContext,
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
  ChannelReturn,
  ChannelReturnView,
  ConnectedStore,
  StoreHealth,
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

/** The merchant's browser lands on `postConnectRedirect` with the outcome in the query string. */
function connectOutcome(postConnectRedirect: string, outcome: { connected: string } | { error: string; message: string }): Response {
  const url = new URL(postConnectRedirect);
  if ("connected" in outcome) {
    url.searchParams.set("connected", outcome.connected);
  } else {
    url.searchParams.set("connect_error", outcome.error);
    url.searchParams.set("connect_message", outcome.message);
  }
  return oauthRedirect(url.toString());
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

const refreshOrderInput = z.object({ orgId: z.string(), storeId: z.string(), remoteOrderId: z.string() });

const completeConnectInput = z.object({
  orgId: z.string(),
  storeId: z.string(),
  actor: z.object({ orgId: z.string(), userId: z.string(), claims: z.record(z.string(), z.string()) }),
});

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
        // Only stores a registered connector can reach: a reconcile for any other provider (the
        // seed's `manual` point-of-sale store) can only fail with "No connector registered".
        const providers = new Set((options.connectors ?? []).map((connector) => connector.providerId));
        const stores = (await ctx.db.select().from(connectedStores).where(and(eq(connectedStores.organizationId, orgId), eq(connectedStores.status, "connected"))))
          .filter((store) => providers.has(store.provider));
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
        // Cancelled before this ran: the store must never receive an order nobody is paying for.
        if (await service.isOrderClosed(orgId, orderId)) return { output: { state: "skipped", reason: "order closed" } };
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
      // One provider webhook delivery, applied off the request: Shopify gives a delivery five seconds,
      // and a product re-read plus convergence is not bounded by that. Serialized per store, so two
      // deliveries for one store apply in the order they were accepted.
      slug: "channel/apply-webhook",
      concurrency: { key: (input: Record<string, unknown>) => `webhook:${String(input.storeId)}` },
      handler: async ({ input, ctx }: { input: Record<string, unknown>; ctx: import("@porulle/core").TaskContext }) => {
        const service = new ChannelConnectorService(ctx.db, ctx.services, options);
        const result = await service.handleWebhook(String(input.orgId), String(input.storeId), {
          id: String(input.id),
          type: String(input.topic),
          data: input.data,
        });
        if (!result.ok) throw new Error(result.error);
        return { output: { processed: result.value.processed } };
      },
    },
    {
      // A read point found a store order not read for a while; its current state is applied as if
      // the delivery for it had arrived. Serialized with that store's deliveries.
      slug: "channel/refresh-order",
      concurrency: { key: (input: Record<string, unknown>) => `webhook:${String(input.storeId)}` },
      handler: async ({ input, ctx }: { input: Record<string, unknown>; ctx: import("@porulle/core").TaskContext }) => {
        const parsed = refreshOrderInput.parse(input);
        const service = new ChannelConnectorService(ctx.db, ctx.services, options);
        const result = await service.refreshRemoteOrder(parsed.orgId, parsed.storeId, parsed.remoteOrderId);
        if (!result.ok) throw new Error(result.error);
        return { output: result.value };
      },
    },
    {
      // The second half of a connect whose callback had to be answered at once (WooCommerce's): subscribe
      // the store and start its first import. Not retried: a failure leaves the store in `error` with
      // the reason the merchant reads, and reconnecting is the retry.
      slug: "channel/complete-connect",
      concurrency: { key: (input: Record<string, unknown>) => `connect:${String(input.storeId)}` },
      handler: async ({ input, ctx }: { input: Record<string, unknown>; ctx: import("@porulle/core").TaskContext }) => {
        const parsed = completeConnectInput.parse(input);
        const service = new ChannelConnectorService(ctx.db, ctx.services, options);
        const result = await service.completeConnect(parsed.orgId, parsed.storeId, parsed.actor);
        return { output: result.ok ? { status: result.value.status } : { error: result.code ?? "COMPLETE_CONNECT_FAILED", message: result.error } };
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
      { scope: "channels:manage", description: "Operate every store in the organization: backfills, pushes, conflicts, exports." },
      { scope: "channels:connect", description: "Connect, reconnect and disconnect the caller's own stores." },
    ],
    schema: () => ({
      connectedStores,
      channelEntityMap,
      channelEntityLinks,
      channelCatalogPushes,
      channelCatalogPushEvents,
      channelCatalogConflicts,
      channelCatalogConflictEvents,
      channelOrderExports,
      channelExportEvents,
      channelRefundRequests,
      channelReturns,
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
        .permission("channels:connect")
        .params(z.object({ provider: z.string().min(1) }))
        .query(z.object({ shop: z.string().min(1).optional(), store: z.string().min(1).optional() }))
        .handler(async ({ params, query, orgId, actor, raw }) => {
          const oauth = options.oauth;
          if (!oauth?.stateSecret || !oauth.postConnectRedirect) return oauthError(501, "OAUTH_NOT_CONFIGURED", "Channel OAuth is not configured.");
          const provider = params.provider!;
          const connector = service.getConnector(provider);
          if (!connector) return oauthError(404, "CONNECTOR_NOT_FOUND", `No connector registered for provider "${provider}".`);
          if (!connector.buildAuthUrl) return oauthError(501, "OAUTH_UNSUPPORTED", `Connector "${provider}" does not support OAuth onboarding.`);
          // The callback arrives with no session of its own; the store is bound to the user who started
          // here, carried in the signed state. A caller with no user (an API key) cannot start one.
          const userId = actor?.userId;
          if (!userId) return oauthError(403, "USER_REQUIRED", "Connecting a store needs a signed-in user.");
          const typed = String((query as { shop?: string; store?: string }).shop ?? (query as { store?: string }).store ?? "");
          // A connector that can look at the store first does, so the merchant is told what is wrong
          // here rather than landing on a broken page at their own site.
          let storeDomain: string | undefined;
          if (connector.probeStore) {
            const probed = await connector.probeStore(typed);
            if (!probed.ok) return connectOutcome(oauth.postConnectRedirect, { error: probed.error.code, message: probed.error.message });
            storeDomain = probed.value.storeDomain;
          } else {
            storeDomain = connector.normalizeStoreDomain ? connector.normalizeStoreDomain(typed) : typed;
          }
          if (!storeDomain) return connectOutcome(oauth.postConnectRedirect, { error: "INVALID_STORE_DOMAIN", message: `"${typed}" does not name a ${provider} store.` });
          // Refused HERE, before the merchant reaches the provider: a grant issued for a shop retires
          // that shop's other grants, so a refusal at the callback would already have broken them.
          const claims = await service.connectClaims({ orgId, actor, raw, storeDomain });
          if (!claims.ok) return connectOutcome(oauth.postConnectRedirect, { error: claims.code ?? "CONNECT_REFUSED", message: claims.error });
          const state = signState({
            provider,
            orgId,
            userId,
            claims: claims.value,
            shopDomain: storeDomain,
            exp: Math.floor(Date.now() / 1000) + 600,
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
          if (!authUrl.ok) return connectOutcome(oauth.postConnectRedirect, { error: authUrl.error.code, message: authUrl.error.message });
          return oauthRedirect(authUrl.value);
        });

      // Two shapes of callback reach here. Shopify's is the merchant's BROWSER (GET): the connection
      // completes in the request and the browser lands on the outcome. WooCommerce's is the STORE
      // posting the keys (POST), and it deletes them on anything but a 200 or after 60 seconds, so
      // the keys are saved, the answer is immediate, and the rest runs as `channel/complete-connect`.
      // Its browser then returns separately (GET with `return=1`) and lands on the store's real state.
      const handleOAuthCallback = async ({ params, raw }: { params: Record<string, string>; raw: unknown }) => {
        const oauth = options.oauth;
        if (!oauth?.stateSecret || !oauth.postConnectRedirect) return oauthError(501, "OAUTH_NOT_CONFIGURED", "Channel OAuth is not configured.");
        const provider = params.provider!;
        const connector = service.getConnector(provider);
        if (!connector) return oauthError(404, "CONNECTOR_NOT_FOUND", `No connector registered for provider "${provider}".`);
        if (!connector.completeAuth) return oauthError(501, "OAUTH_UNSUPPORTED", `Connector "${provider}" does not support OAuth onboarding.`);
        const request = (raw as { req: { raw: Request } }).req.raw;
        const requestUrl = new URL(request.url);
        const posted = request.method === "POST";
        const state = requestUrl.searchParams.get("state");
        // A store posting keys is answered with a status it understands; a browser is sent to the outcome.
        const refused = (error: string, message: string, status = 400): Response => posted
          ? oauthError(status, error, message)
          : connectOutcome(oauth.postConnectRedirect, { error, message });
        if (!state) return refused("INVALID_OAUTH_STATE", "The connection was not started here, or its link was altered.");
        const verified = verifyState(state, oauth.stateSecret, Math.floor(Date.now() / 1000));
        if (!verified.ok || verified.value.provider !== provider) return refused("INVALID_OAUTH_STATE", "The connection link expired; start again.");
        if (!posted && requestUrl.searchParams.get("return") === "1") {
          if (requestUrl.searchParams.get("success") === "0") return refused("CONNECT_DECLINED", "You declined the connection in your store, so nothing was connected.");
          const landed = await service.storeByDomain(verified.value.orgId, provider, verified.value.shopDomain);
          if (!landed) return refused("CONNECT_NOT_RECEIVED", "Your store did not send its keys. Approve the connection again.");
          return connectOutcome(oauth.postConnectRedirect, { connected: landed.id });
        }
        const [consumed] = await db.insert(processedWebhookEvents).values({
          eventId: oauthStateEventId(verified.value.jti),
          provider: `oauth:${provider}`,
          eventType: "oauth_state",
        }).onConflictDoNothing().returning({ id: processedWebhookEvents.id });
        if (!consumed) return refused("OAUTH_STATE_REPLAYED", "This connection link was already used; start again.", 409);
        const completed = await connector.completeAuth(request, { storeDomain: verified.value.shopDomain, state });
        if (!completed.ok) return refused(completed.error.code, completed.error.message);
        if (completed.value.storeDomain !== verified.value.shopDomain) return refused("OAUTH_STORE_MISMATCH", "The store that answered is not the one the connection was started for.");
        const actor = { orgId: verified.value.orgId, userId: verified.value.userId, claims: verified.value.claims };
        const input = { provider, storeDomain: verified.value.shopDomain, credentials: completed.value.credentials };
        if (!posted) {
          const connected = await service.connectStore(verified.value.orgId, input, actor);
          if (!connected.ok) return refused(connected.code ?? "STORE_CONNECTION_FAILED", connected.error);
          return connectOutcome(oauth.postConnectRedirect, { connected: connected.value.id });
        }
        const saved = await service.saveConnectingStore(verified.value.orgId, input, actor);
        if (!saved.ok) return refused(saved.code ?? "STORE_CONNECTION_FAILED", saved.error, 409);
        await (ctx.services.jobs as JobsAdapter).enqueue("channel/complete-connect", { orgId: verified.value.orgId, storeId: saved.value.id, actor }, {
          organizationId: verified.value.orgId,
          concurrencyKey: `connect:${saved.value.id}`,
          supersedes: false,
        });
        return new Response(JSON.stringify({ data: { received: true } }), { status: 200, headers: { "content-type": "application/json" } });
      };

      channels.get("/oauth/{provider}/callback")
        .summary("Complete channel OAuth onboarding")
        .params(z.object({ provider: z.string().min(1) }))
        .handler(handleOAuthCallback);

      channels.post("/oauth/{provider}/callback")
        .summary("Receive channel OAuth credentials")
        .params(z.object({ provider: z.string().min(1) }))
        .handler(handleOAuthCallback);

      // Every delivery for a provider that signs per STORE (WooCommerce) arrives here. The answer is
      // 200 for anything verified, before any work: WooCommerce never retries a delivery, counts every
      // non-2xx (and every redirect) as a failure, and silently disables a subscription after repeated
      // failures. The work runs as a job, which retries through the queue, never through the store.
      channels.post("/webhooks/{storeId}")
        .summary("Receive a channel webhook")
        .params(z.object({ storeId: z.string().uuid() }))
        .handler(async ({ params, raw }) => {
          const context = raw as { req: { raw: Request }; json(data: unknown, status?: number): Response };
          const [store] = await db.select().from(connectedStores).where(eq(connectedStores.id, params.storeId!));
          if (!store || !store.webhookSecret) return context.json({ error: { code: "NOT_FOUND", message: "No store receives webhooks here." } }, 404);
          const connector = service.getConnector(store.provider);
          if (!connector?.verifyWebhook) return context.json({ error: { code: "NOT_FOUND", message: "This store's provider does not deliver per-store webhooks." } }, 404);
          const verified = await connector.verifyWebhook(store, context.req.raw);
          if (!verified.ok) return context.json({ error: { code: "UNAUTHORIZED", message: "Invalid webhook signature." } }, 401);
          // The unsigned ping a provider sends when a subscription is created carries nothing to do.
          if (verified.value === null) return context.json({ data: { received: true } });
          const delivery = verified.value;
          // The connector's key is unique within one store; the store id makes it unique here.
          const [marked] = await db.insert(processedWebhookEvents).values({ eventId: `${store.id}:${delivery.id}`, provider: store.provider, eventType: delivery.type }).onConflictDoNothing().returning({ id: processedWebhookEvents.id });
          if (!marked) return context.json({ data: { received: true, duplicate: true } });
          try {
            await (ctx.services.jobs as JobsAdapter).enqueue("channel/apply-webhook", { orgId: store.organizationId, storeId: store.id, id: delivery.id, topic: delivery.type, data: delivery.data }, {
              organizationId: store.organizationId,
              concurrencyKey: `webhook:${store.id}`,
              supersedes: false,
            });
          } catch (error) {
            await db.delete(processedWebhookEvents).where(eq(processedWebhookEvents.id, marked.id));
            return context.json({ error: { code: "WEBHOOK_NOT_ACCEPTED", message: error instanceof Error ? error.message : "The delivery could not be queued." } }, 503);
          }
          return context.json({ data: { received: true } });
        });

      // Every delivery for a provider that signs per APP — Shopify's catalogue, stock, order, uninstall
      // and mandatory compliance topics alike — arrives here, at the one address its app configuration
      // declares. Verified, deduplicated on the provider's delivery id, and handed to a job per store:
      // the answer must be quick, and the work is not.
      channels.post("/app-webhooks/{provider}")
        .summary("Receive a provider's app-level webhook")
        .params(z.object({ provider: z.string().min(1) }))
        .handler(async ({ params, raw }) => {
          const context = raw as { req: { raw: Request }; json(data: unknown, status?: number): Response };
          const provider = params.provider!;
          const connector = service.getConnector(provider);
          if (!connector?.verifyAppWebhook) return context.json({ error: { code: "NOT_FOUND", message: `No app-level webhooks for provider "${provider}".` } }, 404);
          const verified = await connector.verifyAppWebhook(context.req.raw);
          if (!verified.ok) return context.json({ error: { code: "UNAUTHORIZED", message: verified.error.message } }, 401);
          const event = verified.value;
          const [marked] = await db.insert(processedWebhookEvents).values({ eventId: event.id, provider, eventType: event.topic }).onConflictDoNothing().returning({ id: processedWebhookEvents.id });
          if (!marked) return context.json({ data: { received: true, duplicate: true } });
          const stores = (await service.getStoresByDomain(event.shopDomain)).filter((store) => store.provider === provider);
          const jobs = ctx.services.jobs as JobsAdapter;
          try {
            for (const store of stores) {
              await jobs.enqueue("channel/apply-webhook", { orgId: store.organizationId, storeId: store.id, id: event.id, topic: event.topic, data: event.data }, {
                organizationId: store.organizationId,
                concurrencyKey: `webhook:${store.id}`,
                supersedes: false,
              });
            }
          } catch (error) {
            // Not accepted: forget the delivery so the provider's retry is applied, not dropped as a duplicate.
            await db.delete(processedWebhookEvents).where(eq(processedWebhookEvents.id, marked.id));
            return context.json({ error: { code: "WEBHOOK_NOT_ACCEPTED", message: error instanceof Error ? error.message : "The delivery could not be queued." } }, 503);
          }
          return context.json({ data: { received: true, stores: stores.length } });
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
        .handler(async ({ input, orgId, actor, raw }: ChannelRouteContext) => {
          const requested = input as { provider: string; storeDomain: string };
          const normalize = service.getConnector(requested.provider)?.normalizeStoreDomain;
          const claims = unwrap(await service.connectClaims({ orgId, actor, raw, storeDomain: (normalize ? normalize(requested.storeDomain) : undefined) ?? requested.storeDomain }));
          return unwrap(await service.connectStore(
            orgId,
            input as {
              provider: string;
              credentials: Record<string, unknown>;
              storeDomain: string;
              webhookSecret?: string;
            },
            { orgId, userId: actor?.userId ?? null, claims, raw },
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
        .handler(async ({ params, orgId, actor, raw }: ChannelRouteContext) => unwrap(await service.getStore(orgId, params.id!, { orgId, actor, raw })));

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
        .handler(async ({ params, orgId, actor, raw }: ChannelRouteContext) => {
          unwrap(await service.reachableStore(orgId, params.storeId!, { orgId, actor, raw }));
          return unwrap(await service.getReconcileStatus(orgId, params.storeId!));
        });

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

      channels.post("/stores/{id}/health")
        .summary("Check a store's webhooks and key, repairing what can be repaired")
        .permission("channels:connect")
        .handler(async ({ params, orgId, actor, raw }: ChannelRouteContext) => unwrap(await service.checkStoreHealth(orgId, params.id!, { orgId, actor, raw })));

      channels.post("/stores/{id}/disconnect")
        .summary("Disconnect a channel store")
        .permission("channels:connect")
        .handler(async ({ params, orgId, actor, raw }: ChannelRouteContext) => unwrap(await service.disconnectStore(orgId, params.id!, { orgId, actor, raw })));

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

      channels.get("/returns")
        .summary("List the returns held on the platform that wait for their merchant")
        .permission("channels:connect")
        .handler(async ({ orgId, actor, raw }: ChannelRouteContext) => unwrap(await service.listReturns(orgId, { orgId, actor, raw })));

      channels.post("/returns/{id}/approve")
        .summary("Approve a held return: pay the shopper back and book the refund at the store")
        .permission("channels:connect")
        .input(z.object({ refundShipping: z.boolean().optional() }))
        .handler(async ({ params, orgId, actor, raw, input }: ChannelRouteContext) => {
          const options = z.object({ refundShipping: z.boolean().optional() }).catch({}).parse(input ?? {});
          return unwrap(await service.approveReturn(orgId, params.id!, { orgId, actor, raw }, options.refundShipping === undefined ? {} : { refundShipping: options.refundShipping }));
        });

      channels.post("/returns/{id}/decline")
        .summary("Decline a held return")
        .permission("channels:connect")
        .handler(async ({ params, orgId, actor, raw }: ChannelRouteContext) => unwrap(await service.declineReturn(orgId, params.id!, { orgId, actor, raw })));

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
