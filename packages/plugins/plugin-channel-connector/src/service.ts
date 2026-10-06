import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CHANNEL_CREDENTIALS_REJECTED,
  CHANNEL_OUT_OF_STOCK,
  CommerceInvalidTransitionError,
  CommerceNotFoundError,
  CommerceValidationError,
  Ok,
  PluginErr,
  createTxContext,
  createSystemActor,
  linkFieldPaths,
  removeEntityLinks,
  writeEntityLinks,
} from "@porulle/core";
import type {
  Actor,
  ChannelCancelOrderInput,
  EntityLinkRows,
  ChannelCatalogItem,
  ChannelConnector,
  ChannelEvent,
  ChannelShipment,
  ChannelWebhookEvent,
  ChannelOrderAddress,
  ChannelOrderSlice,
  ChannelPushCatalogField,
  ChannelPushCatalogImage,
  ChannelPushCatalogIntent,
  ChannelPushCatalogItem,
  ChannelPushCatalogItemOutcome,
  ChannelPushCatalogResult,
  ChannelStore,
  PluginDb,
  PluginResult,
  PluginTxFn,
  CatalogWriteContext,
  ImportProduct,
  ImportProductsOptions,
  ImportProductsReport,
  TxContext,
} from "@porulle/core";
import type { ChannelCatalogImage } from "@porulle/core";
import { isValidFieldPath, requireUserId } from "@porulle/core";
import type { FieldOwner, FieldPath } from "@porulle/core";
import type { JobsAdapter } from "@porulle/core";
import { CHANNEL_CONVERGENCE_CTX } from "./catalog-push-trigger.js";
import { resolveLiveCredentials, withLiveCredentials } from "./live-credentials.js";
import { and, desc, eq, inArray, isNull, lte, or, sql, type SQL } from "@porulle/core/drizzle";
import {
  brands,
  categories,
  customerAddresses,
  customers,
  entityBrands,
  entityCategories,
  entityMedia,
  entityTags,
  inventoryLevels,
  mediaAssets,
  optionTypes,
  optionValues,
  fulfillmentLineItems,
  fulfillmentRecords,
  orderLineItems,
  orderRefunds,
  orders,
  prices,
  sellableAttributes,
  sellableCustomFields,
  sellableEntities,
  sellableEntityRevisions,
  entityFieldDefinitions,
  tags,
  variants,
  variantOptionValues,
} from "@porulle/core/schema";
import type { SellableEntityRevisionSnapshot } from "@porulle/core/schema";
import { planAbsentArchives } from "./deletion-policy.js";
import {
  channelCatalogPushEvents,
  channelCatalogPushes,
  channelCatalogConflicts,
  channelCatalogConflictEvents,
  channelEntityLinks,
  channelEntityMap,
  channelExportEvents,
  channelOrderExports,
  connectedStores,
  channelRefundEvents,
  channelRefundRequests,
  channelReturns,
  type ChannelCatalogPush,
  type ChannelCatalogConflict,
  type ChannelOrderExport,
  type ChannelRefundRequest,
  type ChannelReturn,
  type ChannelReturnView,
  type ConnectedStore,
} from "./schema.js";
import type { StoreHealth } from "./schema.js";
import {
  mergeCatalogFieldMapping,
  normalizeCatalogFieldMapping,
  selectCatalogFieldMapping,
  type CatalogFieldMapping,
  type CatalogFieldMappingInput,
  type CatalogFieldTarget,
} from "./catalog-field-mapping.js";

export type ExportState = ChannelOrderExport["state"];
export type CatalogPushState = ChannelCatalogPush["state"];
export type CatalogConflictState = ChannelCatalogConflict["state"];

export const CATALOG_PUSH_BATCH_SIZES: Record<string, number> = {
  mock: 100,
  shopify: 50,
  woocommerce: 100,
};

const DEFAULT_CATALOG_PUSH_BATCH_SIZE = 50;
const CATALOG_PUSH_BREAKER_RETRY_MS = 60_000;
export const CATALOG_PUSH_MAX_ATTEMPTS = 8;

/**
 * How many inventory levels one `channel/sync-inventory` invocation may write before it persists a
 * resume position and hands off to its own continuation.
 *
 * The catalog's bound exists because a single invocation ran out of subrequests. This one exists
 * because a single invocation runs out of TIME: measured on the deployed Worker on 2026-09-14,
 * instance 1428d7e0, `channel/sync-inventory` was killed by `WorkflowTimeoutError: Execution timed
 * out after 600000ms` having written 232 of ~1,299 levels — 2.6 s per level, so a bound of 20 is
 * roughly 52 s of work and a 1,000-product merchant becomes ~650 bounded invocations instead of one
 * nine-hour one that discards everything if it fails.
 */
export const CHANNEL_INVENTORY_MAX_ITEMS_PER_INVOCATION = 20;

/**
 * The reason a platform order is cancelled under when its STORE cancelled it. The cancel hook skips
 * cancelling at the store for exactly this reason, so the two directions cannot loop.
 */
/** How stale a store order may be before a read point queues a refresh of it. */
export const REMOTE_ORDER_REFRESH_MS = 5 * 60 * 1000;

/** How often a merchant's visit may make the plugin call a store to check its health. */
export const STORE_HEALTH_INTERVAL_MS = 10 * 60 * 1000;
/** The `remote_return_id` of a return held on the platform, for a store with no returns of its own. */
export const PLATFORM_RETURN_PREFIX = "platform:";

export const CHANNEL_ORDER_CANCELLED_REASON = "channel_order_cancelled";

const CATALOG_PUSH_RETRY_BASE_MS = 60_000;
const CATALOG_PUSH_RETRY_MAX_MS = 60 * 60 * 1000;

export function catalogPushRetryDelayMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(CATALOG_PUSH_RETRY_BASE_MS * (2 ** exponent), CATALOG_PUSH_RETRY_MAX_MS);
}

export interface CatalogPushJobResult extends Record<string, unknown> {
  noop?: boolean;
  rescheduled?: boolean;
  complete?: boolean;
  cursor?: string;
  pushed?: number;
  failed?: number;
}

export function catalogPushConcurrencyKey(input: Record<string, unknown>): string {
  const storeId = String(input.storeId);
  const entityIds = input.entityIds;
  if (Array.isArray(entityIds) && entityIds.length === 1) {
    return `push:${String(entityIds[0])}:${storeId}`;
  }
  return `push-catalog:${storeId}`;
}

export function isCatalogPushBreakerOpen(breakerState: Record<string, unknown>): boolean {
  if (breakerState.open === true) {
    const openUntil = breakerState.openUntil;
    if (typeof openUntil === "string" && new Date(openUntil) <= new Date()) return false;
    return true;
  }
  const catalogPush = breakerState.catalogPush;
  if (!catalogPush || typeof catalogPush !== "object") return false;
  const state = catalogPush as { open?: boolean; openUntil?: string };
  if (state.open !== true) return false;
  if (typeof state.openUntil === "string" && new Date(state.openUntil) <= new Date()) return false;
  return true;
}

function catalogPushBatchSize(provider: string): number {
  return CATALOG_PUSH_BATCH_SIZES[provider] ?? DEFAULT_CATALOG_PUSH_BATCH_SIZE;
}

export interface ReconcileReport extends Record<string, unknown> {
  imported: number;
  converged: number;
  archived: number;
  inventoryUpdated: number;
  openConflicts: number;
  driftAlert: boolean;
  /** Why this reconcile archived nothing although mapped products were absent (`planAbsentArchives`). */
  refused?: string;
  skipped?: CatalogFieldSkip[];
  conflicts?: CatalogFieldConflict[];
  warnings?: string[];
  /** Items this reconcile could not converge, each with its error. A reconcile that dropped an
   *  item is never reported as a clean one. */
  failures?: CatalogConvergenceFailure[];
}

export interface CatalogFieldConflict {
  entityId: string;
  storeId: string;
  fieldPath: FieldPath;
  localValueSummary: string;
  remoteValueSummary: string;
}

interface DetectedCatalogFieldConflict extends CatalogFieldConflict {
  platformValue: unknown;
  storeValue: unknown;
}

export interface CatalogFieldSkip {
  entityId: string;
  fieldPath: FieldPath;
}

export type CatalogPushSkipReason = "no_mapping" | "held" | "store_owned" | "entity_not_active" | "unmapped_entity";

export interface CatalogPushFieldSkip {
  entityId: string;
  fieldPath: FieldPath;
  reason: CatalogPushSkipReason;
  value?: unknown;
  owner?: FieldOwner;
  target?: CatalogFieldTarget;
  remoteKey?: string;
}

export type PublicConnectedStore = Omit<ConnectedStore, "credentials" | "webhookSecret"> & {
  credentials: "[REDACTED]";
  webhookSecret: "[REDACTED]";
};

export interface CatalogWriteSettings {
  enabled: boolean;
  overrides: CatalogFieldMapping;
  merged: CatalogFieldMapping;
  warnings?: string[];
}

export interface ChannelComplianceData {
  customer: { id?: string; email?: string };
  exports: Array<{
    exportId: string;
    orderId: string;
    customerData: NonNullable<ChannelOrderExport["customerData"]>;
  }>;
}

/**
 * Which stores the caller may see and act on, resolved per request.
 *
 * Returning `null` means "do not confine" and is the default — every existing consumer keeps the
 * organization-wide behaviour. An array is the complete set of store ids this caller may reach, and
 * **`[]` means none**, not "no filter". Applied to the list AND to every route that names one store,
 * where a store outside the set answers NOT_FOUND — a refusal must not confirm the store exists.
 *
 * It takes IDS rather than a tenant, deliberately. `vendor`, `seller`, `team` are models a consumer
 * owns; this package is generic commerce and acquiring one of them here would push a marketplace
 * concept into every deployment that has no such thing. The consumer resolves the meaning and hands
 * back the answer.
 */
export type ConfineStores = (context: StoreReadContext) => Promise<readonly string[] | null> | readonly string[] | null;

/** Who connected a store: the signed-in user who started OAuth, or the caller of `POST /stores`. */
export interface StoreConnectActor {
  orgId: string;
  userId: string | null;
  /**
   * What the consumer's {@link ConnectClaims} resolved when the connection started — e.g. which of
   * the user's vendors the store is for. Carried in the signed OAuth state, so the callback, which has
   * no session or headers of its own, binds the store to exactly what was chosen at the start.
   */
  claims: Readonly<Record<string, string>>;
  /** Core's request escape hatch when the connect is a request; absent on the OAuth callback. */
  raw?: unknown;
}

/**
 * Resolves, from the request that STARTS a connection, the facts the consumer needs to bind the store
 * later. Throw to refuse the start — before the merchant is sent to the provider, which matters: a
 * provider such as Shopify retires a shop's other grants the moment a new one is issued, so a
 * connection refused only at the callback has already broken the shop's existing one. `storeDomain` is
 * the store being connected, canonicalised. Runs for OAuth start and for `POST /stores`.
 */
export type ConnectClaims = (context: StoreReadContext & { storeDomain: string }) => Promise<Record<string, string>> | Record<string, string>;

/**
 * Binds a just-connected store to whatever the consumer means by an owner, INSIDE the transaction
 * that wrote the store row — so a store and its binding commit together or not at all. Throw to
 * refuse the connection; the store row is rolled back with it.
 */
export type BindConnectedStore = (input: { db: PluginDb; store: ConnectedStore; actor: StoreConnectActor }) => Promise<void>;

/** Work that follows a committed connection: the first import, provider-attested facts, keys. */
export type AfterStoreConnected = (input: { store: ConnectedStore; actor: StoreConnectActor; connector: ChannelConnector; services: Record<string, unknown> }) => Promise<void>;

/** Entities a provider webhook just created or changed, converged; the host projects them. */
export type OnStoreCatalogChanged = (input: { orgId: string; storeId: string; entityIds: string[]; convergence: CatalogPageConvergence }) => Promise<void>;

/** What a consumer needs to resolve the caller. `raw` is core's documented request escape hatch. */
export interface StoreReadContext {
  orgId: string;
  actor: { userId: string | null; [key: string]: unknown } | null;
  raw: unknown;
}

export interface ChannelConnectorPluginOptions {
  connectors?: ChannelConnector[];
  /**
   * Confines stores to a set the consumer chooses. See {@link ConfineStores}.
   *
   * Absent by default, because narrowing an existing read for every deployment would be a breaking
   * change to a published package. A consumer that needs confinement opts in; one that does not is
   * unaffected.
   */
  confineStores?: ConfineStores;
  /** See {@link ConnectClaims}. Absent, a connection carries no claims. */
  connectClaims?: ConnectClaims;
  /** See {@link BindConnectedStore}. */
  bindConnectedStore?: BindConnectedStore;
  /** See {@link AfterStoreConnected}. */
  afterStoreConnected?: AfterStoreConnected;
  /** See {@link OnStoreCatalogChanged}. Absent, a webhook's products converge and nothing else runs. */
  onStoreCatalogChanged?: OnStoreCatalogChanged;
  /**
   * This deployment's public origin. Required for a connector that registers webhooks per store: a
   * provider delivers to an ABSOLUTE address, and a relative one is refused at connect.
   */
  publicUrl?: string;
  /**
   * `postConnectRedirect` is where the merchant's browser lands after OAuth, with `connected=<storeId>`
   * or `connect_error=<code>` appended — a browser flow ends on a page, never on a JSON error.
   */
  oauth?: { stateSecret: string; postConnectRedirect: string };
  inventoryTimeoutMs?: number;
  jobs?: JobsAdapter;
  exportSla?: { definitiveMs?: number; transientMs?: number };
  refundAutoMax?: number;
  newStoreDays?: number;
  driftAlertThreshold?: number;
  reconcileJitterWindowMs?: number;
  /**
   * When the order push fires. Default `"payment"`.
   *
   * - `"payment"` — an order created in `pending_payment` is NOT pushed; it is
   *   pushed when it leaves that state for anything but `cancelled`. An order
   *   created in `pending` is pushed on creation, as before, because a store
   *   with no payment step has no transition to hang the push on.
   * - `"create"` — the pre-0.40.0 trigger: push as soon as the order row exists,
   *   whatever its status.
   * - `false` — never push automatically; the consumer enqueues
   *   `channel/push-order` itself.
   */
  pushOrderOn?: ChannelPushTrigger;
}

/** When {@link ChannelConnectorPluginOptions.pushOrderOn} fires the order push. */
export type ChannelPushTrigger = "create" | "payment" | false;

export interface ChannelStockLine {
  entityId: string;
  variantId?: string;
  title?: string;
  quantity: number;
}

interface BackfillCounts {
  entitiesTouched: number;
  attributesCreated: number;
  mediaImported: number;
  variantsGivenOptionValues: number;
}

export interface BackfillCatalogReport extends BackfillCounts, Record<string, unknown> {
  cursor: string | null;
  complete: boolean;
  skipped?: CatalogFieldSkip[];
  conflicts?: CatalogFieldConflict[];
  warnings?: string[];
}

/**
 * One item the converge loop could not finish. `externalId` is the merchant's id, because the
 * entity may not exist yet and a caller reporting the failure has nothing else to name it by.
 */
export interface CatalogConvergenceFailure {
  externalId: string;
  error: string;
}

interface CatalogConvergenceStats {
  imported: number;
  converged: number;
  entitiesTouched: number;
  attributesCreated: number;
  mediaImported: number;
  variantsGivenOptionValues: number;
  consumed: number;
  skipped: CatalogFieldSkip[];
  conflicts: CatalogFieldConflict[];
  warnings: string[];
  /**
   * Items that failed. The batch CONTINUES past each one and counts it in `consumed`, so the
   * store cursor advances and a later page is still reached.
   *
   * It used to `return PluginErr` on the first failure, which returned before the cursor write in
   * `importCatalog` while the items already converged stayed committed. The retry then re-fetched
   * the same page, re-converged the same prefix and failed on the same item: one malformed product
   * halted the rest of a merchant's catalogue permanently. Saleor calls this choice
   * REJECT_FAILED_ROWS as against REJECT_EVERYTHING; this is the former.
   */
  failures: CatalogConvergenceFailure[];
  /**
   * The entities this batch actually COMMITTED, in input order, with failures excluded.
   *
   * It exists so a caller can name the page it just converged — one queue message carrying these
   * ids instead of one enqueue per product. Everything about that use makes the exact membership
   * load-bearing, so the ways it can be wrong are worth stating rather than discovering:
   *
   *  - **A failed item must not appear.** Every failure path above `continue`s before the push, so
   *    an id is added only after the item's last write. An id here that was never committed makes
   *    the consumer pay a model call for a row that does not exist.
   *  - **Order is input order.** The page message is rebuilt from this array, so a stable order is
   *    what makes the same page produce the same message on a Workflow retry.
   *  - **No duplicates.** A connector that returns one `externalId` twice in a page would otherwise
   *    put the same entity in the message twice, and the consumer would pay for it twice. The push
   *    is de-duplicated on first occurrence.
   *  - **It must stay JSON.** This crosses a durable step boundary as part of `BatchOutcome`.
   *  - **It is per BATCH, never accumulated across a walk.** `walkBatches` keeps only `last`, so a
   *    3,000-product store never builds a 3,000-element array against the 1 MiB step-result limit.
   */
  entityIds: string[];
}

type ImportResumePosition = { pageCursor: string | null; offset: number };

function parseImportResumePosition(raw: string | null | undefined): ImportResumePosition {
  if (!raw) return { pageCursor: null, offset: 0 };
  try {
    const parsed = JSON.parse(raw) as Partial<ImportResumePosition>;
    if (typeof parsed === "object" && parsed !== null && "offset" in parsed) {
      return {
        pageCursor: parsed.pageCursor ?? null,
        offset: typeof parsed.offset === "number" && parsed.offset >= 0 ? parsed.offset : 0,
      };
    }
  } catch {
    // Legacy bare page cursor.
  }
  return { pageCursor: raw, offset: 0 };
}

function encodeImportResumePosition(position: ImportResumePosition): string {
  return JSON.stringify(position);
}

type InventoryResumePosition = { offset: number; pageCursor?: string | null };

/** Resume position for bounded `syncInventory` — stored on `connected_stores.inventory_cursor`.
 *  Last-sync time lives on `connected_stores.lastSyncAt` (set when a run exhausts). */
function parseInventoryResumePosition(raw: string | null | undefined): InventoryResumePosition {
  if (!raw) return { offset: 0 };
  try {
    const parsed = JSON.parse(raw) as Partial<InventoryResumePosition>;
    if (typeof parsed === "object" && parsed !== null && "pageCursor" in parsed) {
      return { offset: 0, pageCursor: typeof parsed.pageCursor === "string" ? parsed.pageCursor : null };
    }
    if (typeof parsed === "object" && parsed !== null && "offset" in parsed) {
      return {
        offset: typeof parsed.offset === "number" && parsed.offset >= 0 ? parsed.offset : 0,
      };
    }
  } catch {
    // Legacy value was an ISO timestamp written when a sync completed.
  }
  return { offset: 0 };
}

function encodeInventoryResumePosition(position: InventoryResumePosition): string {
  return JSON.stringify(position);
}

export interface BackfillCatalogOptions {
  dryRun?: boolean;
  resume?: boolean;
  maxPages?: number;
}

export interface BuildCatalogPushItemsOptions {
  recordRevision?: boolean;
  forceFieldPaths?: Record<string, FieldPath[]>;
}

export interface CatalogPushAssemblyField extends ChannelPushCatalogField {
  target: CatalogFieldTarget;
}

export interface CatalogPushAssemblyImage extends ChannelPushCatalogImage {
  fieldPath: FieldPath;
  target: CatalogFieldTarget;
  remoteKey: string;
}

export interface CatalogPushAssemblyItem extends Omit<ChannelPushCatalogItem, "fields" | "images"> {
  fields: CatalogPushAssemblyField[];
  images?: CatalogPushAssemblyImage[];
}

export interface BuildCatalogPushItemsResult {
  items: CatalogPushAssemblyItem[];
  skipped: CatalogPushFieldSkip[];
  warnings: string[];
}

export interface PushCatalogToStoreResult extends ChannelPushCatalogResult {
  skipped: CatalogPushFieldSkip[];
  warnings: string[];
}

export interface CatalogPushPreviewUnavailable {
  status: "unavailable";
}

export type CatalogPushPreviewBefore = unknown | CatalogPushPreviewUnavailable;
export type CatalogPushPreviewBeforeStatus = "value" | "missing" | "unavailable";

export interface CatalogPushPreviewDiff {
  fieldPath: FieldPath;
  target: CatalogFieldTarget | null;
  remoteKey: string | null;
  before: CatalogPushPreviewBefore;
  beforeStatus: CatalogPushPreviewBeforeStatus;
  after: unknown;
  owner: FieldOwner;
  willWrite: boolean;
  reason?: CatalogPushSkipReason;
}

export interface CatalogPushPreviewItem {
  externalId: string;
  diffs: CatalogPushPreviewDiff[];
}

export interface CatalogPushPreviewResult {
  items: CatalogPushPreviewItem[];
  skipped: CatalogPushFieldSkip[];
  warnings: string[];
}

interface BackfillState {
  cursor: string | null;
  report: BackfillCounts;
  skipped?: CatalogFieldSkip[];
  conflicts?: CatalogFieldConflict[];
  warnings?: string[];
  completedAt?: string;
}

interface CatalogService {
  repository: {
    findRevisionMarkers(entityId: string, since?: Date): Promise<Array<{ createdAt: Date; reason: string }>>;
  };
  update(
    id: string,
    input: { slug?: string; status?: string; metadata?: Record<string, unknown>; isVisible?: boolean; customFields?: Record<string, unknown | null> },
    actor: Actor,
    ctx?: CatalogWriteContext,
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: { message: string } }>;
  archive(id: string, actor: Actor): Promise<{ ok: true; value: unknown } | { ok: false; error: { message: string } }>;
  create(
    input: {
      type: string;
      slug: string;
      sourceStoreId: string;
      metadata: Record<string, unknown>;
      status?: string;
      isVisible?: boolean;
    },
    actor: Actor,
    ctx?: TxContext,
  ): Promise<{ ok: true; value: { id: string } } | { ok: false; error: { message: string } }>;
  createVariant(
    input: { entityId: string; options: Record<string, string>; sku?: string; barcode?: string },
    actor: Actor,
  ): Promise<{ ok: true; value: { id: string } } | { ok: false; error: { message: string } }>;
  setAttributes(
    entityId: string,
    locale: string,
    attrs: {
      title: string;
      subtitle?: string;
      description?: string;
      richDescription?: unknown;
      seoTitle?: string;
      seoDescription?: string;
    },
    actor: Actor,
    ctx?: CatalogWriteContext,
  ): Promise<{ ok: true; value: undefined } | { ok: false; error: { message: string } }>;
  /** Moves the entity's updated_at and fires catalog.afterUpdate for a change to related rows. */
  notifyEntityChanged(entityId: string, changedFieldPaths: readonly string[], actor: Actor | null, ctx?: TxContext<PluginDb>): Promise<void>;
  recordEntityRevision(
    entityId: string,
    actor: Actor,
    reason: "import" | "push",
    ctx?: TxContext<PluginDb>,
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: { message: string } }>;
  resolveFieldOwners(entityId: string, storeId: string): Promise<Map<FieldPath, FieldOwner>>;
  setFieldOwner(
    entityId: string,
    fieldPath: FieldPath,
    storeId: string | null,
    owner: FieldOwner,
    actor: Actor | null,
  ): Promise<{ ok: true; value: undefined } | { ok: false; error: { message: string } }>;
  seedImportedFieldOwnership(entityId: string, storeId: string, fieldPaths: FieldPath[]): Promise<{ ok: true; value: undefined } | { ok: false; error: { message: string } }>;
  importProducts(
    page: ImportProduct[],
    options: ImportProductsOptions,
    actor: Actor,
  ): Promise<ServiceResult<ImportProductsReport>>;
  createOptionType(
    input: { entityId: string; name: string; values?: string[] },
    actor: Actor,
  ): Promise<{ ok: true; value: { id: string } } | { ok: false; error: { message: string } }>;
  createOptionValue(
    input: { optionTypeId: string; value: string },
    actor: Actor,
  ): Promise<{ ok: true; value: { id: string } } | { ok: false; error: { message: string } }>;
  createCategory(
    input: { slug: string },
    actor: Actor,
  ): Promise<{ ok: true; value: { id: string } } | { ok: false; error: { message: string } }>;
  addToCategory(
    entityId: string,
    categoryId: string,
    actor: Actor,
  ): Promise<{ ok: true; value: undefined } | { ok: false; error: { message: string } }>;
  createBrand(
    input: { slug: string; displayName: string },
    actor: Actor,
  ): Promise<{ ok: true; value: { id: string } } | { ok: false; error: { message: string } }>;
  addToBrand(
    entityId: string,
    brandId: string,
    actor: Actor,
  ): Promise<{ ok: true; value: undefined } | { ok: false; error: { message: string } }>;
}

type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { message: string; code?: string } };

interface MediaService {
  upload(
    input: {
      filename: string;
      contentType: string;
      data: ArrayBuffer;
      alt?: string;
      metadata?: Record<string, unknown>;
      origin?: "merchant" | "generated" | "imported";
    },
    actor: Actor,
  ): Promise<ServiceResult<{ id: string; url: string }>>;
  listEntityMedia(
    entityId: string,
    opts?: { variantId?: string; orgId?: string },
  ): Promise<ServiceResult<Array<{
    mediaAssetId: string;
    role: string;
    sortOrder: number;
    variantId: string | null;
    url: string;
    alt: string | null;
    contentType: string;
  }>>>;
}

interface PricingService {
  setBasePrice(
    input: { entityId: string; variantId?: string; currency: string; amount: number; compareAtAmount?: number | null },
    actor: Actor,
  ): Promise<ServiceResult<unknown>>;
}

const exportTransitions: Record<ExportState, readonly ExportState[]> = {
  pending: ["exported", "abandoned"],
  exported: ["confirmed", "failed", "abandoned"],
  confirmed: ["abandoned"],
  failed: ["exported", "abandoned"],
  abandoned: [],
};

export function canExportTransition(from: ExportState, to: ExportState): boolean {
  return exportTransitions[from].includes(to);
}

// Catalog pushes recur; confirmed/failed rows re-arm through exported, and rows with nothing to push resolve directly.
const catalogPushTransitions: Record<CatalogPushState, readonly CatalogPushState[]> = {
  pending: ["exported", "confirmed", "abandoned"],
  exported: ["confirmed", "failed", "abandoned"],
  confirmed: ["exported", "abandoned"],
  failed: ["exported", "confirmed", "abandoned"],
  abandoned: [],
};

export function canCatalogPushTransition(from: CatalogPushState, to: CatalogPushState): boolean {
  return catalogPushTransitions[from].includes(to);
}

/**
 * JSON with every object's keys sorted, recursively — the one form every hash here is taken over.
 *
 * The sync hash was `sha256(JSON.stringify(item))`, and JSON.stringify writes keys in insertion
 * order. The host's page consumer rebuilds each landed item in its own key order while reconcile
 * hashes the adapter's objects in theirs, so the fast path and reconcile hashed the SAME content
 * differently and reconcile re-converged every freshly imported product. Content, not key order,
 * is what a hash here must answer. `undefined` values are dropped exactly as JSON.stringify drops
 * them; array order is kept (it carries meaning: images, variants, options).
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => (entry === undefined ? "null" : canonicalJson(entry))).join(",")}]`;
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** THE sync hash: every path that records or compares a `channel_entity_map.sync_hash` uses this. */
/**
 * A product whose own variants repeat a SKU would break the `(source_store_id, sku)` unique key and
 * lose the whole product. Per item, group variants by SKU: the smallest externalId (string order)
 * keeps it, every other variant becomes `${sku}-${externalId}`. Deterministic, independent of
 * upstream order, and idempotent (a normalised item has no repeats left).
 *
 * Applied at the service's item intake — every `importCatalog` read and both converge entries — so
 * converge, the sync hash and reconcile's `applyUpstreamVariantIdentity` all see the same variants.
 * When only the host normalised, reconcile compared the stored suffixed SKU with the raw upstream one
 * and recorded a `variants.sku` conflict on every pass.
 */
export function withDistinctVariantSkus(item: ChannelCatalogItem): ChannelCatalogItem {
  const keeper = new Map<string, string>();
  for (const variant of item.variants) {
    if (variant.sku === undefined) continue;
    const held = keeper.get(variant.sku);
    if (held === undefined || variant.externalId < held) keeper.set(variant.sku, variant.externalId);
  }
  if (keeper.size === item.variants.filter((variant) => variant.sku !== undefined).length) return item;
  return {
    ...item,
    variants: item.variants.map((variant) =>
      variant.sku === undefined || keeper.get(variant.sku) === variant.externalId
        ? variant
        : { ...variant, sku: `${variant.sku}-${variant.externalId}` }),
  };
}

export function channelSyncHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

const hash = channelSyncHash;

/**
 * The suffix a store's product takes when its handle is already another store's slug: the first
 * label of the store domain (`kelly-felder.myshopify.com` → `kelly-felder`), slugified.
 */
export function storeSlugSuffix(storeDomain: string): string {
  const label = storeDomain.trim().toLowerCase().split(".")[0] ?? "";
  return label.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const SLUG_CONFLICT = /sellable_entities_org_slug_unique|Entity with slug .+ already exists|Slug ".+" already exists/;

/**
 * Whether a create or update lost a slug to another writer — core's pre-check message, or the
 * unique index itself, which a driver error can carry several `cause`s deep.
 */
export function isSlugConflict(error: unknown): boolean {
  let cursor: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof cursor === "string") return SLUG_CONFLICT.test(cursor);
    if (typeof cursor !== "object" || cursor === null) return false;
    if ("constraint" in cursor && cursor.constraint === "sellable_entities_org_slug_unique") return true;
    if ("message" in cursor && typeof cursor.message === "string" && SLUG_CONFLICT.test(cursor.message)) return true;
    cursor = "cause" in cursor ? cursor.cause : undefined;
  }
  return false;
}

/** Postgres 23505 anywhere in a driver error's `cause` chain. */
function isUniqueViolation(error: unknown): boolean {
  let cursor: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof cursor !== "object" || cursor === null) return false;
    if ("code" in cursor && cursor.code === "23505") return true;
    cursor = "cause" in cursor ? cursor.cause : undefined;
  }
  return false;
}

/** An upstream variant SKU the store could not take because another of its variants holds it. */
interface VariantSkuClash {
  variantExternalId: string;
  fromSku: string | null;
  toSku: string;
  heldByVariantId: string | null;
}

interface VariantIdentityOutcome {
  /** Items (by externalId) at least one of whose variants had its sku or barcode written. */
  written: Set<string>;
  /** Items (by externalId) with an upstream SKU that could not be taken, per variant. */
  clashes: Map<string, VariantSkuClash[]>;
  /** Entities that had an OPEN `variants.sku` conflict before this batch. */
  openSkuConflicts: Set<string>;
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
  return String(error);
}

/** Mid-import map rows carry this until convergence finishes; must not equal any real remote hash. */
const PENDING_ENTITY_MAP_SYNC_HASH = "";

export const CATALOG_OUTBOUND_SUPPRESSION_WINDOW_MS = 15 * 60 * 1000;

function normalizeCanonicalValue(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim();
  if (Array.isArray(value)) return value.map(normalizeCanonicalValue).sort((left, right) => (JSON.stringify(left) ?? "").localeCompare(JSON.stringify(right) ?? ""));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, normalizeCanonicalValue(nested)]));
  }
  return value;
}

function normalizedValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeCanonicalValue(left)) === JSON.stringify(normalizeCanonicalValue(right));
}

function snapshotCustomFieldValue(field: Record<string, unknown>): unknown {
  if (field.textValue !== null && field.textValue !== undefined) return field.textValue;
  if (field.numberValue !== null && field.numberValue !== undefined) return field.numberValue;
  if (field.booleanValue !== null && field.booleanValue !== undefined) return field.booleanValue;
  if (field.dateValue !== null && field.dateValue !== undefined) return field.dateValue;
  return field.jsonValue;
}

function snapshotFieldValue(
  snapshot: SellableEntityRevisionSnapshot,
  path: FieldPath,
): { found: boolean; value: unknown } {
  const [root, segment, field] = path.split(".");
  if (root === "entity" && segment === "slug") return { found: true, value: snapshot.entity.slug };
  if (root === "entity" && segment === "status") return { found: true, value: snapshot.entity.status };
  if (root === "entity" && segment === "metadata") {
    const metadata = snapshot.entity.metadata;
    return {
      found: true,
      value: metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>)[field ?? ""] : undefined,
    };
  }
  if (root === "attributes" && segment && field) {
    const attribute = snapshot.attributes.find((row) => row.locale === segment);
    return { found: true, value: attribute?.[field] };
  }
  if (root === "customFields" && segment && field) {
    const customField = snapshot.customFields.find((row) => row.fieldName === segment && row.locale === field && row.status === "approved");
    return { found: true, value: customField ? snapshotCustomFieldValue(customField) : undefined };
  }
  if (root === "media" && segment) {
    return {
      found: true,
      value: snapshot.media.filter((row) => row.role === segment).map((row) => row.mediaAssetId),
    };
  }
  return { found: false, value: undefined };
}

interface CanonicalOutboundField {
  fieldPath: string;
  value: unknown;
}

function canonicalHash(
  externalId: string,
  fieldPaths: FieldPath[],
  valueAtPath: (fieldPath: FieldPath) => unknown,
): string {
  const fields: CanonicalOutboundField[] = fieldPaths.flatMap((fieldPath) => {
    const value = valueAtPath(fieldPath);
    return value === undefined ? [] : [{ fieldPath, value: normalizeCanonicalValue(value) }];
  });
  return hash({
    externalId,
    fields: fields.sort((left, right) => left.fieldPath.localeCompare(right.fieldPath)),
  });
}

function outboundFieldPaths(item: ChannelPushCatalogItem): FieldPath[] {
  const paths = new Set<FieldPath>(item.fields.flatMap((field) => isValidFieldPath(field.fieldPath) ? [field.fieldPath] : []));
  for (const image of item.images ?? []) paths.add(`media.${image.role}`);
  return [...paths].sort();
}

function pushFieldValue(item: ChannelPushCatalogItem, fieldPath: FieldPath): unknown {
  if (fieldPath.startsWith("media.")) {
    const role = fieldPath.slice("media.".length);
    return (item.images ?? [])
      .filter((image) => image.role === role)
      .map((image) => ({ url: image.url, role: image.role }));
  }
  return item.fields.find((field) => field.fieldPath === fieldPath)?.value;
}

function canonicalOutboundHash(externalId: string, item: ChannelPushCatalogItem, fieldPaths: FieldPath[]): string {
  return canonicalHash(externalId, fieldPaths, (fieldPath) => pushFieldValue(item, fieldPath));
}

function canonicalInboundHash(
  externalId: string,
  fieldPaths: FieldPath[],
  remoteFieldValue: (path: FieldPath) => unknown,
): string {
  return canonicalHash(externalId, fieldPaths, remoteFieldValue);
}

function mergeMetadata(
  existing: Record<string, unknown> | null | undefined,
  remote: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(existing ?? {}), ...remote };
}

const attributeFields = ["title", "subtitle", "description", "richDescription", "seoTitle", "seoDescription"] as const;
const pushImageRoles = ["primary", "gallery", "thumbnail", "video", "document"] as const;

function customFieldValue(field: typeof sellableCustomFields.$inferSelect): unknown {
  switch (field.fieldType) {
    case "text":
    case "relation":
    case "select":
      return field.textValue;
    case "number":
      return field.numberValue;
    case "boolean":
      return field.booleanValue;
    case "date":
      return field.dateValue;
    case "json":
      return field.jsonValue;
    default:
      return null;
  }
}

function pushCatalogIntent(
  fieldPath: string,
  target: "native" | "attribute" | "meta",
): ChannelPushCatalogIntent {
  if (fieldPath.startsWith("customFields.") && target === "attribute") return "filterable";
  if (fieldPath.startsWith("customFields.") || fieldPath.startsWith("entity.metadata.")) return "tag";
  return "display";
}

function pushCatalogField(
  fieldPath: FieldPath,
  value: unknown,
  mapping: { target: "native" | "attribute" | "meta"; remoteKey: string },
): CatalogPushAssemblyField {
  const segments = fieldPath.split(".");
  const locale = fieldPath.startsWith("attributes.")
    ? segments[1]
    : fieldPath.startsWith("customFields.")
      ? segments[2]
      : undefined;
  return {
    fieldPath,
    intent: pushCatalogIntent(fieldPath, mapping.target),
    value,
    ...(locale !== undefined ? { locale } : {}),
    remoteKey: mapping.remoteKey,
    target: mapping.target,
  };
}

function pushCatalogImageRole(value: string): ChannelPushCatalogImage["role"] | undefined {
  return pushImageRoles.find((role) => role === value);
}

function importedFieldPaths(item: ChannelCatalogItem): FieldPath[] {
  const paths = new Set<FieldPath>(["entity.slug"]);
  if (item.status !== undefined) paths.add("entity.status");
  for (const key of Object.keys(item.metadata ?? {})) {
    const path = `entity.metadata.${key}`;
    if (isValidFieldPath(path)) paths.add(path);
  }
  const attributes = item.attributes?.length
    ? item.attributes
    : [{ locale: "en", title: item.title, ...(item.description !== undefined ? { description: item.description } : {}) }];
  for (const attribute of attributes) {
    for (const field of attributeFields) {
      if (attribute[field] !== undefined) paths.add(`attributes.${attribute.locale}.${field}`);
    }
  }
  const customFields = (item as ChannelCatalogItem & { customFields?: Record<string, Record<string, unknown>> }).customFields;
  for (const [name, locales] of Object.entries(customFields ?? {})) {
    if (!locales || typeof locales !== "object" || Array.isArray(locales)) continue;
    for (const locale of Object.keys(locales)) {
      const path = `customFields.${name}.${locale}`;
      if (isValidFieldPath(path)) paths.add(path);
    }
  }
  for (const image of item.images ?? []) paths.add(`media.${image.role}`);
  if (item.options?.length) paths.add("options");
  if (item.variants.some((variant) => variant.sku !== undefined)) paths.add("variants.sku");
  if (item.variants.some((variant) => variant.barcode !== undefined)) paths.add("variants.barcode");
  for (const currency of item.variants.flatMap((variant) => variant.prices ?? []).map((price) => price.currency)) {
    const path = `prices.${currency}`;
    if (isValidFieldPath(path)) paths.add(path);
  }
  return [...paths];
}

function summarizeValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return String(value);
  return serialized.length > 256 ? `${serialized.slice(0, 253)}...` : serialized;
}

function uniqueSkipped(skipped: CatalogFieldSkip[]): CatalogFieldSkip[] {
  const seen = new Set<string>();
  return skipped.filter((entry) => {
    const key = `${entry.entityId}:${entry.fieldPath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function ownerAllows(owners: Map<FieldPath, FieldOwner>, path: FieldPath): boolean {
  return owners.get(path) !== "platform";
}

function stockFailure(line: ChannelStockLine, reason: string): string {
  return `Cannot checkout line "${line.title ?? line.entityId}": ${reason}.`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Inventory lookup timed out.")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** What a host writes as an order's `metadata.shippingAddress`, in {@link ChannelOrderAddress}'s spelling. */
export const channelOrderAddressSchema = z.object({
  firstName: z.string(),
  lastName: z.string(),
  line1: z.string().min(1),
  line2: z.string().optional(),
  city: z.string().min(1),
  region: z.string().optional(),
  postalCode: z.string().optional(),
  countryCode: z.string().regex(/^[A-Z]{2}$/, "countryCode must be ISO 3166-1 alpha-2"),
  phone: z.string().optional(),
});

function withoutUndefined(address: z.infer<typeof channelOrderAddressSchema>): ChannelOrderAddress {
  const { line2, region, postalCode, phone, ...required } = address;
  return {
    ...required,
    ...(line2 !== undefined ? { line2 } : {}),
    ...(region !== undefined ? { region } : {}),
    ...(postalCode !== undefined ? { postalCode } : {}),
    ...(phone !== undefined ? { phone } : {}),
  };
}

function redactStore(store: ConnectedStore): PublicConnectedStore {
  return {
    id: store.id,
    organizationId: store.organizationId,
    provider: store.provider,
    credentials: "[REDACTED]",
    storeDomain: store.storeDomain,
    status: store.status,
    statusReason: store.statusReason,
    health: store.health,
    lastEventAt: store.lastEventAt,
    catalogWriteEnabled: store.catalogWriteEnabled,
    catalogFieldMapping: store.catalogFieldMapping,
    catalogCursor: store.catalogCursor,
    inventoryCursor: store.inventoryCursor,
    lastSyncAt: store.lastSyncAt,
    lastReconcileAt: store.lastReconcileAt,
    lastReconcileReport: store.lastReconcileReport,
    webhookSecret: "[REDACTED]",
    breakerState: store.breakerState,
    createdAt: store.createdAt,
    updatedAt: store.updatedAt,
  };
}

/**
 * A hero is streamed inside the page's own invocation, so it is bounded: a 30 MB TIFF a merchant
 * uploaded by mistake must not buffer into a 128 MiB isolate. Anything larger is reported, not
 * stored, and the product still lands — the index reads text first and media later.
 *
 * 4 MiB, not 1: at 1 MiB the cap refused ordinary product photographs — 16 of 100 Kelly Felder
 * heroes and 11 of 100 Arienti, all between 1 and 2 MiB, measured 2026-10-06 — and a product with
 * no photo is left out of every agent feed. Three in flight at 4 MiB stays far under the isolate.
 */
export const HERO_IMAGE_BYTE_CAP = 4 * 1024 * 1024;

export type CatalogMediaFailureReason = "too-large" | "download-failed" | "unsupported" | "storage";

export interface CatalogMediaFailure {
  externalId: string;
  imageExternalId?: string;
  url: string;
  reason: CatalogMediaFailureReason;
  detail: string;
}

/** Media the page did NOT fetch: the first photo of each variant the hero does not show. */
export interface CatalogDeferredMedia {
  externalId: string;
  entityId: string;
  images: ChannelCatalogImage[];
}

export interface CatalogPageConvergence extends Record<string, unknown> {
  created: number;
  unchanged: number;
  updated: number;
  /** Input order, failures excluded, no duplicates — the page message is rebuilt from this. */
  entityIds: string[];
  failures: CatalogConvergenceFailure[];
  heroesImported: number;
  mediaFailures: CatalogMediaFailure[];
  deferredMedia: CatalogDeferredMedia[];
  /** Fields the store's value did not overwrite because the platform owns them. */
  skipped: CatalogFieldSkip[];
  /** Shared fields both sides changed, held for an operator. */
  conflicts: CatalogFieldConflict[];
  warnings: string[];
}

export interface ImportImageSelection {
  hero: ChannelCatalogImage | null;
  /** In variant order; one image per variant the hero does not cover; no url twice. */
  perVariant: ChannelCatalogImage[];
  /** The store's further photos in its order, as entity-level `gallery` images; no url twice. */
  gallery: ChannelCatalogImage[];
}

/** The hero, the variant photos and the gallery together never exceed this — what a projection reads. */
const IMPORT_IMAGE_LIMIT = 6;

function imageOrder(a: ChannelCatalogImage, b: ChannelCatalogImage): number {
  return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
}

/**
 * The hero, then the first photo of each other variant (a "blue long dress" query must be able to
 * show the blue variant), then the store's further photos as the gallery, up to
 * `IMPORT_IMAGE_LIMIT` in all. Agent feeds publish the gallery as additional images and enrichment
 * reads it; only the hero is embedded, so a gallery photo costs an upload and no model call.
 * Variants are read off the images' own variant references, so a connector that lists images
 * against variants it does not enumerate still gets one each.
 */
export function selectImportImages(item: ChannelCatalogItem): ImportImageSelection {
  const images = [...(item.images ?? [])].sort(imageOrder);
  const hero = images.find((image) => image.role === "primary") ?? images[0] ?? null;
  if (!hero) return { hero: null, perVariant: [], gallery: [] };
  const covered = new Set(hero.variantExternalIds ?? []);
  const usedUrls = new Set([hero.url]);
  const perVariant: ChannelCatalogImage[] = [];
  const variantRefs = [...new Set(images.flatMap((image) => image.variantExternalIds ?? []))];
  for (const ref of variantRefs) {
    if (covered.has(ref)) continue;
    const image = images.find((candidate) => candidate.variantExternalIds?.includes(ref) && !usedUrls.has(candidate.url));
    for (const shown of image?.variantExternalIds ?? []) covered.add(shown);
    covered.add(ref);
    if (!image) continue;
    usedUrls.add(image.url);
    perVariant.push(image);
  }
  const gallery: ChannelCatalogImage[] = [];
  for (const image of images) {
    if (1 + perVariant.length + gallery.length >= IMPORT_IMAGE_LIMIT) break;
    if (usedUrls.has(image.url)) continue;
    usedUrls.add(image.url);
    // A further photo of a variant already shown is a product photo, not that variant's image.
    gallery.push({ ...image, role: "gallery", variantExternalIds: [] });
  }
  return { hero, perVariant, gallery };
}

type BoundedFetch =
  | { ok: true; bytes: Uint8Array<ArrayBuffer>; contentType: string }
  | { ok: false; reason: CatalogMediaFailureReason; detail: string };

/** Streams a response and refuses mid-stream past `cap`; a lying `content-length` cannot get around it. */
async function fetchBounded(url: string, cap: number): Promise<BoundedFetch> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    return { ok: false, reason: "download-failed", detail: error instanceof Error ? error.message : "download failed" };
  }
  if (!response.ok) return { ok: false, reason: "download-failed", detail: `download returned ${response.status}` };
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) return { ok: false, reason: "too-large", detail: `content-length ${declared} exceeds ${cap}` };
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "image/jpeg";
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > cap) return { ok: false, reason: "too-large", detail: `${buffer.byteLength} bytes exceeds ${cap}` };
    return { ok: true, bytes: new Uint8Array(buffer), contentType };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return { ok: false, reason: "too-large", detail: `stream exceeded ${cap} bytes` };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes, contentType };
}

function toImportProduct(item: ChannelCatalogItem): ImportProduct {
  const attributes = item.attributes?.length
    ? item.attributes
    : [{ locale: "en", title: item.title, ...(item.description !== undefined ? { description: item.description } : {}) }];
  return {
    ref: item.externalId,
    slug: item.slug,
    ...(item.status !== undefined ? { status: item.status, isVisible: item.status === "active" } : {}),
    metadata: mergeMetadata(undefined, item.metadata ?? {}),
    attributes: attributes.map((attribute) => ({
      locale: attribute.locale,
      title: attribute.title,
      ...(attribute.subtitle !== undefined ? { subtitle: attribute.subtitle } : {}),
      ...(attribute.description !== undefined ? { description: attribute.description } : {}),
      ...(attribute.richDescription !== undefined ? { richDescription: attribute.richDescription } : {}),
      ...(attribute.seoTitle !== undefined ? { seoTitle: attribute.seoTitle } : {}),
      ...(attribute.seoDescription !== undefined ? { seoDescription: attribute.seoDescription } : {}),
    })),
    ...(item.options !== undefined ? {
      options: item.options.map((option) => ({
        name: option.name,
        displayName: option.displayName,
        ...(option.sortOrder !== undefined ? { sortOrder: option.sortOrder } : {}),
        values: option.values.map((value) => ({
          value: value.value,
          displayValue: value.displayValue,
          ...(value.sortOrder !== undefined ? { sortOrder: value.sortOrder } : {}),
        })),
      })),
    } : {}),
    variants: item.variants.map((variant) => ({
      ref: variant.externalId,
      ...(variant.sku !== undefined ? { sku: variant.sku } : {}),
      ...(variant.barcode !== undefined ? { barcode: variant.barcode } : {}),
      ...(variant.optionValues !== undefined ? { options: variant.optionValues } : {}),
      ...(variant.prices !== undefined ? { prices: variant.prices } : {}),
      ...(variant.metadata !== undefined ? { metadata: variant.metadata } : {}),
    })),
    ...(item.tags !== undefined ? { tags: item.tags } : {}),
    ...(item.brand !== undefined ? { brand: item.brand } : {}),
    ...(item.categories !== undefined ? { categories: item.categories } : {}),
    ownedFieldPaths: importedFieldPaths(item),
  };
}

/** One item's link writes, planned before the transaction that commits them (`commitEntityLinks`). */
type PlannedLinks = { [K in keyof EntityLinkRows]-?: Array<NonNullable<EntityLinkRows[K]>[number]> };

/** What applying one delivery's events left for the store's reconcile report. */
interface ChannelEventReport {
  skipped: CatalogFieldSkip[];
  conflicts: CatalogFieldConflict[];
  warnings: string[];
}

export class ChannelConnectorService {
  private readonly connectors = new Map<string, ChannelConnector>();
  private readonly transact: PluginTxFn;
  private readonly jobs: JobsAdapter | undefined;
  private readonly options: ChannelConnectorPluginOptions;

  constructor(
    private readonly db: PluginDb,
    private readonly services: Record<string, unknown>,
    options: ChannelConnectorPluginOptions = {},
    transaction?: PluginTxFn,
  ) {
    this.options = options;
    for (const connector of options.connectors ?? []) {
      if (this.connectors.has(connector.providerId)) {
        throw new Error(`Duplicate channel connector providerId: ${connector.providerId}`);
      }
      this.connectors.set(connector.providerId, withLiveCredentials(connector, db));
    }
    this.jobs = options.jobs ?? (services.jobs as JobsAdapter | undefined);
    this.transact = transaction ?? ((fn) => this.db.transaction(fn));
  }

  /** Every catalogue read goes through here, so each item leaves the intake normalised once. */
  private async readCatalogPage(connector: ChannelConnector, store: ChannelStore, cursor: string | undefined): ReturnType<ChannelConnector["importCatalog"]> {
    const page = await connector.importCatalog(store, cursor);
    if (!page.ok) return page;
    return { ...page, value: { ...page.value, items: page.value.items.map(withDistinctVariantSkus) } };
  }

  getConnector(providerId: string): ChannelConnector | undefined {
    return this.connectors.get(providerId);
  }

  private get catalog(): CatalogService {
    return this.services.catalog as CatalogService;
  }

  private get media(): MediaService {
    return this.services.media as MediaService;
  }

  private get pricing(): PricingService {
    return this.services.pricing as PricingService;
  }

  private filterOwnedFields(
    item: ChannelCatalogItem,
    owners: Map<FieldPath, FieldOwner>,
  ): { writable: ChannelCatalogItem; skipped: FieldPath[]; conflicts: FieldPath[] } {
    return this.filterOwnedFieldsAtPaths(item, owners, importedFieldPaths(item));
  }

  private filterOwnedFieldsAtPaths(
    item: ChannelCatalogItem,
    owners: Map<FieldPath, FieldOwner>,
    fieldPaths: FieldPath[],
  ): { writable: ChannelCatalogItem; skipped: FieldPath[]; conflicts: FieldPath[] } {
    const populated = new Set(fieldPaths);
    const skipped = fieldPaths.filter((path) => owners.get(path) === "platform");
    const blocked = new Set(skipped);
    const attributes = (item.attributes?.length
      ? item.attributes
      : [{ locale: "en", title: item.title, ...(item.description !== undefined ? { description: item.description } : {}) }])
      .flatMap((attribute) => {
        return [{
          locale: attribute.locale,
          title: attribute.title,
          ...Object.fromEntries(attributeFields.slice(1)
            .filter((field) => attribute[field] !== undefined
              && populated.has(`attributes.${attribute.locale}.${field}`)
              && !blocked.has(`attributes.${attribute.locale}.${field}`))
            .map((field) => [field, attribute[field]])),
        }];
      });
    const writable: ChannelCatalogItem = {
      ...item,
      attributes,
      metadata: Object.fromEntries(Object.entries(item.metadata ?? {}).filter(([key]) => populated.has(`entity.metadata.${key}`) && !blocked.has(`entity.metadata.${key}`))),
      ...(item.images !== undefined ? { images: item.images.filter((image) => populated.has(`media.${image.role}`) && !blocked.has(`media.${image.role}`)) } : {}),
      ...(item.options !== undefined ? { options: blocked.has("options") ? [] : item.options } : {}),
      variants: item.variants.map((variant) => ({
        externalId: variant.externalId,
        ...(variant.sku !== undefined && populated.has("variants.sku") && !blocked.has("variants.sku") ? { sku: variant.sku } : {}),
        ...(variant.barcode !== undefined && populated.has("variants.barcode") && !blocked.has("variants.barcode") ? { barcode: variant.barcode } : {}),
        ...(variant.metadata !== undefined ? { metadata: variant.metadata } : {}),
        ...(variant.optionValues !== undefined && populated.has("options") && !blocked.has("options") ? { optionValues: variant.optionValues } : {}),
        ...(variant.prices !== undefined
          ? { prices: variant.prices.filter((price) => populated.has(`prices.${price.currency}`) && !blocked.has(`prices.${price.currency}`)) }
          : {}),
      })),
    };
    return { writable, skipped, conflicts: [] };
  }

  private filterConflictingFields(
    item: ChannelCatalogItem,
    conflicts: FieldPath[],
  ): { writable: ChannelCatalogItem; conflicts: FieldPath[] } {
    if (conflicts.length === 0) return { writable: item, conflicts: [] };
    const blocked = new Set(conflicts);
    const attributes = (item.attributes ?? []).flatMap((attribute) => {
      return [{
        locale: attribute.locale,
        title: attribute.title,
        ...Object.fromEntries(attributeFields.slice(1)
          .filter((field) => attribute[field] !== undefined && !blocked.has(`attributes.${attribute.locale}.${field}`))
          .map((field) => [field, attribute[field]])),
      }];
    });
    return {
      writable: {
        ...item,
        attributes,
        metadata: Object.fromEntries(Object.entries(item.metadata ?? {}).filter(([key]) => !blocked.has(`entity.metadata.${key}`))),
        ...(item.images !== undefined ? { images: item.images.filter((image) => !blocked.has(`media.${image.role}`)) } : {}),
        ...(item.options !== undefined ? { options: blocked.has("options") ? [] : item.options } : {}),
        variants: item.variants.map((variant) => ({
          externalId: variant.externalId,
          ...(variant.sku !== undefined && !blocked.has("variants.sku") ? { sku: variant.sku } : {}),
          ...(variant.barcode !== undefined && !blocked.has("variants.barcode") ? { barcode: variant.barcode } : {}),
          ...(variant.metadata !== undefined ? { metadata: variant.metadata } : {}),
          ...(variant.optionValues !== undefined && !blocked.has("options") ? { optionValues: variant.optionValues } : {}),
          ...(variant.prices !== undefined
            ? { prices: variant.prices.filter((price) => !blocked.has(`prices.${price.currency}`)) }
            : {}),
        })),
      },
      conflicts,
    };
  }

  private remoteFieldValue(item: ChannelCatalogItem, path: FieldPath): unknown {
    const [root, segment, field] = path.split(".");
    if (root === "entity" && segment === "slug") return item.slug;
    if (root === "entity" && segment === "status") return item.status;
    if (root === "entity" && segment === "metadata") return item.metadata?.[field ?? ""];
    if (root === "customFields" && segment && field) {
      const customFields = (item as ChannelCatalogItem & { customFields?: Record<string, unknown> }).customFields;
      const customField = customFields?.[segment];
      if (customField && typeof customField === "object" && !Array.isArray(customField)) {
        return (customField as Record<string, unknown>)[field];
      }
    }
    if (root === "attributes" && segment && field) {
      const attributes = item.attributes?.length
        ? item.attributes
        : [{ locale: "en", title: item.title, ...(item.description !== undefined ? { description: item.description } : {}) }];
      const attribute = attributes.find((row) => row.locale === segment);
      return attribute?.[field as keyof typeof attribute];
    }
    if (root === "media" && segment) {
      return (item.images ?? [])
        .filter((image) => image.role === segment)
        .map((image) => ({ url: image.url, role: image.role }));
    }
    if (path === "options") return item.options;
    if (path === "variants.sku") return item.variants.map((variant) => variant.sku);
    if (path === "variants.barcode") return item.variants.map((variant) => variant.barcode);
    if (root === "prices" && segment) return item.variants.flatMap((variant) => variant.prices ?? []).filter((price) => price.currency === segment);
    return undefined;
  }

  private isOutboundEcho(
    mapping: typeof channelEntityMap.$inferSelect,
    item: ChannelCatalogItem,
  ): boolean {
    if (!mapping.outboundHash || !mapping.outboundPushedAt || mapping.outboundFieldPaths.length === 0) return false;
    const age = Date.now() - mapping.outboundPushedAt.getTime();
    if (age < 0 || age > CATALOG_OUTBOUND_SUPPRESSION_WINDOW_MS) return false;
    const inboundHash = canonicalInboundHash(mapping.externalId, mapping.outboundFieldPaths, (fieldPath) => this.remoteFieldValue(item, fieldPath));
    return inboundHash === mapping.outboundHash;
  }

  private async localFieldValue(
    entityId: string,
    entity: typeof sellableEntities.$inferSelect,
    path: FieldPath,
  ): Promise<unknown> {
    const [root, segment, field] = path.split(".");
    if (root === "entity" && segment === "slug") return entity.slug;
    if (root === "entity" && segment === "status") return entity.status;
    if (root === "entity" && segment === "metadata") return entity.metadata?.[field ?? ""];
    if (root === "attributes" && segment && field) {
      const [attribute] = await this.db.select().from(sellableAttributes).where(and(
        eq(sellableAttributes.entityId, entityId),
        eq(sellableAttributes.locale, segment),
      ));
      const values: Record<string, unknown> = attribute
        ? {
          title: attribute.title,
          subtitle: attribute.subtitle,
          description: attribute.description,
          richDescription: attribute.richDescription,
          seoTitle: attribute.seoTitle,
          seoDescription: attribute.seoDescription,
        }
        : {};
      return values[field];
    }
    if (root === "customFields" && segment && field) {
      const [customField] = await this.db.select().from(sellableCustomFields).where(and(
        eq(sellableCustomFields.entityId, entityId),
        eq(sellableCustomFields.fieldName, segment),
        eq(sellableCustomFields.locale, field),
        eq(sellableCustomFields.status, "approved"),
      ));
      return customField ? customFieldValue(customField) : undefined;
    }
    if (root === "media" && segment) {
      const links = await this.db.select({ id: entityMedia.mediaAssetId }).from(entityMedia).where(and(
        eq(entityMedia.entityId, entityId),
        eq(entityMedia.role, segment as "primary" | "gallery" | "thumbnail" | "video" | "document"),
      ));
      return links.map((link) => link.id);
    }
    if (path === "options") {
      const types = await this.db.select().from(optionTypes).where(eq(optionTypes.entityId, entityId));
      const values = await Promise.all(types.map(async (type) => ({
        name: type.name,
        values: await this.db.select().from(optionValues).where(eq(optionValues.optionTypeId, type.id)),
      })));
      return values;
    }
    if (path === "variants.sku" || path === "variants.barcode") {
      const rows = await this.db.select().from(variants).where(eq(variants.entityId, entityId));
      return rows.map((variant) => path === "variants.sku" ? variant.sku : variant.barcode);
    }
    if (root === "prices" && segment) {
      const rows = await this.db.select().from(prices).where(and(
        eq(prices.entityId, entityId),
        eq(prices.currency, segment),
      ));
      return rows.map((price) => ({ amount: price.amount, compareAtAmount: price.compareAtAmount }));
    }
    return undefined;
  }

  private async lastSyncedSnapshot(
    entityId: string,
    lastSyncedAt: Date,
  ): Promise<SellableEntityRevisionSnapshot | undefined> {
    const [revision] = await this.db.select({ snapshot: sellableEntityRevisions.snapshot }).from(sellableEntityRevisions).where(and(
      eq(sellableEntityRevisions.entityId, entityId),
      lte(sellableEntityRevisions.createdAt, lastSyncedAt),
    )).orderBy(desc(sellableEntityRevisions.createdAt)).limit(1);
    return revision?.snapshot;
  }

  private async detectSharedConflicts(
    entityId: string,
    storeId: string,
    entity: typeof sellableEntities.$inferSelect,
    mapping: typeof channelEntityMap.$inferSelect | undefined,
    item: ChannelCatalogItem,
    owners: Map<FieldPath, FieldOwner>,
    fieldPaths: FieldPath[] = importedFieldPaths(item),
    remoteHash = hash(item),
    echo?: { certifiedPaths: ReadonlySet<FieldPath> },
  ): Promise<{ paths: FieldPath[]; conflicts: DetectedCatalogFieldConflict[] }> {
    if (!mapping || mapping.syncHash === remoteHash) return { paths: [], conflicts: [] };
    const revisions = await this.catalog.repository.findRevisionMarkers(entityId, mapping.lastSyncedAt);
    const localChanged = revisions.some((revision) => revision.reason !== "import");
    const paths = fieldPaths.filter((path) => owners.get(path) === "shared");
    const openRows = await this.db.select({
      fieldPath: channelCatalogConflicts.fieldPath,
      storeValue: channelCatalogConflicts.storeValue,
    }).from(channelCatalogConflicts).where(and(
      eq(channelCatalogConflicts.storeId, storeId),
      eq(channelCatalogConflicts.entityId, entityId),
      eq(channelCatalogConflicts.state, "open"),
    ));
    if (!localChanged && openRows.length === 0) return { paths: [], conflicts: [] };
    const openByPath = new Map(openRows.map((row) => [row.fieldPath as FieldPath, row.storeValue]));
    const baseline = await this.lastSyncedSnapshot(entityId, mapping.lastSyncedAt);
    const changed: FieldPath[] = [];
    for (const path of paths) {
      const localValue = await this.localFieldValue(entityId, entity, path);
      const remoteValue = this.remoteFieldValue(item, path);
      let diverged = false;
      if (echo) {
        // The outbound hash certifies only the pushed paths; a shared path
        // outside that set carrying a genuinely different remote value is a
        // real store edit even inside an echo payload.
        diverged = !echo.certifiedPaths.has(path) && !normalizedValuesEqual(remoteValue, localValue);
      } else if (openByPath.has(path)) {
        diverged = !normalizedValuesEqual(remoteValue, openByPath.get(path));
      } else if (baseline) {
        const baselineValue = snapshotFieldValue(baseline, path);
        diverged = baselineValue.found
          && !normalizedValuesEqual(localValue, baselineValue.value)
          && !normalizedValuesEqual(remoteValue, baselineValue.value)
          && !normalizedValuesEqual(localValue, remoteValue);
      } else {
        diverged = !normalizedValuesEqual(remoteValue, localValue);
      }
      if (diverged) changed.push(path);
    }
    const conflicts = await Promise.all(changed.map(async (fieldPath) => {
      const platformValue = await this.localFieldValue(entityId, entity, fieldPath);
      const storeValue = this.remoteFieldValue(item, fieldPath);
      return {
        entityId,
        storeId,
        fieldPath,
        platformValue: platformValue === undefined ? null : platformValue,
        storeValue: storeValue === undefined ? null : storeValue,
        localValueSummary: summarizeValue(platformValue),
        remoteValueSummary: summarizeValue(storeValue),
      };
    }));
    return { paths: changed, conflicts };
  }

  /**
   * Apply upstream SKU and barcode changes to variants this store already maps, for a whole batch.
   *
   * SKU is unique per source store, so variants EXCHANGING SKUs cannot be updated one at a time.
   * One transaction first releases every SKU that is changing (NULL is outside the unique index),
   * then sets the new values, so any swap inside the batch lands atomically. If that fails on a
   * unique violation — a new SKU is held by a variant whose upstream did not change, or by a
   * variant in a batch not converged yet — each entity is retried alone, then each variant alone,
   * and the SKU that still cannot be taken is returned as a clash. A clash is the caller's to
   * record as a conflict; it never fails the item, which still converges every other field.
   */
  private async applyUpstreamVariantIdentity(
    orgId: string,
    storeId: string,
    items: readonly ChannelCatalogItem[],
  ): Promise<VariantIdentityOutcome> {
    const outcome: VariantIdentityOutcome = { written: new Set(), clashes: new Map(), openSkuConflicts: new Set() };
    const externalIds = [...new Set(items.flatMap((item) => item.variants.map((variant) => variant.externalId)))];
    if (externalIds.length === 0) return outcome;
    const mapped = await this.db.select({
      externalId: channelEntityMap.externalId,
      variantId: variants.id,
      entityId: variants.entityId,
      sku: variants.sku,
      barcode: variants.barcode,
    }).from(channelEntityMap)
      .innerJoin(variants, eq(variants.id, channelEntityMap.variantId))
      .where(and(
        eq(channelEntityMap.organizationId, orgId),
        eq(channelEntityMap.storeId, storeId),
        eq(channelEntityMap.kind, "variant"),
        inArray(channelEntityMap.externalId, externalIds),
      ));
    if (mapped.length === 0) return outcome;
    const byExternalId = new Map(mapped.map((row) => [row.externalId, row]));
    const entityIds = [...new Set(mapped.map((row) => row.entityId))];
    const openRows = await this.db.select({ entityId: channelCatalogConflicts.entityId }).from(channelCatalogConflicts).where(and(
      eq(channelCatalogConflicts.storeId, storeId),
      eq(channelCatalogConflicts.fieldPath, "variants.sku"),
      eq(channelCatalogConflicts.state, "open"),
      inArray(channelCatalogConflicts.entityId, entityIds),
    ));
    for (const row of openRows) outcome.openSkuConflicts.add(row.entityId);

    type Write = { itemExternalId: string; entityId: string; variantId: string; variantExternalId: string; fromSku: string | null; toSku?: string; toBarcode?: string };
    const candidates: Write[] = [];
    for (const item of items) {
      for (const variant of item.variants) {
        const row = byExternalId.get(variant.externalId);
        if (!row) continue;
        const toSku = variant.sku !== undefined && variant.sku !== row.sku ? variant.sku : undefined;
        const toBarcode = variant.barcode !== undefined && variant.barcode !== row.barcode ? variant.barcode : undefined;
        if (toSku === undefined && toBarcode === undefined) continue;
        candidates.push({
          itemExternalId: item.externalId, entityId: row.entityId, variantId: row.variantId, variantExternalId: variant.externalId, fromSku: row.sku,
          ...(toSku !== undefined ? { toSku } : {}), ...(toBarcode !== undefined ? { toBarcode } : {}),
        });
      }
    }
    if (candidates.length === 0) return outcome;

    // Ownership, per entity that has a change: a platform-owned or held path stays local.
    const candidateEntities = [...new Set(candidates.map((write) => write.entityId))];
    const held = new Map((await this.db.select({ entityId: channelEntityMap.entityId, held: channelEntityMap.heldFieldPaths }).from(channelEntityMap).where(and(
      eq(channelEntityMap.storeId, storeId),
      eq(channelEntityMap.kind, "entity"),
      inArray(channelEntityMap.entityId, candidateEntities),
    ))).map((row) => [row.entityId, new Set(row.held ?? [])]));
    const allowed = new Map<string, { sku: boolean; barcode: boolean }>();
    for (const entityId of candidateEntities) {
      const owners = await this.catalog.resolveFieldOwners(entityId, storeId);
      const entityHeld = held.get(entityId) ?? new Set<string>();
      allowed.set(entityId, {
        sku: ownerAllows(owners, "variants.sku") && !entityHeld.has("variants.sku"),
        barcode: ownerAllows(owners, "variants.barcode") && !entityHeld.has("variants.barcode"),
      });
    }
    const writes: Write[] = candidates.flatMap((write) => {
      const permitted = allowed.get(write.entityId) ?? { sku: false, barcode: false };
      const next: Write = {
        itemExternalId: write.itemExternalId, entityId: write.entityId, variantId: write.variantId, variantExternalId: write.variantExternalId, fromSku: write.fromSku,
        ...(permitted.sku && write.toSku !== undefined ? { toSku: write.toSku } : {}),
        ...(permitted.barcode && write.toBarcode !== undefined ? { toBarcode: write.toBarcode } : {}),
      };
      return next.toSku === undefined && next.toBarcode === undefined ? [] : [next];
    });
    if (writes.length === 0) return outcome;

    const apply = (group: readonly Write[]) => this.transact(async (tx) => {
      const releasing = group.filter((write) => write.toSku !== undefined).map((write) => write.variantId);
      if (releasing.length > 0) await tx.update(variants).set({ sku: null }).where(inArray(variants.id, releasing));
      for (const write of group) {
        await tx.update(variants).set({
          ...(write.toSku !== undefined ? { sku: write.toSku } : {}),
          ...(write.toBarcode !== undefined ? { barcode: write.toBarcode } : {}),
          updatedAt: sql`now()`,
        }).where(eq(variants.id, write.variantId));
      }
    });
    const landed = (group: readonly Write[]) => { for (const write of group) outcome.written.add(write.itemExternalId); };
    const attempt = async (group: readonly Write[]): Promise<boolean> => {
      try {
        await apply(group);
        landed(group);
        return true;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        return false;
      }
    };

    if (await attempt(writes)) return outcome;
    for (const entityId of [...new Set(writes.map((write) => write.entityId))]) {
      const group = writes.filter((write) => write.entityId === entityId);
      if (await attempt(group)) continue;
      for (const write of group) {
        if (await attempt([write])) continue;
        // The SKU cannot be taken this batch. The barcode, which nothing else can hold, still lands.
        if (write.toBarcode !== undefined) {
          await attempt([{ itemExternalId: write.itemExternalId, entityId: write.entityId, variantId: write.variantId, variantExternalId: write.variantExternalId, fromSku: write.fromSku, toBarcode: write.toBarcode }]);
        }
        if (write.toSku === undefined) continue;
        const [holder] = await this.db.select({ id: variants.id }).from(variants).where(and(eq(variants.sourceStoreId, storeId), eq(variants.sku, write.toSku)));
        const clashes = outcome.clashes.get(write.itemExternalId) ?? [];
        clashes.push({ variantExternalId: write.variantExternalId, fromSku: write.fromSku, toSku: write.toSku, heldByVariantId: holder?.id ?? null });
        outcome.clashes.set(write.itemExternalId, clashes);
      }
    }
    return outcome;
  }

  /** Close this entity's open `variants.sku` conflict: the SKUs it was waiting on have now landed. */
  private async resolveSkuConflict(orgId: string, storeId: string, entityId: string, changedBy: string): Promise<void> {
    const resolved = await this.db.update(channelCatalogConflicts).set({ state: "resolved", resolvedBy: changedBy, updatedAt: new Date() }).where(and(
      eq(channelCatalogConflicts.storeId, storeId),
      eq(channelCatalogConflicts.entityId, entityId),
      eq(channelCatalogConflicts.fieldPath, "variants.sku"),
      eq(channelCatalogConflicts.state, "open"),
    )).returning({ id: channelCatalogConflicts.id });
    if (resolved.length === 0) return;
    await this.db.insert(channelCatalogConflictEvents).values(resolved.map((row) => ({
      organizationId: orgId,
      conflictId: row.id,
      fromState: "open",
      toState: "resolved",
      reason: "The upstream SKUs this product was waiting on have converged.",
      changedBy,
    })));
  }

  private async persistCatalogConflicts(
    orgId: string,
    conflicts: DetectedCatalogFieldConflict[],
    changedBy: string,
    reason = "Shared catalog field changed on both sides.",
  ): Promise<PluginResult<void>> {
    for (const conflict of conflicts) {
      const [inserted] = await this.db.insert(channelCatalogConflicts).values({
        organizationId: orgId,
        storeId: conflict.storeId,
        entityId: conflict.entityId,
        fieldPath: conflict.fieldPath,
        platformValue: conflict.platformValue,
        storeValue: conflict.storeValue,
      }).onConflictDoNothing().returning();
      if (!inserted) {
        const [existing] = await this.db.select({
          id: channelCatalogConflicts.id,
          storeValue: channelCatalogConflicts.storeValue,
          platformValue: channelCatalogConflicts.platformValue,
        }).from(channelCatalogConflicts).where(and(
          eq(channelCatalogConflicts.organizationId, orgId),
          eq(channelCatalogConflicts.storeId, conflict.storeId),
          eq(channelCatalogConflicts.entityId, conflict.entityId),
          eq(channelCatalogConflicts.fieldPath, conflict.fieldPath),
          eq(channelCatalogConflicts.state, "open"),
        ));
        const storeMoved = existing !== undefined && !normalizedValuesEqual(existing.storeValue, conflict.storeValue);
        const platformMoved = existing !== undefined && !normalizedValuesEqual(existing.platformValue, conflict.platformValue);
        if (existing && (storeMoved || platformMoved)) {
          await this.db.update(channelCatalogConflicts).set({
            storeValue: conflict.storeValue,
            platformValue: conflict.platformValue,
            updatedAt: new Date(),
          }).where(eq(channelCatalogConflicts.id, existing.id));
        }
        continue;
      }
      await this.db.insert(channelCatalogConflictEvents).values({
        organizationId: orgId,
        conflictId: inserted.id,
        fromState: null,
        toState: "open",
        reason,
        changedBy,
      });
    }
    return Ok(undefined);
  }

  private async setCatalogAttributes(
    entityId: string,
    item: ChannelCatalogItem,
    actor: Actor,
    blockedPaths: ReadonlySet<FieldPath> = new Set<FieldPath>(),
    catalogCtx?: CatalogWriteContext,
  ): Promise<PluginResult<{ created: number; changed: boolean }>> {
    const attributes = item.attributes ?? [{
      locale: "en",
      title: item.title,
      ...(item.description !== undefined ? { description: item.description } : {}),
    }];
    const existing = await this.db.select().from(sellableAttributes).where(eq(sellableAttributes.entityId, entityId));
    let created = 0;
    let changed = false;
    for (const attribute of attributes) {
      const current = existing.find((row) => row.locale === attribute.locale);
      const titlePath = `attributes.${attribute.locale}.title` as FieldPath;
      if (!current && blockedPaths.has(titlePath)) continue;
      const title = blockedPaths.has(titlePath) ? current?.title : attribute.title;
      if (title === undefined) continue;
      const writeAttribute = {
        title,
        ...(attribute.subtitle !== undefined && !blockedPaths.has(`attributes.${attribute.locale}.subtitle`) ? { subtitle: attribute.subtitle } : current?.subtitle != null ? { subtitle: current.subtitle } : {}),
        ...(attribute.description !== undefined && !blockedPaths.has(`attributes.${attribute.locale}.description`) ? { description: attribute.description } : current?.description != null ? { description: current.description } : {}),
        ...(attribute.richDescription !== undefined && !blockedPaths.has(`attributes.${attribute.locale}.richDescription`) ? { richDescription: attribute.richDescription } : current?.richDescription != null ? { richDescription: current.richDescription } : {}),
        ...(attribute.seoTitle !== undefined && !blockedPaths.has(`attributes.${attribute.locale}.seoTitle`) ? { seoTitle: attribute.seoTitle } : current?.seoTitle != null ? { seoTitle: current.seoTitle } : {}),
        ...(attribute.seoDescription !== undefined && !blockedPaths.has(`attributes.${attribute.locale}.seoDescription`) ? { seoDescription: attribute.seoDescription } : current?.seoDescription != null ? { seoDescription: current.seoDescription } : {}),
      };
      if (!current) {
        created += 1;
        changed = true;
      } else if (attributeFields.some((field) => (current[field] == null ? null : current[field]) !== (writeAttribute[field] == null ? null : writeAttribute[field]))) {
        changed = true;
      }
      const result = await this.catalog.setAttributes(entityId, attribute.locale, writeAttribute, actor, catalogCtx);
      if (!result.ok) return PluginErr(result.error.message);
    }
    return Ok({ created, changed });
  }

  private async setCatalogAttributesIfWritable(
    entityId: string,
    item: ChannelCatalogItem,
    actor: Actor,
    blockedPaths: ReadonlySet<FieldPath>,
    catalogCtx?: CatalogWriteContext,
  ): Promise<PluginResult<{ created: number; changed: boolean }>> {
    const attributes = item.attributes ?? [{
      locale: "en",
      title: item.title,
      ...(item.description !== undefined ? { description: item.description } : {}),
    }];
    const writable = attributes.some((attribute) => attributeFields.some((field) => (
      attribute[field] !== undefined && !blockedPaths.has(`attributes.${attribute.locale}.${field}`)
    )));
    if (!writable) return Ok({ created: 0, changed: false });
    return this.setCatalogAttributes(entityId, item, actor, blockedPaths, catalogCtx);
  }

  private async upsertOptionAxes(
    entityId: string,
    item: ChannelCatalogItem,
    actor: Actor,
  ): Promise<PluginResult<{ value: Map<string, Map<string, string>>; changed: boolean }>> {
    const optionValueIds = new Map<string, Map<string, string>>();
    // PROJECTED, not `select()`. Three reasons, and the third is the one that saves statements:
    // the row's other columns are never read; a projection types the locally-constructed row below
    // without a cast; and carrying `displayName`/`sortOrder` is what lets the update be SKIPPED when
    // they already hold. A re-import that changes nothing is the common case for a sync, and it used
    // to issue one UPDATE per option type and one per option value regardless.
    const existingTypes: { id: string; name: string; displayName: string | null; sortOrder: number | null }[] =
      await this.db
        .select({ id: optionTypes.id, name: optionTypes.name, displayName: optionTypes.displayName, sortOrder: optionTypes.sortOrder })
        .from(optionTypes)
        .where(eq(optionTypes.entityId, entityId));
    let changed = false;
    for (const [typeIndex, sourceType] of (item.options ?? []).entries()) {
      let optionType = existingTypes.find((row) => row.name === sourceType.name);
      if (!optionType) {
        const created = await this.catalog.createOptionType({ entityId, name: sourceType.name, values: [] }, actor);
        if (!created.ok) return PluginErr(created.error.message);
        // The created row is CONSTRUCTED rather than read back: `createOptionType` returns the id and
        // the name is what we just sent.
        //
        // The two nulls are DELIBERATE PLACEHOLDERS, not a claim about the database. `createOptionType`
        // actually persists `displayName: input.name, sortOrder: 0` (core entity-service.ts:595) and
        // `display_name` is NOT NULL (core catalog/schema.ts:307) — so a fresh row never holds null.
        // Constructing nulls here makes the comparison below unequal on any input, which is what forces
        // the update that writes the caller's real `displayName`/`sortOrder` over those defaults.
        optionType = { id: created.value.id, name: sourceType.name, displayName: null, sortOrder: null };
        existingTypes.push(optionType);
        changed = true;
      }
      const desiredTypeSort = sourceType.sortOrder ?? typeIndex;
      // `?? null` NORMALISES, and it is load-bearing rather than tidy. The stored value is `null` or a
      // string; a connector that omits `displayName` sends `undefined`, and `null !== undefined` is
      // true — so without this every such connector issued one UPDATE per option type on every sync
      // and the conditional bought it nothing. Latent on today's corpus, whose connector always sends
      // both fields.
      const desiredTypeDisplay = sourceType.displayName ?? null;
      if (optionType.displayName !== desiredTypeDisplay || optionType.sortOrder !== desiredTypeSort) {
        await this.db.update(optionTypes).set({
          displayName: sourceType.displayName,
          sortOrder: desiredTypeSort,
        }).where(eq(optionTypes.id, optionType.id));
        optionType.displayName = desiredTypeDisplay;
        optionType.sortOrder = desiredTypeSort;
      }

      const existingValues: { id: string; value: string; displayValue: string | null; sortOrder: number | null }[] =
        await this.db
          .select({ id: optionValues.id, value: optionValues.value, displayValue: optionValues.displayValue, sortOrder: optionValues.sortOrder })
          .from(optionValues)
          .where(eq(optionValues.optionTypeId, optionType.id));
      const valueIds = new Map<string, string>();
      for (const [valueIndex, sourceValue] of sourceType.values.entries()) {
        let optionValue = existingValues.find((row) => row.value === sourceValue.value);
        if (!optionValue) {
          const created = await this.catalog.createOptionValue({ optionTypeId: optionType.id, value: sourceValue.value }, actor);
          if (!created.ok) return PluginErr(created.error.message);
          // Same placeholder reasoning as the option type above: core persists `displayValue: input.value,
          // sortOrder: 0` (entity-service.ts:615), and the nulls force the update that overwrites them.
          optionValue = { id: created.value.id, value: sourceValue.value, displayValue: null, sortOrder: null };
          existingValues.push(optionValue);
          changed = true;
        }
        const desiredValueSort = sourceValue.sortOrder ?? valueIndex;
        const desiredValueDisplay = sourceValue.displayValue ?? null;
        if (optionValue.displayValue !== desiredValueDisplay || optionValue.sortOrder !== desiredValueSort) {
          await this.db.update(optionValues).set({
            displayValue: sourceValue.displayValue,
            sortOrder: desiredValueSort,
          }).where(eq(optionValues.id, optionValue.id));
          optionValue.displayValue = desiredValueDisplay;
          optionValue.sortOrder = desiredValueSort;
        }
        valueIds.set(sourceValue.value, optionValue.id);
      }
      optionValueIds.set(sourceType.name, valueIds);
    }
    return Ok({ value: optionValueIds, changed });
  }

  private async upsertVariants(
    orgId: string,
    storeId: string,
    entityId: string,
    item: ChannelCatalogItem,
    optionValueIds: Map<string, Map<string, string>>,
    actor: Actor,
    warnings: string[],
    applyOptionValues: boolean,
    fullItem: ChannelCatalogItem,
  ): Promise<PluginResult<{ value: Map<string, string>; repaired: number; changed: boolean }>> {
    const variantIds = new Map<string, string>();
    let repaired = 0;
    let changed = false;
    const mappings = await this.db.select().from(channelEntityMap).where(and(
      eq(channelEntityMap.organizationId, orgId),
      eq(channelEntityMap.storeId, storeId),
      eq(channelEntityMap.kind, "variant"),
      eq(channelEntityMap.entityId, entityId),
    ));
    // ONE read of the existing option-value rows for every already-mapped variant, instead of one
    // per variant inside the loop. Measured on the deployed Worker at 17.0 calls per product, which
    // is one per offer on a catalogue averaging 13 offers per product. A variant CREATED below is
    // absent from this map and correctly reads as empty: its rows are written in this same pass.
    const mappedVariantIds = mappings
      .map((row) => row.variantId)
      .filter((variantId): variantId is string => variantId !== null);
    const existingOptionValues = new Map<string, string[]>();
    if (mappedVariantIds.length > 0) {
      const rows = await this.db
        .select({ variantId: variantOptionValues.variantId, optionValueId: variantOptionValues.optionValueId })
        .from(variantOptionValues)
        .where(inArray(variantOptionValues.variantId, mappedVariantIds));
      for (const row of rows) {
        const list = existingOptionValues.get(row.variantId) ?? [];
        list.push(row.optionValueId);
        existingOptionValues.set(row.variantId, list);
      }
    }
    // The product's plain base prices, read once. `setBasePrice` upserts and fires its hook even at
    // the same amount, so an unchanged price is skipped here — and a price that IS written is what
    // makes the variant "changed", which is what `converged` counts.
    const storedPrices = item.variants.some((variant) => (variant.prices ?? []).length > 0)
      ? await this.db.select({ variantId: prices.variantId, currency: prices.currency, amount: prices.amount, compareAtAmount: prices.compareAtAmount })
        .from(prices)
        .where(and(
          eq(prices.organizationId, orgId),
          eq(prices.entityId, entityId),
          isNull(prices.customerGroupId),
          isNull(prices.minQuantity),
          isNull(prices.maxQuantity),
          isNull(prices.validFrom),
          isNull(prices.validUntil),
        ))
      : [];
    for (const sourceVariant of item.variants) {
      const fullSourceVariant = fullItem.variants.find((variant) => variant.externalId === sourceVariant.externalId) ?? sourceVariant;
      let mapping = mappings.find((row) => row.externalId === sourceVariant.externalId);
      let variantId = mapping?.variantId;
      // ADOPT BEFORE CREATE. A variant-kind mapping row whose `variantId` is null has lost its link
      // — the key survived, the target did not. Creating a replacement is what the loop used to do,
      // and it cannot work: the orphaned variant still holds the sku, so `variants_native_org_sku_unique`
      // refuses the insert and the item fails on this and every later sync. The row can never heal.
      //
      // `sku` is the store's own natural key for a variant, so re-resolving by it is what restores
      // the link the null destroyed. Scoped to this entity because a sku is unique per organization
      // and adopting another entity's variant would be worse than failing.
      if (mapping && !variantId && sourceVariant.sku) {
        const [adopted] = await this.db
          .select({ id: variants.id })
          .from(variants)
          .where(and(eq(variants.entityId, entityId), eq(variants.sku, sourceVariant.sku)))
          .limit(1);
        if (adopted) {
          variantId = adopted.id;
          // Write the link back, or the row stays broken and every later sync pays this lookup again.
          await this.db.update(channelEntityMap)
            .set({ variantId })
            .where(eq(channelEntityMap.id, mapping.id));
          mapping.variantId = variantId;
        }
      }
      const createdVariant = !variantId;
      if (!variantId) {
        const options: Record<string, string> = {};
        for (const [name, value] of Object.entries(sourceVariant.optionValues ?? {})) {
          const optionValueId = optionValueIds.get(name)?.get(value);
          if (!optionValueId) {
            warnings.push(`Skipped unmapped option "${name}=${value}" on variant "${sourceVariant.externalId}".`);
            continue;
          }
          options[name] = value;
        }
        const created = await this.catalog.createVariant({
          entityId,
          options,
          ...(sourceVariant.sku !== undefined ? { sku: sourceVariant.sku } : {}),
          ...(sourceVariant.barcode !== undefined ? { barcode: sourceVariant.barcode } : {}),
        }, actor);
        if (!created.ok) return PluginErr(created.error.message);
        variantId = created.value.id;
        if (mapping) {
          // REPAIR IN PLACE. `variantId` is nullable because this table also holds `kind: "entity"`
          // rows, which legitimately have none — but a VARIANT row with a null `variantId` is a
          // broken invariant, not a state to work around. The row already occupies
          // `channel_entity_map_store_kind_external_unique` on (store, kind, externalId), so the
          // insert below would raise a unique violation and fail the whole item. Updating the row
          // we already hold is the only shape that converges.
          await this.db.update(channelEntityMap).set({
            entityId,
            variantId,
            syncHash: hash(fullSourceVariant),
          }).where(eq(channelEntityMap.id, mapping.id));
          mapping.entityId = entityId;
          mapping.variantId = variantId;
          mapping.syncHash = hash(fullSourceVariant);
        } else {
          const [createdMapping] = await this.db.insert(channelEntityMap).values({
            organizationId: orgId,
            storeId,
            kind: "variant",
            externalId: sourceVariant.externalId,
            entityId,
            variantId,
            syncHash: hash(fullSourceVariant),
          }).returning();
          mapping = createdMapping;
          // Pushed so a payload repeating this externalId resolves the row it just created rather
          // than creating a second variant for it.
          if (mapping) mappings.push(mapping);
        }
      }
      if (!variantId) {
        warnings.push(`Skipped variant "${sourceVariant.externalId}": no local variant mapping exists.`);
        continue;
      }
      variantIds.set(sourceVariant.externalId, variantId);
      // The provider's per-variant facts (the inventory item a stock webhook names, the weight shipping
      // prices by) merge into the variant per key, as entity metadata does: the source's keys overwrite
      // their own and nothing else. The import fast path writes them at creation; without this the
      // editor path — every reconcile — left them off, and a stock webhook could not find its variant.
      const sourceMetadata = sourceVariant.metadata ?? {};
      if (Object.keys(sourceMetadata).length > 0) {
        await this.db.update(variants)
          .set({ metadata: sql`coalesce(${variants.metadata}, '{}'::jsonb) || ${JSON.stringify(sourceMetadata)}::jsonb` })
          .where(and(eq(variants.id, variantId), sql`not (coalesce(${variants.metadata}, '{}'::jsonb) @> ${JSON.stringify(sourceMetadata)}::jsonb)`));
      }
      if (applyOptionValues) {
        const desiredOptionValueIds = Object.entries(sourceVariant.optionValues ?? {})
          .map(([name, value]) => optionValueIds.get(name)?.get(value))
          .filter((optionValueId): optionValueId is string => optionValueId !== undefined);
        const currentIds = [...(existingOptionValues.get(variantId) ?? [])].sort();
        const desiredIds = [...new Set(desiredOptionValueIds)].sort();
        if (currentIds.length !== desiredIds.length || currentIds.some((id, index) => id !== desiredIds[index])) {
          // Rewrite and bump in ONE transaction: an option-value change is a variant-only change
          // (the entity row is not touched), and `variants.updated_at` is the only trace a consumer
          // can version it from. Neither may commit without the other.
          const optionVariantId = variantId;
          await this.transact(async (tx) => {
            await tx.delete(variantOptionValues).where(eq(variantOptionValues.variantId, optionVariantId));
            if (desiredIds.length > 0) {
              await tx.insert(variantOptionValues).values(desiredIds.map((optionValueId) => ({ variantId: optionVariantId, optionValueId }))).onConflictDoNothing();
            }
            await tx.update(variants).set({ updatedAt: sql`now()` }).where(eq(variants.id, optionVariantId));
          });
          if (desiredIds.length > 0) repaired += 1;
          // The map is the read model for this pass; a payload repeating an externalId must not see
          // the pre-fetched state after this write.
          existingOptionValues.set(variantId, [...desiredIds]);
          changed = true;
        }
        if (createdVariant && desiredIds.length > 0) {
          repaired += 1;
          changed = true;
        }
      }
      for (const price of sourceVariant.prices ?? []) {
        const currency = price.currency.trim().toUpperCase();
        const stored = storedPrices.find((row) => row.variantId === variantId && row.currency === currency);
        if (stored && stored.amount === price.amount && stored.compareAtAmount === (price.compareAtAmount ?? null)) continue;
        const priced = await this.pricing.setBasePrice({
          entityId,
          variantId,
          currency: price.currency,
          amount: price.amount,
          compareAtAmount: price.compareAtAmount ?? null,
        }, actor);
        if (!priced.ok) return PluginErr(priced.error.message);
        changed = true;
      }
      // Was UNCONDITIONAL: one UPDATE per variant on every import, including a re-sync where the
      // variant is byte-identical. `mapping.syncHash` is already in hand from the select above, so
      // the comparison is free and the write disappears on an unchanged variant — which is the
      // ordinary case for a store that syncs repeatedly.
      const nextSyncHash = hash(fullSourceVariant);
      if (mapping && mapping.syncHash !== nextSyncHash) {
        await this.db.update(channelEntityMap).set({
          syncHash: nextSyncHash,
        }).where(eq(channelEntityMap.id, mapping.id));
        mapping.syncHash = nextSyncHash;
      }
    }
    return Ok({ value: variantIds, repaired, changed });
  }

  /**
   * The organization's categories, brands and tags, read ONCE per converge run instead of once per
   * product.
   *
   * `applyTaxonomy` takes an `entityId` and is called unconditionally for every item, and each of
   * its three lookups was a whole-table read filtered by `organization_id`. Measured on the deployed
   * Worker: 1.0 call per product per class, three classes, every product — an organization's whole
   * category list re-read for each of twenty products in a batch that cannot have changed it.
   *
   * Rows created DURING the run are appended by the callers below, exactly as they were appended to
   * the per-product arrays before, so an item that introduces a category is still seen by the next
   * item. The cache is cleared at the top of `convergeCatalogItems`, so its lifetime is one converge
   * rather than the lifetime of the service.
   *
   * The staleness window widens from one product to one batch: a category created by ANOTHER process
   * mid-batch is not seen here. That was already true within a product — these lists were always a
   * snapshot — and the create paths below go through `this.catalog`, which refuses a duplicate slug
   * rather than writing one. So the failure mode is unchanged in kind and wider in window, which is
   * the trade this comment exists to state rather than hide.
   */
  private taxonomyCache: {
    orgId: string;
    categories: (typeof categories.$inferSelect)[];
    brands: (typeof brands.$inferSelect)[];
    tags: (typeof tags.$inferSelect)[];
  } | null = null;

  private async taxonomyFor(orgId: string): Promise<{
    categories: (typeof categories.$inferSelect)[];
    brands: (typeof brands.$inferSelect)[];
    tags: (typeof tags.$inferSelect)[];
  }> {
    // Keyed on orgId as well as presence: one service instance serving two organizations must not
    // hand the second one the first one's taxonomy.
    if (this.taxonomyCache?.orgId === orgId) return this.taxonomyCache;
    const [categoryRows, brandRows, tagRows] = await Promise.all([
      this.db.select().from(categories).where(eq(categories.organizationId, orgId)),
      this.db.select().from(brands).where(eq(brands.organizationId, orgId)),
      this.db.select().from(tags).where(eq(tags.organizationId, orgId)),
    ]);
    this.taxonomyCache = { orgId, categories: categoryRows, brands: brandRows, tags: tagRows };
    return this.taxonomyCache;
  }

  /**
   * Create a category or brand, or adopt the one another writer created first. The taxonomy
   * snapshot is per converge, so two stores converging at once can both see a slug missing and both
   * create it; the loser's conflict — returned or thrown — means the row it wanted now exists.
   */
  private async createTaxonomyOrAdopt<Row>(
    create: () => Promise<{ ok: true; value: { id: string } } | { ok: false; error: { message: string } }>,
    byId: (id: string) => Promise<Row | undefined>,
    bySlug: () => Promise<Row | undefined>,
    label: string,
  ): Promise<PluginResult<Row>> {
    let failure: unknown = `${label} was not persisted.`;
    try {
      const created = await create();
      if (created.ok) {
        const row = await byId(created.value.id);
        if (row !== undefined) return Ok(row);
      } else {
        failure = created.error;
      }
    } catch (error) {
      failure = error;
    }
    const existing = await bySlug();
    return existing !== undefined ? Ok(existing) : PluginErr(`${label}: ${errorMessage(failure)}`);
  }

  private async applyTaxonomy(
    orgId: string,
    entityId: string,
    item: ChannelCatalogItem,
    actor: Actor,
    warnings: string[],
  ): Promise<PluginResult<Pick<PlannedLinks, "categories" | "brands" | "tags"> & { listed: Set<string> }>> {
    // Resolves (creating where missing) the category, brand and tag rows the item names, and PLANS
    // the entity's links to them. The links are written by `commitEntityLinks`, in one transaction
    // with the entity's version bump; a link that already exists writes nothing there.
    const taxonomy = await this.taxonomyFor(orgId);
    const links: Pick<PlannedLinks, "categories" | "brands" | "tags"> = { categories: [], brands: [], tags: [] };
    // Every link the item names, as `${kind}:${id}` — including an archived category it names but
    // is not linked to again, so a link the store still lists is never read as dropped.
    const listed = new Set<string>();
    const categoryRows = taxonomy.categories;
    for (const slug of new Set(item.categories ?? [])) {
      let category = categoryRows.find((row) => row.slug === slug);
      if (category?.status === "archived") {
        listed.add(`category:${category.id}`);
        warnings.push(`Skipped archived category "${slug}".`);
        continue;
      }
      if (!category) {
        const created = await this.createTaxonomyOrAdopt(
          () => this.catalog.createCategory({ slug }, actor),
          async (id) => (await this.db.select().from(categories).where(eq(categories.id, id)))[0],
          async () => (await this.db.select().from(categories).where(and(eq(categories.organizationId, orgId), eq(categories.slug, slug))))[0],
          `Category "${slug}"`,
        );
        if (!created.ok) return created;
        category = created.value;
        categoryRows.push(category);
      }
      links.categories.push({ entityId, categoryId: category.id, sortOrder: 0 });
      listed.add(`category:${category.id}`);
    }

    const brandRows = taxonomy.brands;
    if (item.brand) {
      let brand = brandRows.find((row) => row.slug === item.brand);
      if (!brand) {
        const brandSlug = item.brand;
        const created = await this.createTaxonomyOrAdopt(
          () => this.catalog.createBrand({ slug: brandSlug, displayName: brandSlug }, actor),
          async (id) => (await this.db.select().from(brands).where(eq(brands.id, id)))[0],
          async () => (await this.db.select().from(brands).where(and(eq(brands.organizationId, orgId), eq(brands.slug, brandSlug))))[0],
          `Brand "${brandSlug}"`,
        );
        if (!created.ok) return created;
        brand = created.value;
        brandRows.push(brand);
      }
      links.brands.push({ entityId, brandId: brand.id, sortOrder: 0 });
      listed.add(`brand:${brand.id}`);
    }

    const tagRows = taxonomy.tags;
    for (const slug of new Set(item.tags ?? [])) {
      let tag = tagRows.find((row) => row.slug === slug);
      if (!tag) {
        const [createdTag] = await this.db.insert(tags).values({ organizationId: orgId, slug, displayName: slug }).onConflictDoNothing().returning();
        tag = createdTag ?? (await this.db.select().from(tags).where(and(
          eq(tags.organizationId, orgId),
          eq(tags.slug, slug),
        )))[0];
        if (!tag) return PluginErr(`Tag "${slug}" was not persisted.`);
        tagRows.push(tag);
      }
      links.tags.push({ entityId, tagId: tag.id });
      listed.add(`tag:${tag.id}`);
    }
    return Ok({ ...links, listed });
  }

  /**
   * Writes one item's planned links and versions the entity for them, in ONE transaction: the
   * entity's `updated_at` moves with the links or not at all, and `catalog.afterUpdate` fires once
   * for the item with every link path that really changed (`["categories","tags"]`), not once per
   * link. Returns those paths; empty means nothing changed.
   *
   * An entity CREATED by this converge is not versioned for its links: its creation already put it
   * in front of every consumer, so a bump here would re-project a product in the same breath as its
   * first projection — the cold-import cost this rule exists to avoid.
   *
   * It also REMOVES the category, brand and tag links the store no longer lists — only those on
   * record in `channel_entity_links` as this store's, so a link the merchant added survives. Rows
   * this converge inserts go on record; a product imported before provenance existed is claimed by
   * `claimUnrecordedLinks` at the top of the converge.
   */
  private async commitEntityLinks(
    orgId: string,
    storeId: string,
    entityId: string,
    planned: PlannedLinks,
    listed: Set<string>,
    previousRoles: Map<string, string>,
    isNew: boolean,
    actor: Actor,
  ): Promise<PluginResult<string[]>> {
    try {
      return Ok(await this.transact(async (tx) => {
        const written = await writeEntityLinks(tx, orgId, planned);
        const owned = isNew ? [] : await tx.select({ kind: channelEntityLinks.kind, targetId: channelEntityLinks.targetId }).from(channelEntityLinks)
          .where(and(eq(channelEntityLinks.storeId, storeId), eq(channelEntityLinks.entityId, entityId)));
        const dropped = owned.filter((row) => !listed.has(`${row.kind}:${row.targetId}`));
        const removed = await removeEntityLinks(tx, orgId, {
          categories: dropped.filter((row) => row.kind === "category").map((row) => ({ entityId, categoryId: row.targetId })),
          brands: dropped.filter((row) => row.kind === "brand").map((row) => ({ entityId, brandId: row.targetId })),
          tags: dropped.filter((row) => row.kind === "tag").map((row) => ({ entityId, tagId: row.targetId })),
        });
        if (dropped.length > 0) {
          await tx.delete(channelEntityLinks).where(and(
            eq(channelEntityLinks.storeId, storeId),
            eq(channelEntityLinks.entityId, entityId),
            or(...dropped.map((row) => and(eq(channelEntityLinks.kind, row.kind), eq(channelEntityLinks.targetId, row.targetId)))),
          ));
        }
        const record = [
          ...written.categories.map((row) => ({ kind: "category" as const, targetId: row.categoryId })),
          ...written.brands.map((row) => ({ kind: "brand" as const, targetId: row.brandId })),
          ...written.tags.map((row) => ({ kind: "tag" as const, targetId: row.tagId })),
        ];
        if (record.length > 0) {
          await tx.insert(channelEntityLinks).values(record.map((row) => ({ organizationId: orgId, storeId, entityId, ...row }))).onConflictDoNothing();
        }
        const paths = new Set([...(linkFieldPaths(written).get(entityId) ?? []), ...(linkFieldPaths(removed).get(entityId) ?? [])]);
        for (const row of written.placed) {
          const previous = previousRoles.get(`${row.mediaAssetId}:${row.variantId}`);
          if (previous !== undefined) paths.add(`media.${previous}`);
        }
        const changed = [...paths].sort();
        if (changed.length > 0 && !isNew) {
          await this.catalog.notifyEntityChanged(entityId, changed, actor, createTxContext(tx, { actor }));
        }
        return changed;
      }));
    } catch (error) {
      return PluginErr(error instanceof Error ? error.message : "Failed to write the entity's links.");
    }
  }

  private async applyMedia(
    orgId: string,
    entityId: string,
    item: ChannelCatalogItem,
    variantIds: Map<string, string>,
    actor: Actor,
    warnings: string[],
    owners: Map<FieldPath, FieldOwner>,
  ): Promise<PluginResult<{
    imported: number;
    uploaded: boolean;
    skipped: FieldPath[];
    links: Pick<PlannedLinks, "media" | "mediaPlacements">;
    /** The role a re-placed link held before, keyed `${mediaAssetId}:${variantId}` — its path changes too. */
    previousRoles: Map<string, string>;
  }>> {
    // Uploads what is missing and PLANS the entity's media links; `commitEntityLinks` writes them.
    //
    // The SAME `selectImportImages` the page fast path uses — hero, variant photos, bounded gallery.
    // This path once attached EVERY image the item listed, so a product's first price change
    // pulled in photos the fast path had left out: an upload and an entity bump per photo.
    const selection = selectImportImages(item);
    const images = selection.hero === null ? [] : [selection.hero, ...selection.perVariant, ...selection.gallery];
    const externalIds = [...new Set(images.map((image) => image.externalId).filter((id): id is string => id != null))];
    const urlHashes = [...new Set(images.map((image) => hash(image.url)))];
    const keyPredicates = [];
    if (externalIds.length > 0) {
      keyPredicates.push(inArray(sql`${mediaAssets.metadata}->>'channelImageExternalId'`, externalIds));
    }
    if (urlHashes.length > 0) {
      keyPredicates.push(inArray(sql`${mediaAssets.metadata}->>'channelImageUrlHash'`, urlHashes));
    }
    const assets = keyPredicates.length === 0
      ? []
      : await this.db.select().from(mediaAssets).where(and(
        eq(mediaAssets.organizationId, orgId),
        or(...keyPredicates),
      ));
    const links = await this.db.select().from(entityMedia).where(eq(entityMedia.entityId, entityId));
    let imported = 0;
    let uploaded = false;
    const skipped: FieldPath[] = [];
    const planned: Pick<PlannedLinks, "media" | "mediaPlacements"> = { media: [], mediaPlacements: [] };
    const previousRoles = new Map<string, string>();

    // A Cloudflare Worker may hold at most six simultaneous outbound connections per
    // invocation, and one image costs two of them — the download and the storage put — so
    // 6 / 2 = 3 images may be in flight. A fourth would queue behind the platform limit
    // rather than go faster.
    const MAX_CONCURRENT_IMAGE_IMPORTS = 6 / 2;

    type ResolvedImage = {
      mediaAssetId?: string;
      imageWarnings: string[];
      imported: number;
      imageChanged: boolean;
    };

    const findMatchingAsset = (image: { externalId?: string; url: string }, urlHash: string) =>
      assets.find((row) => {
        const metadata = row.metadata ?? {};
        return (image.externalId != null && metadata.channelImageExternalId === image.externalId)
          || metadata.channelImageUrlHash === urlHash;
      });

    const inFlightKeys = (image: { externalId?: string }, urlHash: string) => {
      const keys = [`hash:${urlHash}`];
      if (image.externalId != null) keys.push(`ext:${image.externalId}`);
      return keys;
    };

    const inFlightUploads = new Map<string, Promise<ResolvedImage>>();

    const resolveImageAsset = async (image: NonNullable<ChannelCatalogItem["images"]>[number]): Promise<ResolvedImage> => {
      const urlHash = hash(image.url);
      const existing = findMatchingAsset(image, urlHash);
      if (existing) {
        return { mediaAssetId: existing.id, imageWarnings: [], imported: 0, imageChanged: false };
      }
      const keys = inFlightKeys(image, urlHash);
      for (const key of keys) {
        const pending = inFlightUploads.get(key);
        // Sharing one upload must not mean sharing its tally. Serially, a second reference to the
        // same image found the asset the first had just pushed into `assets` and counted nothing;
        // returning the first reference's result object here would count one stored object twice
        // and push its warning twice, and `mediaImported` is reported to the caller.
        if (pending) return { ...(await pending), imageWarnings: [], imported: 0, imageChanged: false };
      }
      const uploadPromise = (async (): Promise<ResolvedImage> => {
        let response: Response;
        try {
          response = await fetch(image.url);
        } catch (error) {
          return {
            imageWarnings: [`Skipped image "${image.externalId ?? image.url}": ${error instanceof Error ? error.message : "download failed"}.`],
            imported: 0,
            imageChanged: false,
          };
        }
        if (!response.ok) {
          return {
            imageWarnings: [`Skipped image "${image.externalId ?? image.url}": download returned ${response.status}.`],
            imported: 0,
            imageChanged: false,
          };
        }
        const contentType = response.headers.get("content-type")?.split(";", 1)[0] ?? "image/jpeg";
        const extension = contentType.split("/", 2)[1] ?? "jpg";
        const uploaded = await this.media.upload({
          filename: `${image.externalId ?? urlHash}.${extension}`,
          contentType,
          data: await response.arrayBuffer(),
          ...(image.alt !== undefined ? { alt: image.alt } : {}),
          metadata: {
            channelImageUrlHash: urlHash,
            ...(image.externalId !== undefined ? { channelImageExternalId: image.externalId } : {}),
          },
          origin: "imported",
        }, actor);
        if (!uploaded.ok) {
          return {
            imageWarnings: [`Skipped image "${image.externalId ?? image.url}": ${uploaded.error.code === "STORAGE_NOT_SUPPORTED" ? "storage adapter is not configured" : uploaded.error.message}.`],
            imported: 0,
            imageChanged: false,
          };
        }
        const mediaAssetId = uploaded.value.id;
        const [createdAsset] = await this.db.select().from(mediaAssets).where(eq(mediaAssets.id, mediaAssetId));
        if (createdAsset) assets.push(createdAsset);
        return { mediaAssetId, imageWarnings: [], imported: 1, imageChanged: true };
      })();
      for (const key of keys) inFlightUploads.set(key, uploadPromise);
      try {
        return await uploadPromise;
      } finally {
        for (const key of keys) inFlightUploads.delete(key);
      }
    };

    const resolvedImages: ResolvedImage[] = images.length === 0
      ? []
      : await (async () => {
        const results: ResolvedImage[] = new Array(images.length);
        let nextIndex = 0;
        const worker = async () => {
          while (true) {
            const index = nextIndex;
            nextIndex += 1;
            // `index >= images.length` and `images[index] === undefined` are the same condition
            // here, and under noUncheckedIndexedAccess only the second one the compiler can see.
            const image = images[index];
            if (image === undefined) return;
            results[index] = await resolveImageAsset(image);
          }
        };
        await Promise.all(Array.from(
          { length: Math.min(MAX_CONCURRENT_IMAGE_IMPORTS, images.length) },
          () => worker(),
        ));
        return results;
      })();

    for (const resolved of resolvedImages) {
      warnings.push(...resolved.imageWarnings);
      imported += resolved.imported;
      if (resolved.imageChanged) uploaded = true;
    }

    for (const [imageIndex, image] of images.entries()) {
      const mediaAssetId = resolvedImages[imageIndex]?.mediaAssetId;
      if (!mediaAssetId) continue;

      const targets = image.variantExternalIds?.length
        ? image.variantExternalIds.map((externalId) => ({ externalId, variantId: variantIds.get(externalId) }))
        : [{ externalId: undefined, variantId: undefined }];
      for (const target of targets) {
        if (image.variantExternalIds?.length && !target.variantId) {
          warnings.push(`Skipped image "${image.externalId ?? image.url}" for unmapped variant "${target.externalId}".`);
          continue;
        }
        const existingLink = links.find((link) =>
          link.mediaAssetId === mediaAssetId
          && (target.variantId === undefined ? link.variantId === null : link.variantId === target.variantId),
        );
        if (existingLink) {
          if (existingLink.role !== image.role) {
            const currentRolePath = `media.${existingLink.role}` as FieldPath;
            const incomingRolePath = `media.${image.role}` as FieldPath;
            for (const path of [currentRolePath, incomingRolePath]) {
              if (owners.get(path) === "platform" && !skipped.includes(path)) skipped.push(path);
            }
            if (skipped.includes(currentRolePath) || skipped.includes(incomingRolePath)) continue;
          }
          if (existingLink.role !== image.role || existingLink.sortOrder !== (image.sortOrder ?? 0)) {
            planned.mediaPlacements.push({ entityId, variantId: target.variantId ?? null, mediaAssetId, role: image.role, sortOrder: image.sortOrder ?? 0 });
            previousRoles.set(`${mediaAssetId}:${target.variantId ?? null}`, existingLink.role);
          }
          continue;
        }
        planned.media.push({ entityId, variantId: target.variantId ?? null, mediaAssetId, role: image.role, sortOrder: image.sortOrder ?? 0 });
        links.push({
          entityId,
          mediaAssetId,
          role: image.role,
          sortOrder: image.sortOrder ?? 0,
          variantId: target.variantId ?? null,
          createdAt: new Date(),
        });
      }
    }
    return Ok({ imported, uploaded, skipped, links: planned, previousRoles });
  }

  private async getStoreRecord(orgId: string, id: string): Promise<ConnectedStore | undefined> {
    const rows = await this.db
      .select()
      .from(connectedStores)
      .where(and(eq(connectedStores.organizationId, orgId), eq(connectedStores.id, id)));
    return rows[0] as ConnectedStore | undefined;
  }

  /**
   * The slug each wanted handle takes for THIS store. Slugs stay unique across the organization —
   * the storefront resolves `/:idOrSlug` org-wide — but one platform organization holds many
   * merchants, and two of them may sell the same handle.
   *
   * A handle's FAMILY for a store is, in order: the bare handle, `<handle>-<store suffix>`, and
   * `<handle>-<store suffix>-<store id prefix>`. The last is unique per store, so a third store with
   * the same domain label still gets a slug of its own. A new product takes the first member no
   * other store holds. An existing product whose slug is already in its handle's family KEEPS it
   * (see `slugToKeep`): a slug, once assigned, is a shared link and is never recomputed.
   */
  private async resolveStoreSlugs(
    orgId: string,
    storeId: string,
    handles: readonly string[],
  ): Promise<Map<string, { slug: string; family: string[] }>> {
    const wanted = [...new Set(handles)];
    const resolved = new Map<string, { slug: string; family: string[] }>();
    if (wanted.length === 0) return resolved;
    const suffix = await this.storeSlugSuffixFor(orgId, storeId);
    const idPart = storeId.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
    const familyOf = (handle: string): string[] => suffix
      ? [handle, `${handle}-${suffix}`, `${handle}-${suffix}-${idPart}`]
      : [handle, `${handle}-${idPart}`];
    const families = new Map(wanted.map((handle) => [handle, familyOf(handle)]));
    const owners = await this.db.select({ slug: sellableEntities.slug, sourceStoreId: sellableEntities.sourceStoreId })
      .from(sellableEntities)
      .where(and(eq(sellableEntities.organizationId, orgId), inArray(sellableEntities.slug, [...families.values()].flat())));
    // Only ANOTHER STORE's product moves this one to a qualified slug. A product a person made in
    // Merchant Center (no source store) holding the handle stays a loud slug conflict, as before.
    const heldElsewhere = new Set(owners.filter((row) => row.sourceStoreId !== null && row.sourceStoreId !== storeId).map((row) => row.slug));
    for (const [handle, family] of families) {
      // Every member held by another store is only reachable through a hand-made slug; the last
      // member is then used anyway and the create fails loudly on the unique index.
      const slug = family.find((candidate) => !heldElsewhere.has(candidate)) ?? family[family.length - 1] ?? handle;
      resolved.set(handle, { slug, family });
    }
    return resolved;
  }

  // ponytail: cached for the service instance's lifetime (one task invocation), so a batched import
  // reads the store once. A store whose domain changes mid-invocation keeps the old suffix until the
  // next one — a new slug family only, never a rename of a slug already assigned.
  private readonly slugSuffixByStore = new Map<string, string>();

  private async storeSlugSuffixFor(orgId: string, storeId: string): Promise<string> {
    const cached = this.slugSuffixByStore.get(storeId);
    if (cached !== undefined) return cached;
    const suffix = storeSlugSuffix((await this.getStoreRecord(orgId, storeId))?.storeDomain ?? "");
    this.slugSuffixByStore.set(storeId, suffix);
    return suffix;
  }

  /** The slug an existing product converges to: its current one while that is still in the family
   *  of the handle the store sends, so a slug is never recomputed out from under a shared link. */
  private slugToKeep(currentSlug: string, resolved: { slug: string; family: string[] }): string {
    return resolved.family.includes(currentSlug) ? currentSlug : resolved.slug;
  }

  // A shop_domain can map to more than one connected store (reconnect, or the same
  // shop under two orgs). Compliance webhooks must fan out to all of them.
  /** This organization's store of `provider` at `storeDomain`, whatever its status. */
  async storeByDomain(orgId: string, provider: string, storeDomain: string): Promise<PublicConnectedStore | undefined> {
    const [row] = await this.db.select().from(connectedStores).where(and(eq(connectedStores.organizationId, orgId), eq(connectedStores.provider, provider), eq(connectedStores.storeDomain, storeDomain)));
    return row ? redactStore(row as ConnectedStore) : undefined;
  }

  async getStoresByDomain(shopDomain: string): Promise<ConnectedStore[]> {
    const rows = await this.db
      .select()
      .from(connectedStores)
      .where(eq(connectedStores.storeDomain, shopDomain));
    return rows as ConnectedStore[];
  }

  resolveCatalogFieldMapping(
    store: Pick<ConnectedStore, "provider" | "catalogFieldMapping">,
    filterableCustomFields?: ReadonlySet<string> | Readonly<Record<string, boolean>>,
    warnings: string[] = [],
  ): CatalogFieldMapping {
    return mergeCatalogFieldMapping(store.provider, store.catalogFieldMapping, filterableCustomFields, warnings);
  }

  async buildCatalogPushItems(
    orgId: string,
    storeId: string,
    entityIds: string[],
    options: BuildCatalogPushItemsOptions = {},
  ): Promise<PluginResult<BuildCatalogPushItemsResult>> {
    const store = await this.getStoreRecord(orgId, storeId);
    if (!store || store.status !== "connected") return PluginErr("Connected store not found.", "NOT_FOUND");
    if (!store.catalogWriteEnabled) return PluginErr("Catalog writes are disabled for this store.", "CATALOG_WRITE_DISABLED");
    if (entityIds.length === 0) return Ok({ items: [], skipped: [], warnings: [] });

    const entities = await this.db.select().from(sellableEntities).where(and(
      eq(sellableEntities.organizationId, orgId),
      inArray(sellableEntities.id, entityIds),
    ));
    const entityById = new Map(entities.map((entity) => [entity.id, entity]));
    const mappings = await this.db.select().from(channelEntityMap).where(and(
      eq(channelEntityMap.organizationId, orgId),
      eq(channelEntityMap.storeId, storeId),
      eq(channelEntityMap.kind, "entity"),
      inArray(channelEntityMap.entityId, entityIds),
    ));
    const mappingByEntity = new Map(mappings.map((mapping) => [mapping.entityId, mapping]));
    const items: CatalogPushAssemblyItem[] = [];
    const skipped: CatalogPushFieldSkip[] = [];
    const warnings: string[] = [];
    const revisionEntityIds: string[] = [];

    for (const entityId of entityIds) {
      const entity = entityById.get(entityId);
      if (!entity) return PluginErr("Catalog entity not found.", "NOT_FOUND");
      if (entity.status !== "active") {
        skipped.push({ entityId, fieldPath: "entity.status", reason: "entity_not_active" });
        continue;
      }
      const entityMapping = mappingByEntity.get(entity.id);
      if (!entityMapping) {
        skipped.push({ entityId, fieldPath: "entity", reason: "unmapped_entity" });
        continue;
      }
      const owners = await this.catalog.resolveFieldOwners(entity.id, storeId);
      const attributes = await this.db.select().from(sellableAttributes).where(eq(sellableAttributes.entityId, entity.id));
      const customFields = await this.db.select().from(sellableCustomFields).where(and(
        eq(sellableCustomFields.entityId, entity.id),
        eq(sellableCustomFields.status, "approved"),
      ));
      const customFieldNames = [...new Set(customFields.map((field) => field.fieldName))];
      const definitions = customFieldNames.length > 0
        ? await this.db.select({ name: entityFieldDefinitions.name, filterable: entityFieldDefinitions.filterable }).from(entityFieldDefinitions).where(and(
          eq(entityFieldDefinitions.organizationId, orgId),
          eq(entityFieldDefinitions.entityType, entity.type),
          inArray(entityFieldDefinitions.name, customFieldNames),
        ))
        : [];
      const filterableCustomFields = Object.fromEntries(definitions.map((definition) => [
        `customFields.${definition.name}.en`,
        definition.filterable,
      ]));
      for (const field of customFields) {
        filterableCustomFields[`customFields.${field.fieldName}.${field.locale}`] = definitions.find(
          (definition) => definition.name === field.fieldName,
        )?.filterable ?? false;
      }
      const fieldMapping = this.resolveCatalogFieldMapping(store, filterableCustomFields, warnings);
      const heldPaths = new Set(entityMapping.heldFieldPaths ?? []);
      const forcedPushPaths = new Set([
        ...(entityMapping.forcedPushFieldPaths ?? []),
        ...(options.forceFieldPaths?.[entity.id] ?? []),
      ]);
      const fields: CatalogPushAssemblyField[] = [];
      const appendField = (fieldPath: FieldPath, value: unknown) => {
        if (value === undefined) return;
        const owner = owners.get(fieldPath);
        const mapping = selectCatalogFieldMapping(fieldMapping, fieldPath);
        if (owner === "store") {
          skipped.push({
            entityId,
            fieldPath,
            reason: "store_owned",
            value,
            owner,
            ...(mapping ? { target: mapping.target, remoteKey: mapping.remoteKey } : {}),
          });
          return;
        }
        if (owner === undefined) return;
        const forced = forcedPushPaths.has(fieldPath);
        if (owner !== "platform" && !forced) return;
        if (heldPaths.has(fieldPath)) {
          skipped.push({
            entityId,
            fieldPath,
            reason: "held",
            value,
            owner,
            ...(mapping ? { target: mapping.target, remoteKey: mapping.remoteKey } : {}),
          });
          return;
        }
        if (!mapping) {
          skipped.push({ entityId, fieldPath, reason: "no_mapping", value, owner });
          return;
        }
        fields.push(pushCatalogField(fieldPath, value, mapping));
      };

      for (const attribute of attributes) {
        for (const field of attributeFields) {
          appendField(`attributes.${attribute.locale}.${field}`, attribute[field]);
        }
      }
      for (const [key, value] of Object.entries(entity.metadata ?? {})) {
        const fieldPath = `entity.metadata.${key}`;
        if (isValidFieldPath(fieldPath)) appendField(fieldPath, value);
      }
      for (const customField of customFields) {
        const fieldPath = `customFields.${customField.fieldName}.${customField.locale}`;
        if (isValidFieldPath(fieldPath)) appendField(fieldPath, customFieldValue(customField));
      }

      const media = await this.media.listEntityMedia(entity.id, { orgId });
      if (!media.ok) return PluginErr(media.error.message);
      const images: CatalogPushAssemblyImage[] = [];
      for (const attached of media.value) {
        const role = pushCatalogImageRole(attached.role);
        if (!role) continue;
        const fieldPath = `media.${role}` as FieldPath;
        const owner = owners.get(fieldPath);
        const mapping = selectCatalogFieldMapping(fieldMapping, fieldPath);
        const imageValue = [{ url: attached.url, role }];
        if (owner === "store") {
          skipped.push({
            entityId,
            fieldPath,
            reason: "store_owned",
            value: imageValue,
            owner,
            ...(mapping ? { target: mapping.target, remoteKey: mapping.remoteKey } : {}),
          });
          continue;
        }
        if (owner === undefined) continue;
        const forced = forcedPushPaths.has(fieldPath);
        if (owner !== "platform" && !forced) continue;
        if (heldPaths.has(fieldPath)) {
          skipped.push({
            entityId,
            fieldPath,
            reason: "held",
            value: imageValue,
            owner,
            ...(mapping ? { target: mapping.target, remoteKey: mapping.remoteKey } : {}),
          });
          continue;
        }
        if (!mapping) {
          skipped.push({ entityId, fieldPath, reason: "no_mapping", value: imageValue, owner });
          continue;
        }
        images.push({
          fieldPath,
          target: mapping.target,
          remoteKey: mapping.remoteKey,
          url: attached.url,
          role,
          sortOrder: attached.sortOrder,
          ...(attached.alt !== null ? { alt: attached.alt } : {}),
        });
      }
      fields.sort((left, right) => left.fieldPath.localeCompare(right.fieldPath));
      const item: CatalogPushAssemblyItem = {
        externalId: entityMapping.externalId,
        fields,
        ...(images.length > 0 ? { images } : {}),
      };
      items.push(item);
      if (options.recordRevision === true) revisionEntityIds.push(entity.id);
    }
    if (options.recordRevision === true && revisionEntityIds.length > 0) {
      const actor = createSystemActor(orgId);
      try {
        await this.transact(async (tx) => {
          const txContext = createTxContext(tx, { actor });
          for (const entityId of revisionEntityIds) {
            const revision = await this.catalog.recordEntityRevision(entityId, actor, "push", txContext);
            if (!revision.ok) throw new Error(revision.error.message);
          }
        });
      } catch (error) {
        return PluginErr(error instanceof Error ? error.message : "Failed to record catalog push revisions.");
      }
    }
    return Ok({ items, skipped, warnings: [...new Set(warnings)] });
  }

  async recordOutboundPush(
    orgId: string,
    storeId: string,
    outcomes: ChannelPushCatalogItemOutcome[],
    items: ChannelPushCatalogItem[],
    phase: "write-ahead" | "settle" = "settle",
  ): Promise<PluginResult<void>> {
    const outcomeByExternalId = new Map(outcomes.map((outcome) => [outcome.externalId, outcome]));
    const now = new Date();
    for (const item of items) {
      const outcome = outcomeByExternalId.get(item.externalId);
      const mapping = await this.db.select({
        id: channelEntityMap.id,
        externalId: channelEntityMap.externalId,
        forcedPushFieldPaths: channelEntityMap.forcedPushFieldPaths,
      }).from(channelEntityMap).where(and(
        eq(channelEntityMap.organizationId, orgId),
        eq(channelEntityMap.storeId, storeId),
        eq(channelEntityMap.kind, "entity"),
        eq(channelEntityMap.externalId, item.externalId),
      ));
      if (!mapping[0]) continue;
      if (outcome?.ok === true) {
        const fieldPaths = outboundFieldPaths(item);
        await this.db.update(channelEntityMap).set({
          outboundHash: canonicalOutboundHash(mapping[0].externalId, item, fieldPaths),
          outboundPushedAt: now,
          outboundFieldPaths: fieldPaths,
          // A force is an operator's conflict resolution. The write-ahead runs
          // before the connector is called and its outcomes are optimistic, so
          // consuming the force there would discard the resolution on a failed
          // push and the retry would silently omit the field.
          ...(phase === "settle"
            ? { forcedPushFieldPaths: (mapping[0].forcedPushFieldPaths ?? []).filter((path) => !fieldPaths.includes(path)) }
            : {}),
        }).where(eq(channelEntityMap.id, mapping[0].id));
      } else {
        await this.db.update(channelEntityMap).set({
          outboundHash: null,
          outboundPushedAt: null,
          outboundFieldPaths: [],
          syncHash: "",
        }).where(eq(channelEntityMap.id, mapping[0].id));
      }
    }
    return Ok(undefined);
  }

  async pushCatalogToStore(
    orgId: string,
    storeId: string,
    entityIds: string[],
  ): Promise<PluginResult<PushCatalogToStoreResult>> {
    const assembled = await this.buildCatalogPushItems(orgId, storeId, entityIds);
    if (!assembled.ok) return assembled;
    const store = await this.getStoreRecord(orgId, storeId);
    if (!store || store.status !== "connected") return PluginErr("Connected store not found.", "NOT_FOUND");
    const connector = this.connectors.get(store.provider);
    if (!connector?.pushCatalog) return PluginErr(`Catalog push is not supported by provider "${store.provider}".`);
    if (assembled.value.items.length === 0) return Ok({
      outcomes: [],
      skipped: assembled.value.skipped,
      warnings: assembled.value.warnings,
    });

    const writeAhead = await this.recordOutboundPush(
      orgId,
      storeId,
      assembled.value.items.map((item) => ({ externalId: item.externalId, ok: true })),
      assembled.value.items,
      "write-ahead",
    );
    if (!writeAhead.ok) return writeAhead;

    let result: Awaited<ReturnType<NonNullable<typeof connector.pushCatalog>>>;
    try {
      result = await connector.pushCatalog(store as ChannelStore, assembled.value.items);
    } catch (error) {
      const connectorError = {
        code: "CATALOG_PUSH_THROWN",
        message: error instanceof Error ? error.message : "Catalog push failed.",
      };
      const cleared = await this.recordOutboundPush(
        orgId,
        storeId,
        assembled.value.items.map((item) => ({ externalId: item.externalId, ok: false, error: connectorError })),
        assembled.value.items,
      );
      if (!cleared.ok) return cleared;
      return PluginErr(connectorError.message, connectorError.code);
    }
    if (!result.ok) {
      const cleared = await this.recordOutboundPush(
        orgId,
        storeId,
        assembled.value.items.map((item) => ({ externalId: item.externalId, ok: false, error: result.error })),
        assembled.value.items,
      );
      if (!cleared.ok) return cleared;
      return PluginErr(result.error.message, result.error.code);
    }

    const recorded = await this.recordOutboundPush(orgId, storeId, result.value.outcomes, assembled.value.items);
    if (!recorded.ok) return recorded;
    const successfulEntityIds = assembled.value.items
      .filter((item) => result.value.outcomes.some((outcome) => outcome.externalId === item.externalId && outcome.ok))
      .map((item) => item.externalId);
    if (successfulEntityIds.length > 0) {
      const mappings = await this.db.select({ entityId: channelEntityMap.entityId }).from(channelEntityMap).where(and(
        eq(channelEntityMap.organizationId, orgId),
        eq(channelEntityMap.storeId, storeId),
        eq(channelEntityMap.kind, "entity"),
        inArray(channelEntityMap.externalId, successfulEntityIds),
      ));
      const actor = createSystemActor(orgId);
      try {
        await this.transact(async (tx) => {
          const txContext = createTxContext(tx, { actor });
          for (const entityId of [...new Set(mappings.map((mapping) => mapping.entityId))]) {
            const revision = await this.catalog.recordEntityRevision(entityId, actor, "push", txContext);
            if (!revision.ok) throw new Error(revision.error.message);
          }
        });
      } catch (error) {
        return PluginErr(error instanceof Error ? error.message : "Failed to record catalog push revisions.");
      }
    }
    return Ok({
      ...result.value,
      skipped: assembled.value.skipped,
      warnings: assembled.value.warnings,
    });
  }

  async previewCatalogPush(
    orgId: string,
    storeId: string,
    entityIds?: string[],
  ): Promise<PluginResult<CatalogPushPreviewResult>> {
    const assembledEntityIds = await this.resolveCatalogPushEntityIds(orgId, storeId, entityIds);
    const assembled = await this.buildCatalogPushItems(orgId, storeId, assembledEntityIds);
    if (!assembled.ok) return assembled;
    const store = await this.getStoreRecord(orgId, storeId);
    if (!store || store.status !== "connected") return PluginErr("Connected store not found.", "NOT_FOUND");
    const connector = this.connectors.get(store.provider);
    if (!connector?.pushCatalog) return PluginErr(`Catalog push is not supported by provider "${store.provider}".`);
    if (assembled.value.items.length === 0) {
      return Ok({ items: [], skipped: assembled.value.skipped, warnings: assembled.value.warnings });
    }

    let result: Awaited<ReturnType<NonNullable<typeof connector.pushCatalog>>>;
    try {
      result = await connector.pushCatalog(store as ChannelStore, assembled.value.items, { dryRun: true });
    } catch (error) {
      return PluginErr(
        error instanceof Error ? error.message : "Catalog push preview failed.",
        "CATALOG_PREVIEW_THROWN",
      );
    }
    if (!result.ok) return PluginErr(result.error.message, result.error.code);
    const failed = result.value.outcomes.find((outcome) => !outcome.ok);
    if (failed) return PluginErr(
      failed.error?.message ?? `Catalog push preview failed for item "${failed.externalId}".`,
      failed.error?.code ?? "CATALOG_PREVIEW_FAILED",
    );

    const mappings = assembledEntityIds.length === 0
      ? []
      : await this.db.select({ entityId: channelEntityMap.entityId, externalId: channelEntityMap.externalId }).from(channelEntityMap).where(and(
        eq(channelEntityMap.organizationId, orgId),
        eq(channelEntityMap.storeId, storeId),
        eq(channelEntityMap.kind, "entity"),
        inArray(channelEntityMap.entityId, assembledEntityIds),
      ));
    const externalByEntity = new Map(mappings.map((mapping) => [mapping.entityId, mapping.externalId]));
    const skippedByExternal = new Map<string, CatalogPushFieldSkip[]>();
    for (const skipped of assembled.value.skipped) {
      const externalId = externalByEntity.get(skipped.entityId);
      if (!externalId) continue;
      const existing = skippedByExternal.get(externalId) ?? [];
      existing.push(skipped);
      skippedByExternal.set(externalId, existing);
    }
    const outcomeByExternalId = new Map(result.value.outcomes.map((outcome) => [outcome.externalId, outcome]));
    const beforeFor = (externalId: string, fieldPath: FieldPath): {
      before: CatalogPushPreviewBefore;
      beforeStatus: CatalogPushPreviewBeforeStatus;
    } => {
      const previousFields = outcomeByExternalId.get(externalId)?.previousFields;
      if (previousFields === undefined) {
        return { before: { status: "unavailable" }, beforeStatus: "unavailable" };
      }
      const previous = previousFields.find((field) => field.fieldPath === fieldPath);
      if (!previous) return { before: null, beforeStatus: "missing" };
      return { before: previous.value, beforeStatus: "value" };
    };

    const items = assembled.value.items.map((item) => {
      const diffs: CatalogPushPreviewDiff[] = item.fields.map((field) => ({
        fieldPath: field.fieldPath,
        target: field.target,
        remoteKey: field.remoteKey ?? null,
        ...beforeFor(item.externalId, field.fieldPath),
        after: field.value,
        owner: "platform",
        willWrite: true,
      }));
      for (const image of item.images ?? []) {
        diffs.push({
          fieldPath: image.fieldPath,
          target: image.target,
          remoteKey: image.remoteKey,
          ...beforeFor(item.externalId, image.fieldPath),
          after: pushFieldValue(item, image.fieldPath),
          owner: "platform",
          willWrite: true,
        });
      }
      for (const skipped of skippedByExternal.get(item.externalId) ?? []) {
        if (skipped.value === undefined || skipped.owner === undefined) continue;
        diffs.push({
          fieldPath: skipped.fieldPath,
          target: skipped.target ?? null,
          remoteKey: skipped.remoteKey ?? null,
          ...beforeFor(item.externalId, skipped.fieldPath),
          after: skipped.value,
          owner: skipped.owner,
          willWrite: false,
          reason: skipped.reason,
        });
      }
      return { externalId: item.externalId, diffs };
    });
    return Ok({ items, skipped: assembled.value.skipped, warnings: assembled.value.warnings });
  }

  async getCatalogWriteSettings(orgId: string, storeId: string): Promise<PluginResult<CatalogWriteSettings>> {
    const store = await this.getStoreRecord(orgId, storeId);
    if (!store) return PluginErr("Connected store not found.", "NOT_FOUND");
    const warnings: string[] = [];
    return Ok({
      enabled: store.catalogWriteEnabled === true,
      overrides: store.catalogFieldMapping,
      merged: this.resolveCatalogFieldMapping(store, undefined, warnings),
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  }

  async updateCatalogWriteEnabled(
    orgId: string,
    storeId: string,
    enabled: boolean,
  ): Promise<PluginResult<CatalogWriteSettings>> {
    const rows = await this.db
      .update(connectedStores)
      .set({ catalogWriteEnabled: enabled, updatedAt: new Date() })
      .where(and(eq(connectedStores.organizationId, orgId), eq(connectedStores.id, storeId)))
      .returning();
    if (!rows[0]) return PluginErr("Connected store not found.", "NOT_FOUND");
    return this.getCatalogWriteSettings(orgId, storeId);
  }

  async updateCatalogFieldMapping(
    orgId: string,
    storeId: string,
    mapping: unknown,
  ): Promise<PluginResult<CatalogWriteSettings>> {
    const store = await this.getStoreRecord(orgId, storeId);
    if (!store) return PluginErr("Connected store not found.", "NOT_FOUND");
    let normalized: CatalogFieldMapping;
    try {
      normalized = normalizeCatalogFieldMapping(mapping as CatalogFieldMappingInput, store.provider);
    } catch (error) {
      return PluginErr(error instanceof Error ? error.message : "Catalog mapping is invalid.", "INVALID_MAPPING");
    }
    await this.db
      .update(connectedStores)
      .set({ catalogFieldMapping: normalized, updatedAt: new Date() })
      .where(and(eq(connectedStores.organizationId, orgId), eq(connectedStores.id, storeId)));
    return this.getCatalogWriteSettings(orgId, storeId);
  }

  /**
   * Connects a store, or refreshes the grant of one this organization already holds for the same
   * provider and domain (a reconnect after an uninstall, or a re-authorization) — never a second row
   * for the same shop, which would import it twice.
   *
   * The row and the consumer's binding of it ({@link BindConnectedStore}) are one transaction. A
   * provider that subscribes per store is registered after commit, at an absolute address; the
   * consumer's follow-on work ({@link AfterStoreConnected}) runs after that.
   */
  /**
   * Connects a store and runs its follow-on work (subscribe, first import) before answering. For a
   * provider whose callback must be answered at once, see {@link saveConnectingStore} and
   * {@link completeConnect}, which this is the two halves of.
   */
  async connectStore(
    orgId: string,
    input: { provider: string; credentials: Record<string, unknown>; storeDomain: string; webhookSecret?: string },
    actor: StoreConnectActor,
  ): Promise<PluginResult<PublicConnectedStore>> {
    const saved = await this.saveConnectingStore(orgId, input, actor);
    if (!saved.ok) return saved;
    return this.completeConnect(orgId, saved.value.id, actor);
  }

  /**
   * Writes the store with its credentials in status `connecting`, bound to the actor's vendor, and
   * nothing else: no call to the store. Reconnecting a store this organization already has refreshes
   * its row instead of adding one.
   */
  async saveConnectingStore(
    orgId: string,
    input: { provider: string; credentials: Record<string, unknown>; storeDomain: string; webhookSecret?: string },
    actor: StoreConnectActor,
  ): Promise<PluginResult<PublicConnectedStore>> {
    const connector = this.connectors.get(input.provider);
    if (!connector) return PluginErr(`No connector registered for provider "${input.provider}".`, "NOT_FOUND");
    const storeDomain = connector.normalizeStoreDomain ? connector.normalizeStoreDomain(input.storeDomain) : input.storeDomain;
    if (!storeDomain) return PluginErr(`"${input.storeDomain}" does not name a ${input.provider} store.`, "INVALID_STORE_DOMAIN");
    if (connector.registerWebhooks && !this.options.publicUrl) {
      return PluginErr(`Connector "${input.provider}" subscribes per store and needs the plugin's publicUrl to give it an absolute address.`, "PUBLIC_URL_REQUIRED");
    }
    try {
      const store = await this.transact(async (tx) => {
        const [existing] = await tx.select().from(connectedStores).where(and(
          eq(connectedStores.organizationId, orgId),
          eq(connectedStores.provider, input.provider),
          eq(connectedStores.storeDomain, storeDomain),
        ));
        const rows = existing
          ? await tx.update(connectedStores).set({
            credentials: input.credentials,
            status: "connecting",
            statusReason: null,
            ...(existing.status !== "connected" ? { catalogWriteEnabled: false } : {}),
            webhookSecret: input.webhookSecret ?? existing.webhookSecret ?? crypto.randomUUID(),
            updatedAt: new Date(),
          }).where(eq(connectedStores.id, existing.id)).returning()
          : await tx.insert(connectedStores).values({
            organizationId: orgId,
            provider: input.provider,
            credentials: input.credentials,
            storeDomain,
            status: "connecting",
            webhookSecret: input.webhookSecret ?? crypto.randomUUID(),
          }).returning();
        const written = rows[0] as ConnectedStore | undefined;
        if (!written) throw new Error("The connected store row was not written.");
        await this.options.bindConnectedStore?.({ db: tx, store: written, actor });
        return written;
      });
      return Ok(redactStore(store));
    } catch (error) {
      return PluginErr(error instanceof Error ? error.message : "The store could not be connected.", error instanceof CommerceNotFoundError ? "NOT_FOUND" : "STORE_CONNECTION_REFUSED");
    }
  }

  /**
   * The work after the credentials are saved: subscribe the store to its connector's topics (all or
   * none — a partial subscription is removed), mark it `connected`, then the host's follow-on work.
   * A failure leaves the store in `error` with the reason the merchant will read, unless the host
   * already moved it (it disconnects a store it refuses).
   */
  async completeConnect(orgId: string, storeId: string, actor: StoreConnectActor): Promise<PluginResult<PublicConnectedStore>> {
    const store = await this.getStoreRecord(orgId, storeId);
    if (!store) return PluginErr("Connected store not found.", "NOT_FOUND");
    const connector = this.connectors.get(store.provider);
    if (!connector) return PluginErr(`No connector registered for provider "${store.provider}".`, "NOT_FOUND");
    const fail = async (message: string, code: string): Promise<PluginResult<never>> => {
      await this.db.update(connectedStores).set({ statusReason: message, updatedAt: new Date() }).where(eq(connectedStores.id, storeId));
      await this.db.update(connectedStores).set({ status: "error" }).where(and(eq(connectedStores.id, storeId), inArray(connectedStores.status, ["connecting", "connected"])));
      return PluginErr(message, code);
    };
    if (connector.registerWebhooks && this.options.publicUrl) {
      const callbackUrl = this.webhookCallbackUrl(storeId);
      const registration = await connector.registerWebhooks(store as ChannelStore, [...(connector.webhookTopics ?? [])], callbackUrl);
      if (!registration.ok) {
        await connector.unregisterWebhooks?.(store as ChannelStore, callbackUrl);
        return fail(registration.error.message, registration.error.code === CHANNEL_CREDENTIALS_REJECTED ? CHANNEL_CREDENTIALS_REJECTED : "CONNECTOR_REGISTRATION_FAILED");
      }
    }
    const [connected] = await this.db.update(connectedStores).set({ status: "connected", statusReason: null, updatedAt: new Date() })
      .where(and(eq(connectedStores.id, storeId), eq(connectedStores.status, "connecting"))).returning();
    const current = (connected ?? store) as ConnectedStore;
    if (this.options.afterStoreConnected) {
      try {
        await this.options.afterStoreConnected({ store: current, actor, connector, services: this.services });
      } catch (error) {
        return fail(error instanceof Error ? error.message : "The store connected but its follow-on work failed.", "AFTER_CONNECT_FAILED");
      }
    }
    return Ok(redactStore(current));
  }

  /** Where a store that subscribes per store delivers its webhooks: absolute, on this deployment's public origin. */
  webhookCallbackUrl(storeId: string): string {
    if (!this.options.publicUrl) throw new Error("The channel plugin has no publicUrl to build a webhook address on.");
    return new URL(`/api/channels/webhooks/${storeId}`, this.options.publicUrl).toString();
  }

  /** The store with credentials good for a call the host makes itself, e.g. its own Admin API write. */
  async liveStore(orgId: string, storeId: string): Promise<PluginResult<ChannelStore>> {
    const store = await this.getStoreRecord(orgId, storeId);
    if (!store || store.status !== "connected") return PluginErr("Connected store not found.", "NOT_FOUND");
    const connector = this.connectors.get(store.provider);
    if (!connector) return PluginErr(`No connector registered for provider "${store.provider}".`, "NOT_FOUND");
    const live = await resolveLiveCredentials(connector, this.db, store as ChannelStore);
    return live.ok ? Ok(live.value) : PluginErr(live.error.message, live.error.code);
  }

  /** The consumer's claims for a connection starting from this request. See {@link ConnectClaims}. */
  async connectClaims(context: StoreReadContext & { storeDomain: string }): Promise<PluginResult<Record<string, string>>> {
    if (!this.options.connectClaims) return Ok({});
    try {
      return Ok(await this.options.connectClaims(context));
    } catch (error) {
      return PluginErr(error instanceof Error ? error.message : "The connection could not be started.", error instanceof CommerceNotFoundError ? "NOT_FOUND" : "CONNECT_REFUSED");
    }
  }

  /** The caller's allow-list, or null for unconfined. See {@link ConfineStores}. */
  private async allowedStores(orgId: string, context: StoreReadContext | undefined): Promise<readonly string[] | null> {
    return this.options.confineStores ? await this.options.confineStores(context ?? { orgId, actor: null, raw: undefined }) : null;
  }

  /** NOT_FOUND for a store outside the caller's set, exactly as for one that does not exist. */
  async reachableStore(orgId: string, id: string, context: StoreReadContext | undefined): Promise<PluginResult<ConnectedStore>> {
    const allowed = await this.allowedStores(orgId, context);
    if (allowed !== null && !allowed.includes(id)) return PluginErr("Connected store not found.", "NOT_FOUND");
    const store = await this.getStoreRecord(orgId, id);
    return store ? Ok(store) : PluginErr("Connected store not found.", "NOT_FOUND");
  }

  async disconnectStore(orgId: string, id: string, context?: StoreReadContext): Promise<PluginResult<PublicConnectedStore>> {
    const store = await this.reachableStore(orgId, id, context);
    if (!store.ok) return store;
    return this.disconnectStoreSystem(orgId, id);
  }

  async disconnectStoreSystem(orgId: string, id: string, redactDomain = false): Promise<PluginResult<PublicConnectedStore>> {
    const before = await this.getStoreRecord(orgId, id);
    const connector = before ? this.connectors.get(before.provider) : undefined;
    if (before && connector?.unregisterWebhooks && this.options.publicUrl && before.status !== "disconnected") {
      // Best effort: the store is disconnected here whatever the provider answers.
      const removed = await connector.unregisterWebhooks(before as ChannelStore, this.webhookCallbackUrl(id));
      if (!removed.ok) console.warn(JSON.stringify({ event: "channel_unregister_webhooks_failed", provider: before.provider, storeId: id, code: removed.error.code, message: removed.error.message }));
    }
    const rows = await this.db
      .update(connectedStores)
      .set({
        status: "disconnected",
        credentials: {},
        webhookSecret: null,
        ...(redactDomain ? { storeDomain: "[REDACTED]" } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(connectedStores.organizationId, orgId), eq(connectedStores.id, id)))
      .returning();
    const store = rows[0] as ConnectedStore | undefined;
    if (!store) return PluginErr("Connected store not found.", "NOT_FOUND");
    return Ok(redactStore(store));
  }

  /**
   * Checks the store's webhook subscriptions and key and repairs what it can, when a merchant looks:
   * there is no scheduled check. At most once per {@link STORE_HEALTH_INTERVAL_MS} per store; inside
   * that window the last result is answered without calling the store.
   */
  async checkStoreHealth(orgId: string, id: string, context?: StoreReadContext): Promise<PluginResult<StoreHealth & { status: ConnectedStore["status"]; statusReason: string | null; lastEventAt: Date | null; cached: boolean }>> {
    const reached = await this.reachableStore(orgId, id, context);
    if (!reached.ok) return reached;
    const store = reached.value;
    const answer = (health: StoreHealth, current: ConnectedStore, cached: boolean) => Ok({ ...health, status: current.status, statusReason: current.statusReason, lastEventAt: current.lastEventAt, cached });
    if (store.health && Date.now() - Date.parse(store.health.checkedAt) < STORE_HEALTH_INTERVAL_MS) return answer(store.health, store, true);
    const connector = this.connectors.get(store.provider);
    if (!connector) return PluginErr(`No connector registered for provider "${store.provider}".`, "NOT_FOUND");
    let health: StoreHealth;
    const checkedAt = new Date().toISOString();
    if (store.status !== "connected" && store.status !== "error") {
      health = { checkedAt, webhooks: "not_applicable", repaired: 0, missing: [], keyValid: false };
    } else if (connector.webhookHealth && this.options.publicUrl) {
      const checked = await connector.webhookHealth(store as ChannelStore, this.webhookCallbackUrl(id));
      health = checked.ok
        ? { checkedAt, webhooks: checked.value.healthy ? (checked.value.repaired > 0 ? "repaired" : "ok") : "failing", repaired: checked.value.repaired, missing: checked.value.missing, keyValid: true }
        : { checkedAt, webhooks: "failing", repaired: 0, missing: [...(connector.webhookTopics ?? [])], keyValid: checked.error.code !== CHANNEL_CREDENTIALS_REJECTED, error: checked.error.message };
    } else if (connector.fetchStoreProfile) {
      // Subscribed per app (Shopify): nothing per store to repair, only the grant to check.
      const profile = await connector.fetchStoreProfile(store as ChannelStore);
      health = { checkedAt, webhooks: "not_applicable", repaired: 0, missing: [], keyValid: profile.ok || profile.error.code !== CHANNEL_CREDENTIALS_REJECTED, ...(profile.ok ? {} : { error: profile.error.message }) };
    } else {
      health = { checkedAt, webhooks: "not_applicable", repaired: 0, missing: [], keyValid: true };
    }
    const [updated] = await this.db.update(connectedStores).set({ health, updatedAt: new Date() }).where(and(eq(connectedStores.organizationId, orgId), eq(connectedStores.id, id))).returning();
    return answer(health, (updated ?? store) as ConnectedStore, false);
  }

  async getStore(orgId: string, id: string, context?: StoreReadContext): Promise<PluginResult<PublicConnectedStore>> {
    const store = await this.reachableStore(orgId, id, context);
    return store.ok ? Ok(redactStore(store.value)) : store;
  }

  async listStores(orgId: string, context?: StoreReadContext): Promise<PluginResult<PublicConnectedStore[]>> {
    const allowed = await this.allowedStores(orgId, context);
    // An empty allow-list means the caller may read NOTHING, stated here rather than left to the
    // query builder.
    //
    // MEASURED, because the first version of this comment claimed the guard was load-bearing and it
    // is not: removing this line leaves every row in `confine-store-reads.test.ts` green, so drizzle
    // already turns `inArray(id, [])` into a predicate that matches nothing. The guard is therefore
    // the CONTRACT rather than the rescue — `[]` means none, whatever the builder does with an empty
    // array on some future dialect or version. Worth keeping for that reason and not worth claiming
    // more for: the row that covers this case is really watching drizzle, not this line.
    if (allowed !== null && allowed.length === 0) return Ok([]);
    const predicate = allowed === null
      ? eq(connectedStores.organizationId, orgId)
      : and(eq(connectedStores.organizationId, orgId), inArray(connectedStores.id, [...allowed]));
    const rows = await this.db.select().from(connectedStores).where(predicate);
    return Ok((rows as ConnectedStore[]).map(redactStore));
  }

  async validateLineStock(
    orgId: string,
    lines: ChannelStockLine[],
    timeoutMs = 3_000,
  ): Promise<void> {
    const entities = await this.db
      .select({ id: sellableEntities.id, sourceStoreId: sellableEntities.sourceStoreId })
      .from(sellableEntities)
      .where(and(
        eq(sellableEntities.organizationId, orgId),
        inArray(sellableEntities.id, lines.map((line) => line.entityId)),
      ));
    const sourceByEntity = new Map(entities.map((entity) => [entity.id, entity.sourceStoreId]));
    const channelLines = lines.filter((line) => sourceByEntity.get(line.entityId) != null);
    const byStore = new Map<string, ChannelStockLine[]>();
    for (const line of channelLines) {
      const storeId = sourceByEntity.get(line.entityId)!;
      const storeLines = byStore.get(storeId) ?? [];
      storeLines.push(line);
      byStore.set(storeId, storeLines);
    }

    await Promise.all([...byStore].map(async ([storeId, storeLines]) => {
      const store = await this.getStoreRecord(orgId, storeId);
      if (!store || store.status !== "connected") {
        throw new CommerceValidationError(stockFailure(storeLines[0]!, "connected store is unavailable"));
      }
      const connector = this.connectors.get(store.provider);
      if (!connector) {
        throw new CommerceValidationError(stockFailure(storeLines[0]!, `no connector is registered for provider "${store.provider}"`));
      }

      const mappings = await this.db
        .select()
        .from(channelEntityMap)
        .where(and(
          eq(channelEntityMap.organizationId, orgId),
          eq(channelEntityMap.storeId, storeId),
        ));
      const inventoryIds = storeLines.map((line) => {
        const mapping = line.variantId
          ? mappings.find((item) => item.kind === "variant" && item.variantId === line.variantId)
          : undefined;
        return mapping ?? mappings.find((item) => item.kind === "entity" && item.entityId === line.entityId);
      });
      const missing = storeLines.find((line, index) => !inventoryIds[index]);
      if (missing) {
        throw new CommerceValidationError(stockFailure(missing, "external inventory mapping is missing"));
      }

      let inventory: Awaited<ReturnType<ChannelConnector["fetchInventory"]>>;
      try {
        inventory = await withTimeout(
          connector.fetchInventory(store as ChannelStore, inventoryIds.map((mapping) => mapping!.externalId)),
          timeoutMs,
        );
      } catch {
        throw new CommerceValidationError(stockFailure(storeLines[0]!, "inventory could not be confirmed"));
      }
      if (!inventory.ok) {
        throw new CommerceValidationError(stockFailure(storeLines[0]!, "inventory could not be confirmed"));
      }
      for (const [index, line] of storeLines.entries()) {
        const available = inventory.value.find((item) => item.externalId === inventoryIds[index]!.externalId)?.available;
        if (available === undefined || available < line.quantity) {
          throw new CommerceValidationError(stockFailure(line, `only ${available ?? 0} available for ${line.quantity} requested`));
        }
      }
    }));
  }

  /**
   * One page from the connector, nothing written. The host lands the page durably (R2 + its
   * ledger) and hands it to `convergeCatalogPage` from a queue consumer; the two halves are
   * separate so a consumer retry never re-fetches the merchant's API.
   */
  async fetchCatalogPage(
    orgId: string,
    storeId: string,
    cursor: string | null,
  ): Promise<PluginResult<{ items: ChannelCatalogItem[]; nextCursor: string | null }>> {
    const store = await this.getStoreRecord(orgId, storeId);
    if (!store || store.status !== "connected") return PluginErr("Connected store not found.", "NOT_FOUND");
    const connector = this.connectors.get(store.provider);
    if (!connector) return PluginErr(`No connector registered for provider "${store.provider}".`);
    const page = await this.readCatalogPage(connector, store as ChannelStore, cursor ?? undefined);
    if (!page.ok) return PluginErr(page.error.message);
    return Ok({ items: page.value.items, nextCursor: page.value.nextCursor ?? null });
  }

  /**
   * Converges a page: items this store has never mapped take the import fast path
   * (`catalog.importProducts`, one transaction, multi-row writes); items already mapped and
   * unchanged cost nothing; items mapped-but-changed, and orphans (an entity of this store with
   * the item's slug but no map row), take the editor path, which owns ownership and conflicts.
   *
   * Media: only each new item's hero is fetched here, streamed under `HERO_IMAGE_BYTE_CAP`, and
   * linked at entity level as `primary` plus to the variants it shows. The first photo of every
   * other variant, then the bounded gallery, come back in `deferredMedia` for the host to land later.
   */
  async convergeCatalogPage(
    orgId: string,
    storeId: string,
    rawItems: ChannelCatalogItem[],
    actor: Actor,
  ): Promise<PluginResult<CatalogPageConvergence>> {
    // A host may hand items it never read through this service's intake; the rule is idempotent.
    const items = rawItems.map(withDistinctVariantSkus);
    const failures: CatalogConvergenceFailure[] = [];
    const warnings: string[] = [];
    const skipped: CatalogFieldSkip[] = [];
    const conflicts: CatalogFieldConflict[] = [];
    const entityByExternalId = new Map<string, string>();
    let unchanged = 0;
    let updated = 0;

    const externalIds = [...new Set(items.map((item) => item.externalId))];
    const mappings = externalIds.length === 0 ? [] : await this.db.select().from(channelEntityMap).where(and(
      eq(channelEntityMap.organizationId, orgId),
      eq(channelEntityMap.storeId, storeId),
      eq(channelEntityMap.kind, "entity"),
      inArray(channelEntityMap.externalId, externalIds),
    ));
    const mappingByExternalId = new Map(mappings.map((row) => [row.externalId, row]));
    const slugFor = await this.resolveStoreSlugs(orgId, storeId, items.map((item) => item.slug));
    const slugs = [...new Set([...slugFor.values()].flatMap((resolved) => resolved.family))];
    const orphans = slugs.length === 0 ? [] : await this.db.select({ slug: sellableEntities.slug }).from(sellableEntities).where(and(
      eq(sellableEntities.organizationId, orgId),
      eq(sellableEntities.sourceStoreId, storeId),
      inArray(sellableEntities.slug, slugs),
    ));
    const orphanSlugs = new Set(orphans.map((row) => row.slug));
    const isOrphan = (handle: string): boolean => (slugFor.get(handle)?.family ?? [handle]).some((slug) => orphanSlugs.has(slug));

    const fresh: ChannelCatalogItem[] = [];
    const editor: ChannelCatalogItem[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.externalId)) {
        failures.push({ externalId: item.externalId, error: "duplicate-in-page: this externalId appears twice in the page." });
        continue;
      }
      seen.add(item.externalId);
      const mapping = mappingByExternalId.get(item.externalId);
      if (mapping && mapping.syncHash === hash(item)) {
        entityByExternalId.set(item.externalId, mapping.entityId);
        unchanged += 1;
      } else if (mapping || isOrphan(item.slug)) {
        editor.push(item);
      } else {
        fresh.push(item);
      }
    }

    if (editor.length > 0) {
      const result = await this.convergeCatalogItems(orgId, storeId, editor, actor);
      if (!result.ok) return result;
      failures.push(...result.value.failures);
      warnings.push(...result.value.warnings);
      skipped.push(...result.value.skipped);
      conflicts.push(...result.value.conflicts);
      const failedIds = new Set(result.value.failures.map((failure) => failure.externalId));
      const survivors = editor.filter((item) => !failedIds.has(item.externalId));
      survivors.forEach((item, index) => {
        const entityId = result.value.entityIds[index];
        if (entityId !== undefined) entityByExternalId.set(item.externalId, entityId);
      });
      updated += survivors.length;
    }

    const createdItems: Array<{ item: ChannelCatalogItem; entityId: string; variantIds: Record<string, string> }> = [];
    // Two stores onboarding at once can both resolve a handle as free and then both create it. The
    // loser's collision is transient: re-resolve those items once (the winner is now visible, so they
    // take the store-qualified slug) and try again. A second collision is reported as the item's.
    let pending = fresh;
    for (let attempt = 0; pending.length > 0; attempt += 1) {
      // The slug is resolved on the import row only: the map row's hash stays the hash of the item
      // as the store sent it, so the next page still reads it as unchanged.
      const report = await this.catalog.importProducts(
        pending.map((item) => toImportProduct({ ...item, slug: slugFor.get(item.slug)?.slug ?? item.slug })),
        { sourceStoreId: storeId, errorPolicy: "reject-failed-rows" },
        actor,
      );
      if (!report.ok) return PluginErr(report.error.message, report.error.code);
      const collided: Array<{ item: ChannelCatalogItem; failure: CatalogConvergenceFailure }> = [];
      for (const [index, row] of report.value.rows.entries()) {
        const item = pending[index];
        if (!item) continue;
        if (row.status === "failed") {
          const failure = { externalId: row.ref, error: `${row.code}: ${row.error}` };
          const lostSlug = row.code === "slug-conflict" || (row.code === "conflict" && isSlugConflict(row.error));
          if (attempt === 0 && lostSlug) collided.push({ item, failure });
          else failures.push(failure);
          continue;
        }
        warnings.push(...row.warnings);
        entityByExternalId.set(item.externalId, row.entityId);
        createdItems.push({ item, entityId: row.entityId, variantIds: row.variantIds });
      }
      pending = [];
      if (collided.length > 0) {
        const again = await this.resolveStoreSlugs(orgId, storeId, collided.map(({ item }) => item.slug));
        for (const { item, failure } of collided) {
          const before = slugFor.get(item.slug)?.slug ?? item.slug;
          const after = again.get(item.slug);
          // Retry only when another STORE took the handle: a slug held by a product made in
          // Merchant Center resolves to the same slug again, and stays the loud conflict it was.
          if (after === undefined || after.slug === before) { failures.push(failure); continue; }
          slugFor.set(item.slug, after);
          pending.push(item);
        }
      }
    }
    if (createdItems.length > 0) {
      const now = new Date();
      await this.db.insert(channelEntityMap).values(createdItems.flatMap(({ item, entityId, variantIds }) => [
        { organizationId: orgId, storeId, kind: "entity" as const, externalId: item.externalId, entityId, syncHash: hash(item), lastSyncedAt: now },
        ...item.variants.flatMap((variant) => {
          const variantId = variantIds[variant.externalId];
          return variantId === undefined ? [] : [{ organizationId: orgId, storeId, kind: "variant" as const, externalId: variant.externalId, entityId, variantId, syncHash: hash(variant), lastSyncedAt: now }];
        }),
      ])).onConflictDoNothing();
      // Every category / brand / tag link on an entity this page just created was written by this
      // import, so all of it is this store's on record (`channel_entity_links`) — one statement.
      const created = sql.join(createdItems.map(({ entityId }) => sql`${entityId}::uuid`), sql`, `);
      await this.db.execute(sql`
        insert into ${channelEntityLinks} (organization_id, store_id, entity_id, kind, target_id)
        select ${orgId}, ${storeId}::uuid, entity_id, 'category', category_id from ${entityCategories} where entity_id in (${created})
        union all select ${orgId}, ${storeId}::uuid, entity_id, 'brand', brand_id from ${entityBrands} where entity_id in (${created})
        union all select ${orgId}, ${storeId}::uuid, entity_id, 'tag', tag_id from ${entityTags} where entity_id in (${created})
        on conflict do nothing`);
    }

    const media = await this.importHeroes(orgId, createdItems, actor);
    const entityIds: string[] = [];
    const emitted = new Set<string>();
    for (const item of items) {
      const entityId = entityByExternalId.get(item.externalId);
      if (entityId === undefined || emitted.has(entityId)) continue;
      emitted.add(entityId);
      entityIds.push(entityId);
    }
    return Ok({
      created: createdItems.length,
      unchanged,
      updated,
      entityIds,
      failures,
      heroesImported: media.heroesImported,
      mediaFailures: media.mediaFailures,
      deferredMedia: media.deferredMedia,
      skipped,
      conflicts,
      warnings,
    });
  }

  private async importHeroes(
    orgId: string,
    createdItems: Array<{ item: ChannelCatalogItem; entityId: string; variantIds: Record<string, string> }>,
    actor: Actor,
  ): Promise<Pick<CatalogPageConvergence, "heroesImported" | "mediaFailures" | "deferredMedia">> {
    const mediaFailures: CatalogMediaFailure[] = [];
    const deferredMedia: CatalogDeferredMedia[] = [];
    const selections = createdItems.flatMap(({ item, entityId, variantIds }) => {
      const selection = selectImportImages(item);
      const deferred = [...selection.perVariant, ...selection.gallery];
      if (deferred.length > 0) deferredMedia.push({ externalId: item.externalId, entityId, images: deferred });
      return selection.hero ? [{ item, entityId, variantIds, hero: selection.hero }] : [];
    });
    if (selections.length === 0) return { heroesImported: 0, mediaFailures, deferredMedia };

    // One read for every hero the page might already hold (a re-import after the map was lost).
    const urlHashes = [...new Set(selections.map(({ hero }) => hash(hero.url)))];
    const existingAssets = await this.db.select({ id: mediaAssets.id, metadata: mediaAssets.metadata }).from(mediaAssets).where(and(
      eq(mediaAssets.organizationId, orgId),
      inArray(sql`${mediaAssets.metadata}->>'channelImageUrlHash'`, urlHashes),
    ));
    const assetByUrlHash = new Map<string, string>();
    for (const asset of existingAssets) {
      const urlHash = asset.metadata?.channelImageUrlHash;
      if (typeof urlHash === "string") assetByUrlHash.set(urlHash, asset.id);
    }

    type HeroOutcome = { entityId: string; mediaAssetId: string; hero: ChannelCatalogImage; variantIds: Record<string, string>; imported: boolean };
    const outcomes: HeroOutcome[] = [];
    const resolveHero = async ({ item, entityId, variantIds, hero }: (typeof selections)[number]): Promise<void> => {
      const urlHash = hash(hero.url);
      const existing = assetByUrlHash.get(urlHash);
      if (existing !== undefined) {
        outcomes.push({ entityId, mediaAssetId: existing, hero, variantIds, imported: false });
        return;
      }
      const fetched = await fetchBounded(hero.url, HERO_IMAGE_BYTE_CAP);
      const failure = (reason: CatalogMediaFailureReason, detail: string): void => {
        mediaFailures.push({ externalId: item.externalId, ...(hero.externalId !== undefined ? { imageExternalId: hero.externalId } : {}), url: hero.url, reason, detail });
      };
      if (!fetched.ok) {
        failure(fetched.reason, fetched.detail);
        return;
      }
      const extension = fetched.contentType.split("/", 2)[1] ?? "jpg";
      const uploaded = await this.media.upload({
        filename: `${hero.externalId ?? urlHash}.${extension}`,
        contentType: fetched.contentType,
        data: fetched.bytes.buffer,
        ...(hero.alt !== undefined ? { alt: hero.alt } : {}),
        metadata: { channelImageUrlHash: urlHash, ...(hero.externalId !== undefined ? { channelImageExternalId: hero.externalId } : {}) },
        origin: "imported",
      }, actor);
      if (!uploaded.ok) {
        failure(uploaded.error.code === "VALIDATION_FAILED" ? "unsupported" : "storage", uploaded.error.message);
        return;
      }
      assetByUrlHash.set(urlHash, uploaded.value.id);
      outcomes.push({ entityId, mediaAssetId: uploaded.value.id, hero, variantIds, imported: true });
    };
    // Six outbound connections per Worker invocation, two per image (download + storage put).
    const MAX_IN_FLIGHT = 3;
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, selections.length) }, async () => {
      for (;;) {
        const selection = selections[next];
        next += 1;
        if (selection === undefined) return;
        await resolveHero(selection);
      }
    }));

    if (outcomes.length > 0) {
      await writeEntityLinks(this.db, orgId, { media: outcomes.flatMap(({ entityId, mediaAssetId, hero, variantIds }) => [
        { entityId, variantId: null, mediaAssetId, role: "primary" as const, sortOrder: hero.sortOrder ?? 0 },
        ...(hero.variantExternalIds ?? []).flatMap((externalId) => {
          const variantId = variantIds[externalId];
          return variantId === undefined ? [] : [{ entityId, variantId, mediaAssetId, role: hero.role, sortOrder: hero.sortOrder ?? 0 }];
        }),
      ]) });
    }
    return { heroesImported: outcomes.filter((outcome) => outcome.imported).length, mediaFailures, deferredMedia };
  }

  async importCatalog(
    orgId: string,
    storeId: string,
    actor: Actor,
    options: { maxItems: number },
  ): Promise<PluginResult<{
    imported: number;
    cursor: string | null;
    exhausted: boolean;
    skipped?: CatalogFieldSkip[];
    conflicts?: CatalogFieldConflict[];
    warnings?: string[];
    failures?: CatalogConvergenceFailure[];
    /**
     * The entities this batch committed — see `CatalogConvergenceStats.entityIds`.
     *
     * Declared on the BOUNDED overload only. This is the one a per-batch step wrapper calls, so it
     * is the one with a page to name. The unbounded overload walks a whole catalogue and would hand
     * back thousands of ids across a durable step boundary, which is the opposite of the point.
     *
     * Required rather than optional here, unlike its siblings, for the reason the implementation
     * states: a caller must be able to tell "this batch committed nothing" from "this build does
     * not report entities", and one of those is `[]` while the other is `undefined`.
     */
    entityIds: string[];
  }>>;
  async importCatalog(
    orgId: string,
    storeId: string,
    actor: Actor,
    options?: undefined,
  ): Promise<PluginResult<{
    imported: number;
    cursor: string | null;
    skipped?: CatalogFieldSkip[];
    conflicts?: CatalogFieldConflict[];
    warnings?: string[];
    failures?: CatalogConvergenceFailure[];
  }>>;
  async importCatalog(
    orgId: string,
    storeId: string,
    actor: Actor,
    options?: { maxItems?: number },
  ): Promise<PluginResult<{
    imported: number;
    cursor: string | null;
    exhausted?: boolean;
    skipped?: CatalogFieldSkip[];
    conflicts?: CatalogFieldConflict[];
    warnings?: string[];
    failures?: CatalogConvergenceFailure[];
    entityIds?: string[];
  }>> {
    const store = await this.getStoreRecord(orgId, storeId);
    if (!store || store.status !== "connected") {
      return PluginErr("Connected store not found.", "NOT_FOUND");
    }
    const connector = this.connectors.get(store.provider);
    if (!connector) return PluginErr(`No connector registered for provider "${store.provider}".`);

    const maxItems = options?.maxItems;
    const bounded = maxItems !== undefined;

    if (!bounded) {
      const resume = parseImportResumePosition(store.catalogCursor);
      const items: ChannelCatalogItem[] = [];
      let pageCursor: string | undefined = resume.pageCursor ?? undefined;
      do {
        const page = await this.readCatalogPage(connector, store as ChannelStore, pageCursor);
        if (!page.ok) return PluginErr(page.error.message);
        items.push(...page.value.items);
        pageCursor = page.value.nextCursor ?? undefined;
      } while (pageCursor);

      const result = await this.convergeCatalogItems(orgId, storeId, items, actor);
      if (!result.ok) return result;

      await this.db
        .update(connectedStores)
        .set({ catalogCursor: null, lastSyncAt: new Date(), updatedAt: new Date() })
        .where(and(eq(connectedStores.organizationId, orgId), eq(connectedStores.id, storeId)));
      return Ok({
        imported: result.value.imported,
        cursor: null,
        ...(result.value.skipped.length > 0 ? { skipped: uniqueSkipped(result.value.skipped) } : {}),
        ...(result.value.conflicts.length > 0 ? { conflicts: result.value.conflicts } : {}),
        ...(result.value.warnings.length > 0 ? { warnings: result.value.warnings } : {}),
        ...(result.value.failures.length > 0 ? { failures: result.value.failures } : {}),
      });
    }

    let { pageCursor, offset } = parseImportResumePosition(store.catalogCursor);
    let remaining = maxItems;
    let exhausted = false;
    let totalImported = 0;
    const skipped: CatalogFieldSkip[] = [];
    const conflicts: CatalogFieldConflict[] = [];
    const warnings: string[] = [];
    const failures: CatalogConvergenceFailure[] = [];
    const entityIds: string[] = [];

    while (remaining > 0) {
      const page = await this.readCatalogPage(connector, store as ChannelStore, pageCursor ?? undefined);
      if (!page.ok) return PluginErr(page.error.message);

      const pageItems = page.value.items;
      const slice = pageItems.slice(offset);
      const batchSize = Math.min(remaining, slice.length);

      if (batchSize === 0) {
        if (page.value.nextCursor) {
          pageCursor = page.value.nextCursor;
          offset = 0;
          continue;
        }
        exhausted = true;
        break;
      }

      const batch = slice.slice(0, batchSize);
      const result = await this.convergeCatalogItems(orgId, storeId, batch, actor);
      if (!result.ok) return result;

      totalImported += result.value.imported;
      remaining -= result.value.consumed;
      skipped.push(...result.value.skipped);
      conflicts.push(...result.value.conflicts);
      warnings.push(...result.value.warnings);
      failures.push(...result.value.failures);
      entityIds.push(...result.value.entityIds);
      offset += result.value.consumed;

      if (offset >= pageItems.length) {
        if (page.value.nextCursor) {
          pageCursor = page.value.nextCursor;
          offset = 0;
        } else {
          exhausted = true;
        }
      }

      if (remaining === 0) break;
      if (exhausted) break;
    }

    const catalogCursor = exhausted ? null : encodeImportResumePosition({ pageCursor, offset });
    await this.db
      .update(connectedStores)
      .set({
        catalogCursor,
        ...(exhausted ? { lastSyncAt: new Date() } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(connectedStores.organizationId, orgId), eq(connectedStores.id, storeId)));

    return Ok({
      imported: totalImported,
      cursor: catalogCursor,
      exhausted,
      ...(skipped.length > 0 ? { skipped: uniqueSkipped(skipped) } : {}),
      ...(conflicts.length > 0 ? { conflicts } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      // Always surfaced when non-empty. A silently dropped product is worse than the halt this
      // replaced: the caller must be able to see which externalIds did not land.
      ...(failures.length > 0 ? { failures } : {}),
      // UNCONDITIONAL, unlike every optional field above it, and the asymmetry is deliberate.
      // The caller turns this into one queue message naming the page it just converged. If the key
      // were omitted when empty, a caller reading `outcome.entityIds` could not tell "this batch
      // committed nothing" from "this plugin version does not report entities" — both read as
      // `undefined`, and the second one silently produces an import that enqueues nothing. An
      // empty array says the first; a missing key says the second. They deserve different answers.
      entityIds,
    });
  }

  private async promoteLegacyAttributes(
    orgId: string,
    storeId: string,
    actor: Actor,
    dryRun: boolean,
  ): Promise<PluginResult<number>> {
    const mappings = await this.db.select().from(channelEntityMap).where(and(
      eq(channelEntityMap.organizationId, orgId),
      eq(channelEntityMap.storeId, storeId),
      eq(channelEntityMap.kind, "entity"),
    ));
    let created = 0;
    for (const entityId of new Set(mappings.map((mapping) => mapping.entityId))) {
      const [entity] = await this.db.select().from(sellableEntities).where(and(
        eq(sellableEntities.organizationId, orgId),
        eq(sellableEntities.id, entityId),
      ));
      if (!entity) continue;
      const attributes = await this.db.select().from(sellableAttributes).where(eq(sellableAttributes.entityId, entity.id));
      if (attributes.length > 0) continue;
      const metadata = entity.metadata ?? {};
      if (typeof metadata.title !== "string") continue;
      const owners = await this.catalog.resolveFieldOwners(entity.id, storeId);
      if (owners.get("attributes.en.title") === "platform") continue;
      if (dryRun) {
        created += 1;
        continue;
      }
      const promoted = await this.catalog.setAttributes(entity.id, "en", {
        title: metadata.title,
        ...(typeof metadata.description === "string" ? { description: metadata.description } : {}),
      }, actor, CHANNEL_CONVERGENCE_CTX);
      if (!promoted.ok) return PluginErr(promoted.error.message);
      const [confirmed] = await this.db.select({ id: sellableAttributes.id, title: sellableAttributes.title, description: sellableAttributes.description }).from(sellableAttributes).where(and(
        eq(sellableAttributes.entityId, entity.id),
        eq(sellableAttributes.locale, "en"),
      ));
      if (!confirmed || confirmed.title !== metadata.title || (typeof metadata.description === "string" && confirmed.description !== metadata.description)) {
        return PluginErr(`Legacy attributes for entity "${entity.id}" were not persisted.`);
      }
      const nextMetadata = { ...metadata };
      delete nextMetadata.title;
      if (typeof metadata.description === "string") delete nextMetadata.description;
      await this.db.update(sellableEntities).set({ metadata: nextMetadata, updatedAt: new Date() }).where(and(
        eq(sellableEntities.organizationId, orgId),
        eq(sellableEntities.id, entity.id),
      ));
      created += 1;
    }
    return Ok(created);
  }

  private async saveBackfillState(orgId: string, storeId: string, state: BackfillState): Promise<void> {
    const [store] = await this.db.select({ breakerState: connectedStores.breakerState }).from(connectedStores).where(and(
      eq(connectedStores.organizationId, orgId),
      eq(connectedStores.id, storeId),
    ));
    await this.db.update(connectedStores).set({
      breakerState: { ...(store?.breakerState ?? {}), catalogBackfill: state },
      updatedAt: new Date(),
    }).where(and(eq(connectedStores.organizationId, orgId), eq(connectedStores.id, storeId)));
  }

  async backfillCatalog(
    orgId: string,
    storeId: string,
    actor: Actor,
    options: BackfillCatalogOptions = {},
  ): Promise<PluginResult<BackfillCatalogReport>> {
    const store = await this.getStoreRecord(orgId, storeId);
    if (!store || store.status !== "connected") return PluginErr("Connected store not found.", "NOT_FOUND");
    const connector = this.connectors.get(store.provider);
    if (!connector) return PluginErr(`No connector registered for provider "${store.provider}".`);
    const dryRun = options.dryRun === true;
    const saved = store.breakerState.catalogBackfill;
    const savedState = saved && typeof saved === "object" ? saved as unknown as BackfillState : undefined;
    // Undefined resume derives from persisted state, so a retried job or a
    // re-triggered run continues an unfinished backfill instead of restarting.
    const resume = options.resume ?? (savedState !== undefined && !savedState.completedAt);
    if (resume && savedState?.completedAt && savedState.cursor === null) {
      return Ok({
        ...savedState.report,
        cursor: null,
        complete: true,
        ...(savedState.skipped?.length ? { skipped: savedState.skipped } : {}),
        ...(savedState.conflicts?.length ? { conflicts: savedState.conflicts } : {}),
        ...(savedState.warnings?.length ? { warnings: savedState.warnings } : {}),
      });
    }
    const report = resume && savedState ? { ...savedState.report } : {
      entitiesTouched: 0,
      attributesCreated: 0,
      mediaImported: 0,
      variantsGivenOptionValues: 0,
    };
    const skipped = resume && savedState?.skipped ? [...savedState.skipped] : [];
    const conflicts = resume && savedState?.conflicts ? [...savedState.conflicts] : [];
    const warnings = resume && savedState?.warnings ? [...savedState.warnings] : [];
    const promoted = await this.promoteLegacyAttributes(orgId, storeId, actor, dryRun);
    if (!promoted.ok) return promoted;
    report.attributesCreated += promoted.value;
    let cursor = resume && savedState?.cursor ? savedState.cursor : undefined;
    let pages = 0;
    if (!dryRun) {
      await this.saveBackfillState(orgId, storeId, {
        cursor: cursor ?? null,
        report,
        ...(skipped.length > 0 ? { skipped: uniqueSkipped(skipped) } : {}),
        ...(conflicts.length > 0 ? { conflicts } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    }
    do {
      const page = await this.readCatalogPage(connector, store as ChannelStore, cursor);
      if (!page.ok) return PluginErr(page.error.message);
      const converged = await this.convergeCatalogItems(orgId, storeId, page.value.items, actor, true, dryRun);
      if (!converged.ok) return converged;
      report.entitiesTouched += converged.value.entitiesTouched;
      report.attributesCreated += converged.value.attributesCreated;
      report.mediaImported += converged.value.mediaImported;
      report.variantsGivenOptionValues += converged.value.variantsGivenOptionValues;
      skipped.push(...converged.value.skipped);
      conflicts.push(...converged.value.conflicts);
      warnings.push(...converged.value.warnings);
      cursor = page.value.nextCursor ?? undefined;
      pages += 1;
      // The final state is written once with completedAt below; a cursor-null
      // checkpoint without it would read as a fresh start after a crash.
      if (!dryRun && cursor) {
        await this.saveBackfillState(orgId, storeId, {
          cursor,
          report,
          ...(skipped.length > 0 ? { skipped: uniqueSkipped(skipped) } : {}),
          ...(conflicts.length > 0 ? { conflicts } : {}),
          ...(warnings.length > 0 ? { warnings } : {}),
        });
      }
      if (options.maxPages !== undefined && pages >= options.maxPages && cursor) {
        return Ok({
          ...report,
          cursor,
          complete: false,
          ...(skipped.length > 0 ? { skipped: uniqueSkipped(skipped) } : {}),
          ...(conflicts.length > 0 ? { conflicts } : {}),
          ...(warnings.length > 0 ? { warnings } : {}),
        });
      }
    } while (cursor);
    if (!dryRun) {
      await this.saveBackfillState(orgId, storeId, {
        cursor: null,
        report,
        ...(skipped.length > 0 ? { skipped: uniqueSkipped(skipped) } : {}),
        ...(conflicts.length > 0 ? { conflicts } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
        completedAt: new Date().toISOString(),
      });
    }
    return Ok({
      ...report,
      cursor: null,
      complete: true,
      ...(skipped.length > 0 ? { skipped: uniqueSkipped(skipped) } : {}),
      ...(conflicts.length > 0 ? { conflicts } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  }

  private async estimateCatalogItems(
    orgId: string,
    storeId: string,
    items: ChannelCatalogItem[],
  ): Promise<PluginResult<CatalogConvergenceStats>> {
    const stats: CatalogConvergenceStats = {
      imported: 0,
      converged: 0,
      entitiesTouched: 0,
      attributesCreated: 0,
      mediaImported: 0,
      variantsGivenOptionValues: 0,
      consumed: 0,
      skipped: [],
      conflicts: [],
      warnings: [],
      failures: [],   // a dry run converges nothing, so it can fail nothing
      entityIds: [],  // ...and commits nothing, so it names nothing
    };
    const assets = await this.db.select().from(mediaAssets).where(eq(mediaAssets.organizationId, orgId));
    for (const item of items) {
      stats.consumed += 1;
      const [entityMapping] = await this.db.select().from(channelEntityMap).where(and(
        eq(channelEntityMap.organizationId, orgId),
        eq(channelEntityMap.storeId, storeId),
        eq(channelEntityMap.kind, "entity"),
        eq(channelEntityMap.externalId, item.externalId),
      ));
      if (!entityMapping) {
        stats.imported += 1;
        stats.entitiesTouched += 1;
        stats.attributesCreated += item.attributes?.length || 1;
        stats.variantsGivenOptionValues += item.variants.filter((variant) => Object.keys(variant.optionValues ?? {}).some((name) => item.options?.some((option) => option.name === name))).length;
        stats.mediaImported += item.images?.length ?? 0;
        continue;
      }
      const [entity] = await this.db.select().from(sellableEntities).where(and(
        eq(sellableEntities.organizationId, orgId),
        eq(sellableEntities.id, entityMapping.entityId),
      ));
      if (!entity) continue;
      const owners = await this.catalog.resolveFieldOwners(entity.id, storeId);
      stats.skipped.push(...importedFieldPaths(item)
        .filter((path) => owners.get(path) === "platform")
        .map((fieldPath) => ({ entityId: entity.id, fieldPath })));
      let touched = false;
      const attributes = await this.db.select().from(sellableAttributes).where(eq(sellableAttributes.entityId, entity.id));
      const locales = new Set(attributes.map((attribute) => attribute.locale));
      const metadata = entity.metadata ?? {};
      if (attributes.length === 0 && typeof metadata.title === "string") {
        locales.add("en");
        touched = true;
      }
      const sourceAttributes = item.attributes?.length
        ? item.attributes
        : [{ locale: "en", title: item.title, ...(item.description !== undefined ? { description: item.description } : {}) }];
      for (const attribute of sourceAttributes) {
        if (!locales.has(attribute.locale)) {
          stats.attributesCreated += 1;
          locales.add(attribute.locale);
          touched = true;
        }
      }
      const remoteMetadata = mergeMetadata(entity.metadata, item.metadata ?? {});
      const remoteStatus = item.status ?? (entity.status === "archived" ? "active" : undefined);
      const entityChanged = entity.slug !== item.slug
        || hash(remoteMetadata) !== hash(entity.metadata ?? {})
        || (remoteStatus !== undefined && remoteStatus !== entity.status);
      if (entityChanged) {
        stats.converged += 1;
        touched = true;
      }

      const optionValueIds = new Map<string, Map<string, string>>();
      const existingTypes = await this.db.select().from(optionTypes).where(eq(optionTypes.entityId, entity.id));
      for (const sourceType of item.options ?? []) {
        const existingType = existingTypes.find((optionType) => optionType.name === sourceType.name);
        if (!existingType) {
          touched = true;
          optionValueIds.set(sourceType.name, new Map(sourceType.values.map((value) => [value.value, `new:${sourceType.name}:${value.value}`])));
          continue;
        }
        const existingValues = await this.db.select().from(optionValues).where(eq(optionValues.optionTypeId, existingType.id));
        const valueIds = new Map<string, string>();
        for (const sourceValue of sourceType.values) {
          const existingValue = existingValues.find((value) => value.value === sourceValue.value);
          if (!existingValue) touched = true;
          valueIds.set(sourceValue.value, existingValue?.id ?? `new:${sourceType.name}:${sourceValue.value}`);
        }
        optionValueIds.set(sourceType.name, valueIds);
      }

      const variantMappings = await this.db.select().from(channelEntityMap).where(and(
        eq(channelEntityMap.organizationId, orgId),
        eq(channelEntityMap.storeId, storeId),
        eq(channelEntityMap.kind, "variant"),
        eq(channelEntityMap.entityId, entity.id),
      ));
      const variantIds = new Map<string, string>();
      for (const sourceVariant of item.variants) {
        const mapping = variantMappings.find((row) => row.externalId === sourceVariant.externalId);
        const variantId = mapping?.variantId ?? `new:${sourceVariant.externalId}`;
        variantIds.set(sourceVariant.externalId, variantId);
        const desiredIds = [...new Set(Object.entries(sourceVariant.optionValues ?? {})
          .map(([name, value]) => optionValueIds.get(name)?.get(value))
          .filter((optionValueId): optionValueId is string => optionValueId !== undefined))].sort();
        if (!mapping?.variantId) {
          if (desiredIds.length > 0) stats.variantsGivenOptionValues += 1;
          touched = true;
          continue;
        }
        const current = await this.db.select().from(variantOptionValues).where(eq(variantOptionValues.variantId, mapping.variantId));
        const currentIds = current.map((row) => row.optionValueId).sort();
        if (currentIds.length !== desiredIds.length || currentIds.some((id, index) => id !== desiredIds[index])) {
          if (desiredIds.length > 0) stats.variantsGivenOptionValues += 1;
          touched = true;
        }
      }

      const links = await this.db.select().from(entityMedia).where(eq(entityMedia.entityId, entity.id));
      for (const image of item.images ?? []) {
        const urlHash = hash(image.url);
        const asset = assets.find((row) => {
          const assetMetadata = row.metadata ?? {};
          return (image.externalId != null && assetMetadata.channelImageExternalId === image.externalId)
            || assetMetadata.channelImageUrlHash === urlHash;
        });
        const mediaAssetId = asset?.id ?? `new:${urlHash}`;
        if (!asset) stats.mediaImported += 1;
        const targets = image.variantExternalIds?.length
          ? image.variantExternalIds.map((externalId) => ({ externalId, variantId: variantIds.get(externalId) }))
          : [{ externalId: undefined, variantId: undefined }];
        for (const target of targets) {
          if (image.variantExternalIds?.length && !target.variantId) {
            stats.warnings.push(`Skipped image "${image.externalId ?? image.url}" for unmapped variant "${target.externalId}".`);
            continue;
          }
          const existingLink = links.find((link) => link.mediaAssetId === mediaAssetId && (target.variantId === undefined ? link.variantId === null : link.variantId === target.variantId));
          if (!existingLink) touched = true;
        }
      }
      if (touched) stats.entitiesTouched += 1;
    }
    return Ok(stats);
  }

  /**
   * Link provenance for products imported before `channel_entity_links` existed: a mapped product
   * of this batch with NOTHING on record for this store claims, once, the category / brand / tag
   * links it has that the store lists NOW. Runs for unchanged items too — an unchanged item skips
   * its converge, and the converge that follows may already be the drop, too late to claim.
   *
   * Its limit, stated rather than hidden: a link upstream had dropped BEFORE this claim was never
   * the store's on record, so it stays (the stale set the old add-only converge left; repaired by a
   * re-import, not by a heuristic delete). One select per batch; the claims only while unclaimed
   * products remain.
   */
  private async claimUnrecordedLinks(orgId: string, storeId: string, items: ChannelCatalogItem[]): Promise<void> {
    // Nothing listed, nothing to claim: no query. Otherwise one select per converge call (a batch),
    // never one per product.
    if (!items.some((item) => (item.tags?.length ?? 0) > 0 || (item.categories?.length ?? 0) > 0 || item.brand !== undefined)) return;
    const unclaimed = await this.db.select({ externalId: channelEntityMap.externalId, entityId: channelEntityMap.entityId }).from(channelEntityMap).where(and(
      eq(channelEntityMap.organizationId, orgId),
      eq(channelEntityMap.storeId, storeId),
      eq(channelEntityMap.kind, "entity"),
      inArray(channelEntityMap.externalId, items.map((item) => item.externalId)),
      sql`not exists (select 1 from ${channelEntityLinks} where ${channelEntityLinks.storeId} = ${channelEntityMap.storeId} and ${channelEntityLinks.entityId} = ${channelEntityMap.entityId})`,
    ));
    if (unclaimed.length === 0) return;
    const entityOf = new Map(unclaimed.map((row) => [row.externalId, row.entityId]));
    const listed = (pick: (item: ChannelCatalogItem) => readonly string[]) => items.flatMap((item) => {
      const entityId = entityOf.get(item.externalId);
      return entityId === undefined ? [] : [...new Set(pick(item))].map((slug) => sql`(${entityId}::uuid, ${slug}::text)`);
    });
    const claim = async (kind: "category" | "brand" | "tag", pairs: SQL[], link: SQL) => {
      if (pairs.length === 0) return;
      await this.db.execute(sql`
        insert into ${channelEntityLinks} (organization_id, store_id, entity_id, kind, target_id)
        select ${orgId}, ${storeId}::uuid, v.entity_id, ${kind}, t.id
        from (values ${sql.join(pairs, sql`, `)}) as v(entity_id, slug)
        ${link}
        on conflict do nothing`);
    };
    await claim("category", listed((item) => item.categories ?? []),
      sql`join ${categories} t on t.slug = v.slug and t.organization_id = ${orgId}
        join ${entityCategories} l on l.entity_id = v.entity_id and l.category_id = t.id`);
    await claim("brand", listed((item) => (item.brand ? [item.brand] : [])),
      sql`join ${brands} t on t.slug = v.slug and t.organization_id = ${orgId}
        join ${entityBrands} l on l.entity_id = v.entity_id and l.brand_id = t.id`);
    await claim("tag", listed((item) => item.tags ?? []),
      sql`join ${tags} t on t.slug = v.slug and t.organization_id = ${orgId}
        join ${entityTags} l on l.entity_id = v.entity_id and l.tag_id = t.id`);
  }

  private async convergeCatalogItems(
    orgId: string,
    storeId: string,
    rawItems: ChannelCatalogItem[],
    actor: Actor,
    force = false,
    dryRun = false,
  ): Promise<PluginResult<CatalogConvergenceStats>> {
    const items = rawItems.map(withDistinctVariantSkus);
    if (dryRun) return this.estimateCatalogItems(orgId, storeId, items);
    // One converge, one taxonomy snapshot. Cleared HERE rather than left to the service's lifetime:
    // the instance can outlive a batch on a warm isolate, and a taxonomy cached across batches would
    // go stale in a way nothing reports.
    this.taxonomyCache = null;
    let imported = 0;
    let converged = 0;
    let entitiesTouched = 0;
    let attributesCreated = 0;
    let mediaImported = 0;
    let variantsGivenOptionValues = 0;
    let consumed = 0;
    const skipped: CatalogFieldSkip[] = [];
    const conflicts: CatalogFieldConflict[] = [];
    const warnings: string[] = [];
    const failures: CatalogConvergenceFailure[] = [];
    const entityIds: string[] = [];
    const committed = new Set<string>();
    // One resolution for the whole batch, not two round trips per changed product.
    const slugFor = await this.resolveStoreSlugs(orgId, storeId, items.map((item) => item.slug));
    // Upstream SKU/barcode changes on already-mapped variants, for the whole batch at once, so that
    // variants exchanging SKUs across products in this batch land together.
    const identity = await this.applyUpstreamVariantIdentity(orgId, storeId, items);
    await this.claimUnrecordedLinks(orgId, storeId, items);
    for (const item of items) {
      consumed += 1;
      try {
      const remoteHash = hash(item);
      const existing = await this.db
        .select()
        .from(channelEntityMap)
        .where(and(
          eq(channelEntityMap.organizationId, orgId),
          eq(channelEntityMap.storeId, storeId),
          eq(channelEntityMap.kind, "entity"),
          eq(channelEntityMap.externalId, item.externalId),
        ));
      let entityMapping = existing.find((entry) => entry.kind === "entity");
      let entityId: string | undefined;
      let isNew = false;
      let adoptedOrphan = false;
      let entityTouched = false;
      let existingEntity: typeof sellableEntities.$inferSelect | undefined;
      if (entityMapping) {
        const [entity] = await this.db.select().from(sellableEntities).where(and(
          eq(sellableEntities.organizationId, orgId),
          eq(sellableEntities.id, entityMapping.entityId),
        ));
        if (!entity) {
          await this.db.delete(channelEntityMap).where(and(
            eq(channelEntityMap.organizationId, orgId),
            eq(channelEntityMap.storeId, storeId),
            eq(channelEntityMap.entityId, entityMapping.entityId),
          ));
          entityMapping = undefined;
        } else {
          entityId = entityMapping.entityId;
          existingEntity = entity;
        }
      }
      let resolvedSlug = slugFor.get(item.slug) ?? { slug: item.slug, family: [item.slug] };
      // A slug lost to a concurrent writer (another store onboarding the same handle) is transient:
      // re-resolve once, and the winner being visible now moves this item to its qualified slug.
      const reresolveSlug = async (): Promise<void> => {
        resolvedSlug = (await this.resolveStoreSlugs(orgId, storeId, [item.slug])).get(item.slug) ?? resolvedSlug;
        slugFor.set(item.slug, resolvedSlug);
      };
      if (entityId === undefined) {
        const [orphan] = await this.db.select().from(sellableEntities).where(and(
          eq(sellableEntities.organizationId, orgId),
          eq(sellableEntities.sourceStoreId, storeId),
          inArray(sellableEntities.slug, resolvedSlug.family),
        )).limit(1);
        if (orphan) {
          entityId = orphan.id;
          existingEntity = orphan;
          adoptedOrphan = true;
        } else {
          const status = item.status;
          const createEntity = (slug: string): Promise<string> => this.transact(async (tx) => {
            const txContext = createTxContext(tx, { actor });
            const created = await this.catalog.create({
              type: "product",
              slug,
              sourceStoreId: storeId,
              metadata: mergeMetadata(undefined, item.metadata ?? {}),
              ...(status !== undefined ? { status, isVisible: status === "active" } : {}),
            }, actor, txContext);
            if (!created.ok) throw new Error(created.error.message);
            await tx.insert(channelEntityMap).values({
              organizationId: orgId,
              storeId,
              kind: "entity",
              externalId: item.externalId,
              entityId: created.value.id,
              syncHash: PENDING_ENTITY_MAP_SYNC_HASH,
              heldFieldPaths: [],
              forcedPushFieldPaths: [],
            });
            return created.value.id;
          });
          let createError: unknown;
          for (let attempt = 0; attempt < 2 && entityId === undefined; attempt += 1) {
            try {
              entityId = await createEntity(resolvedSlug.slug);
            } catch (error) {
              createError = error;
              if (attempt > 0 || !isSlugConflict(error)) break;
              const before = resolvedSlug.slug;
              await reresolveSlug();
              if (resolvedSlug.slug === before) break;
            }
          }
          if (entityId === undefined) {
            failures.push({ externalId: item.externalId, error: createError instanceof Error ? createError.message : "Failed to create catalog entity." });
            continue;
          }
          isNew = true;
          imported += 1;
          entityTouched = true;
        }
      }

      const ownershipBeforeSeed = await this.catalog.resolveFieldOwners(entityId, storeId);
      const seedPaths = importedFieldPaths(item).filter((path) => !ownershipBeforeSeed.has(path));
      const seeded = await this.catalog.seedImportedFieldOwnership(entityId, storeId, seedPaths);
      if (!seeded.ok) { failures.push({ externalId: item.externalId, error: seeded.error.message }); continue; }
      for (const path of seedPaths) ownershipBeforeSeed.set(path, "store");
      const owners = ownershipBeforeSeed;
      const outboundEcho = entityMapping ? this.isOutboundEcho(entityMapping, item) : false;
      const remoteChanged = entityMapping === undefined || entityMapping.syncHash !== remoteHash;
      // An unchanged remote item writes nothing and advances no baseline:
      // converging a stale replay would revert local edits to shared and
      // unowned fields that the store never actually changed.
      // ...unless its SKUs moved this batch, clashed, or were waiting on an open conflict: a swap that
      // spanned two import pages leaves both map hashes current, and only this pass can close it.
      const identityPending = identity.written.has(item.externalId) || identity.clashes.has(item.externalId)
        || identity.openSkuConflicts.has(entityId);
      if (!force && !remoteChanged && !identityPending && existingEntity && existingEntity.status !== "archived") {
        continue;
      }
      const shared = existingEntity
        ? await this.detectSharedConflicts(
            entityId, storeId, existingEntity, entityMapping, item, owners,
            importedFieldPaths(item), remoteHash,
            outboundEcho ? { certifiedPaths: new Set(entityMapping?.outboundFieldPaths ?? []) } : undefined,
          )
        : { paths: [], conflicts: [] };
      const persistedConflicts = await this.persistCatalogConflicts(orgId, shared.conflicts, requireUserId(actor));
      if (!persistedConflicts.ok) return persistedConflicts;
      const owned = this.filterOwnedFields(item, owners);
      const heldSharedPaths = [...new Set([...(entityMapping?.heldFieldPaths ?? []), ...shared.paths])];
      // A newly held path revokes any force left from an earlier resolution of
      // that same path: the force was the operator's answer to a question that
      // has since been asked again, and it must not pre-empt the new one.
      const survivingForcedPaths = (entityMapping?.forcedPushFieldPaths ?? []).filter(
        (path) => !heldSharedPaths.includes(path),
      );
      const held = this.filterConflictingFields(owned.writable, heldSharedPaths);
      const writable = held.writable;
      const blockedPaths = new Set<FieldPath>([...owned.skipped, ...heldSharedPaths]);
      skipped.push(...owned.skipped.map((fieldPath) => ({ entityId, fieldPath })));
      conflicts.push(...shared.conflicts.map(({ platformValue: _platformValue, storeValue: _storeValue, ...conflict }) => conflict));
      for (const conflict of shared.conflicts) {
        warnings.push(`Held shared field conflict for entity "${conflict.entityId}", store "${conflict.storeId}", field "${conflict.fieldPath}" (local ${conflict.localValueSummary}, remote ${conflict.remoteValueSummary}).`);
      }

      if (existingEntity && entityMapping) {
        const remoteMetadata = mergeMetadata(existingEntity.metadata, writable.metadata ?? {});
        const remoteStatus = ownerAllows(owners, "entity.status") && !blockedPaths.has("entity.status")
          ? writable.status ?? (existingEntity.status === "archived" ? "active" : undefined)
          : undefined;
        const updateInput: {
          slug?: string;
          metadata?: Record<string, unknown>;
          status?: string;
          isVisible?: boolean;
        } = {};
        const keptSlug = this.slugToKeep(existingEntity.slug, resolvedSlug);
        if (ownerAllows(owners, "entity.slug") && !blockedPaths.has("entity.slug") && existingEntity.slug !== keptSlug) {
          updateInput.slug = keptSlug;
        }
        if (hash(remoteMetadata) !== hash(existingEntity.metadata ?? {})) updateInput.metadata = remoteMetadata;
        if (remoteStatus !== undefined && !blockedPaths.has("entity.status") && remoteStatus !== existingEntity.status) {
          updateInput.status = remoteStatus;
          updateInput.isVisible = remoteStatus === "active";
        }
        const shouldUpdate = force
          ? Object.keys(updateInput).length > 0
          : remoteChanged || existingEntity.status === "archived";
        if (shouldUpdate) {
          if (Object.keys(updateInput).length > 0) {
            const mappedEntityId = entityMapping.entityId;
            const update = async (): Promise<unknown> => {
              try {
                const updated = await this.catalog.update(mappedEntityId, updateInput, actor, CHANNEL_CONVERGENCE_CTX);
                return updated.ok ? undefined : updated.error;
              } catch (error) {
                return error;
              }
            };
            let updateError = await update();
            if (updateError !== undefined && updateInput.slug !== undefined && isSlugConflict(updateError)) {
              await reresolveSlug();
              const retrySlug = this.slugToKeep(existingEntity.slug, resolvedSlug);
              if (retrySlug === existingEntity.slug) delete updateInput.slug;
              else updateInput.slug = retrySlug;
              updateError = Object.keys(updateInput).length > 0 ? await update() : undefined;
            }
            if (updateError !== undefined) { failures.push({ externalId: item.externalId, error: errorMessage(updateError) }); continue; }
            entityTouched = true;
          }
        }
      }

      const optionAxes = await this.upsertOptionAxes(entityId, writable, actor);
      if (!optionAxes.ok) return optionAxes;
      const attributes = await this.setCatalogAttributesIfWritable(entityId, writable, actor, blockedPaths, CHANNEL_CONVERGENCE_CTX);
      if (!attributes.ok) return attributes;
      const variantIds = await this.upsertVariants(
        orgId,
        storeId,
        entityId,
        writable,
        optionAxes.value.value,
        actor,
        warnings,
        !heldSharedPaths.includes("options") && owners.get("options") !== "platform",
        item,
      );
      // A variant the store's own data makes unwritable (a sku another of its products holds) is
      // that item's failure, reported with its error — not a page error the caller would retry.
      if (!variantIds.ok) { failures.push({ externalId: item.externalId, error: variantIds.error }); continue; }
      const taxonomy = await this.applyTaxonomy(orgId, entityId, writable, actor, warnings);
      if (!taxonomy.ok) { failures.push({ externalId: item.externalId, error: taxonomy.error }); continue; }
      const media = await this.applyMedia(orgId, entityId, writable, variantIds.value.value, actor, warnings, owners);
      if (!media.ok) return media;
      const { listed, ...taxonomyLinks } = taxonomy.value;
      const links = await this.commitEntityLinks(orgId, storeId, entityId, { ...taxonomyLinks, ...media.value.links }, listed, media.value.previousRoles, isNew, actor);
      if (!links.ok) { failures.push({ externalId: item.externalId, error: links.error }); continue; }
      attributesCreated += attributes.value.created;
      mediaImported += media.value.imported;
      variantsGivenOptionValues += variantIds.value.repaired;
      skipped.push(...media.value.skipped.map((fieldPath) => ({ entityId, fieldPath })));
      entityTouched = entityTouched || optionAxes.value.changed || variantIds.value.changed || links.value.length > 0 || media.value.uploaded || attributes.value.changed
        || identity.written.has(item.externalId);
      const skuClashes = identity.clashes.get(item.externalId);
      if (skuClashes) {
        // Loud, not fatal: the product converges everything else, its SKU keeps the old value, and
        // the next reconcile — which sees the whole catalogue in one batch — resolves a swap that
        // spanned two import pages and closes this conflict.
        const conflict: DetectedCatalogFieldConflict = {
          entityId,
          storeId,
          fieldPath: "variants.sku",
          localValueSummary: skuClashes.map((clash) => `${clash.variantExternalId}=${clash.fromSku ?? "(none)"}`).join(", "),
          remoteValueSummary: skuClashes.map((clash) => `${clash.variantExternalId}=${clash.toSku} (held by ${clash.heldByVariantId ?? "unknown"})`).join(", "),
          platformValue: Object.fromEntries(skuClashes.map((clash) => [clash.variantExternalId, { sku: clash.fromSku, heldByVariantId: clash.heldByVariantId }])),
          storeValue: Object.fromEntries(skuClashes.map((clash) => [clash.variantExternalId, clash.toSku])),
        };
        const recorded = await this.persistCatalogConflicts(orgId, [conflict], requireUserId(actor), "Upstream SKU is held by another variant of this store.");
        if (!recorded.ok) { failures.push({ externalId: item.externalId, error: recorded.error }); continue; }
        conflicts.push({ entityId, storeId, fieldPath: "variants.sku", localValueSummary: conflict.localValueSummary, remoteValueSummary: conflict.remoteValueSummary });
        warnings.push(`Kept the local SKU for entity "${entityId}": ${conflict.remoteValueSummary}.`);
      } else if (identity.openSkuConflicts.has(entityId)) {
        await this.resolveSkuConflict(orgId, storeId, entityId, requireUserId(actor));
      }
      if (entityTouched) entitiesTouched += 1;
      // Counted from what was written, not from the stored hash: a hash that moved while the
      // product did not (a blanked map row, a change in how an item serialises) is not drift.
      if (entityTouched && entityMapping && !isNew) converged += 1;

      if (entityTouched) {
        const revision = await this.catalog.recordEntityRevision(entityId, actor, "import");
        if (!revision.ok) { failures.push({ externalId: item.externalId, error: revision.error.message }); continue; }
      }

      const revisionMarkers = await this.catalog.repository.findRevisionMarkers(entityId);
      const latestRevisionAt = revisionMarkers.at(-1)?.createdAt;
      const lastSyncedAt = latestRevisionAt ?? entityMapping?.lastSyncedAt ?? new Date();

      if (isNew) {
        await this.db.update(channelEntityMap).set({
          syncHash: remoteHash,
          lastSyncedAt,
          heldFieldPaths: heldSharedPaths,
          forcedPushFieldPaths: survivingForcedPaths,
        }).where(and(
          eq(channelEntityMap.organizationId, orgId),
          eq(channelEntityMap.storeId, storeId),
          eq(channelEntityMap.kind, "entity"),
          eq(channelEntityMap.externalId, item.externalId),
          eq(channelEntityMap.entityId, entityId),
        ));
      } else if (adoptedOrphan) {
        await this.db.insert(channelEntityMap).values({
          organizationId: orgId,
          storeId,
          kind: "entity",
          externalId: item.externalId,
          entityId,
          syncHash: remoteHash,
          lastSyncedAt,
          heldFieldPaths: heldSharedPaths,
          forcedPushFieldPaths: survivingForcedPaths,
        });
      } else if (entityMapping) {
        await this.db.update(channelEntityMap).set({
          syncHash: remoteHash,
          lastSyncedAt,
          heldFieldPaths: heldSharedPaths,
          forcedPushFieldPaths: survivingForcedPaths,
        }).where(eq(channelEntityMap.id, entityMapping.id));
      }
      await this.db.update(channelEntityMap).set({ lastSyncedAt }).where(and(
        eq(channelEntityMap.organizationId, orgId),
        eq(channelEntityMap.storeId, storeId),
        eq(channelEntityMap.entityId, entityId),
        eq(channelEntityMap.kind, "variant"),
      ));
      // LAST statement of the try, and that position is the whole guarantee: every failure path
      // above reaches `continue` before here, so an id is recorded only once the item's writes are
      // done. De-duplicated because a connector returning one externalId twice in a page would
      // otherwise have the consumer pay for the same entity twice.
      if (!committed.has(entityId)) {
        committed.add(entityId);
        entityIds.push(entityId);
      }
      } catch (error) {
        // Anything the stages throw rather than returning. Same disposition: record it against the
        // item and carry on, so an unforeseen throw costs one product and not the remaining page.
        failures.push({ externalId: item.externalId, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
    }
    return Ok({
      imported,
      converged,
      entitiesTouched,
      attributesCreated,
      mediaImported,
      variantsGivenOptionValues,
      consumed,
      skipped,
      conflicts,
      warnings,
      failures,
      entityIds,
    });
  }

  async reconcile(
    orgId: string,
    storeId: string,
    actor: Actor,
  ): Promise<PluginResult<ReconcileReport>> {
    const store = await this.getStoreRecord(orgId, storeId);
    if (!store || store.status !== "connected") return PluginErr("Connected store not found.", "NOT_FOUND");
    const connector = this.connectors.get(store.provider);
    if (!connector) return PluginErr(`No connector registered for provider "${store.provider}".`);

    const mappings = await this.db.select().from(channelEntityMap).where(and(eq(channelEntityMap.organizationId, orgId), eq(channelEntityMap.storeId, storeId)));
    const entityMappings = mappings.filter((mapping) => mapping.kind === "entity");
    const items: ChannelCatalogItem[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.readCatalogPage(connector, store as ChannelStore, cursor);
      if (!page.ok) return PluginErr(page.error.message);
      items.push(...page.value.items);
      cursor = page.value.nextCursor ?? undefined;
    } while (cursor);

    const converged = await this.convergeCatalogItems(orgId, storeId, items, actor);
    if (!converged.ok) return converged;
    // Planned BEFORE anything is archived: an empty or truncated fetch is refused whole (see
    // `planAbsentArchives`), and the refusal is reported, never half-applied.
    const plan = planAbsentArchives(entityMappings.map((mapping) => mapping.externalId), items.map((item) => item.externalId));
    const toArchive = new Set("archive" in plan ? plan.archive : []);
    let archived = 0;
    const skipped = [...converged.value.skipped];
    for (const mapping of entityMappings) {
      if (!toArchive.has(mapping.externalId)) continue;
      const [entity] = await this.db.select({ status: sellableEntities.status }).from(sellableEntities).where(and(
        eq(sellableEntities.organizationId, orgId),
        eq(sellableEntities.id, mapping.entityId),
      ));
      if (entity?.status !== "archived") {
        const owners = await this.catalog.resolveFieldOwners(mapping.entityId, storeId);
        if (owners.get("entity.status") === "platform") {
          skipped.push({ entityId: mapping.entityId, fieldPath: "entity.status" });
          continue;
        }
        const result = await this.catalog.archive(mapping.entityId, actor);
        if (!result.ok) return PluginErr(result.error.message);
        archived += 1;
      }
    }

    // Stock is levelled against the mappings as they stand AFTER convergence. Read before it, as the
    // archive plan above must be, a first import walked an empty list and left every product it had
    // just created with no inventory level at all. Re-read only when convergence wrote something: an
    // unchanged reconcile creates no mapping and keeps its statement budget.
    const levelled = converged.value.imported + converged.value.converged > 0
      ? await this.db.select().from(channelEntityMap).where(and(eq(channelEntityMap.organizationId, orgId), eq(channelEntityMap.storeId, storeId)))
      : mappings;
    const inventory = await connector.fetchInventory(store as ChannelStore, levelled.map((mapping) => mapping.externalId));
    if (!inventory.ok) return PluginErr(inventory.error.message);
    const existingLevels = await this.db.select().from(inventoryLevels).where(eq(inventoryLevels.organizationId, orgId));
    const inventoryService = this.services.inventory as {
      setAbsolute(input: { entityId: string; variantId?: string; quantity: number; reason?: string }, actor: Actor): Promise<{ ok: boolean; error?: { message: string } }>;
    };
    let inventoryUpdated = 0;
    for (const level of inventory.value) {
      // A product and its only variant can share an id (a WooCommerce simple product): stock is the variant's.
      const mapping = levelled.find((entry) => entry.externalId === level.externalId && entry.kind === "variant")
        ?? levelled.find((entry) => entry.externalId === level.externalId);
      if (!mapping) continue;
      const current = existingLevels.find((entry) => entry.entityId === mapping.entityId && entry.variantId === (mapping.variantId ?? null));
      // Stock cannot sit below zero here, so negative remote stock compares as the zero it is stored as.
      const quantity = Math.max(0, level.available);
      if (current?.quantityOnHand === quantity) continue;
      const result = await inventoryService.setAbsolute({
        entityId: mapping.entityId,
        ...(mapping.variantId ? { variantId: mapping.variantId } : {}),
        quantity,
        reason: `Inventory reconciliation from ${store.provider}`,
      }, actor);
      if (!result.ok) return PluginErr(result.error?.message ?? "Inventory reconciliation failed.");
      inventoryUpdated += 1;
    }
    const threshold = this.options.driftAlertThreshold ?? 25;
    const openConflictRows = await this.db.select({ id: channelCatalogConflicts.id }).from(channelCatalogConflicts).where(and(
      eq(channelCatalogConflicts.organizationId, orgId),
      eq(channelCatalogConflicts.storeId, storeId),
      eq(channelCatalogConflicts.state, "open"),
    ));
    const report: ReconcileReport = {
      imported: converged.value.imported,
      converged: converged.value.converged,
      archived,
      inventoryUpdated,
      openConflicts: openConflictRows.length,
      driftAlert: "refused" in plan || converged.value.imported + converged.value.converged + archived > threshold,
      ...("refused" in plan ? { refused: plan.refused } : {}),
      ...(skipped.length > 0 ? { skipped: uniqueSkipped(skipped) } : {}),
      ...(converged.value.conflicts.length > 0 ? { conflicts: converged.value.conflicts } : {}),
      ...(converged.value.warnings.length > 0 ? { warnings: converged.value.warnings } : {}),
      ...(converged.value.failures.length > 0 ? { failures: converged.value.failures } : {}),
    };
    await this.db.update(connectedStores).set({
      lastReconcileAt: new Date(),
      lastReconcileReport: report,
      lastSyncAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(connectedStores.organizationId, orgId), eq(connectedStores.id, storeId)));
    return Ok(report);
  }

  async getReconcileStatus(orgId: string, storeId: string): Promise<PluginResult<{ lastReconcileAt: Date | null; report: ReconcileReport | null; driftAlert: boolean }>> {
    const store = await this.getStoreRecord(orgId, storeId);
    if (!store) return PluginErr("Connected store not found.", "NOT_FOUND");
    const report = store.lastReconcileReport as ReconcileReport | null;
    return Ok({ lastReconcileAt: store.lastReconcileAt, report, driftAlert: report?.driftAlert ?? false });
  }

  async listCatalogConflicts(
    orgId: string,
    storeId?: string,
    state: ChannelCatalogConflict["state"] = "open",
  ): Promise<PluginResult<ChannelCatalogConflict[]>> {
    const conditions = [eq(channelCatalogConflicts.organizationId, orgId), eq(channelCatalogConflicts.state, state)];
    if (storeId !== undefined) conditions.push(eq(channelCatalogConflicts.storeId, storeId));
    return Ok(await this.db.select().from(channelCatalogConflicts).where(and(...conditions)) as ChannelCatalogConflict[]);
  }

  async resolveCatalogConflict(
    orgId: string,
    id: string,
    choose: "platform" | "store",
    actor: Pick<Actor, "userId">,
  ): Promise<PluginResult<ChannelCatalogConflict>> {
    const [conflict] = await this.db.select().from(channelCatalogConflicts).where(and(
      eq(channelCatalogConflicts.organizationId, orgId),
      eq(channelCatalogConflicts.id, id),
      eq(channelCatalogConflicts.state, "open"),
    ));
    if (!conflict) return PluginErr("Catalog conflict not found or already resolved.", "NOT_FOUND");
    if (choose === "platform" && !this.jobs) return PluginErr("Jobs are not configured.", "JOBS_UNAVAILABLE");
    const [mapping] = await this.db.select().from(channelEntityMap).where(and(
      eq(channelEntityMap.organizationId, orgId),
      eq(channelEntityMap.storeId, conflict.storeId),
      eq(channelEntityMap.kind, "entity"),
      eq(channelEntityMap.entityId, conflict.entityId),
    ));
    if (!mapping) return PluginErr("Catalog conflict mapping not found.", "NOT_FOUND");
    const systemActor = createSystemActor(orgId);
    let resolutionBaselineAt: Date | undefined;
    if (choose === "store") {
      const applied = await this.applyStoreConflictValue(orgId, conflict as ChannelCatalogConflict, systemActor);
      if (!applied.ok) return PluginErr(applied.error, applied.code);
      const revisions = await this.catalog.repository.findRevisionMarkers(conflict.entityId);
      resolutionBaselineAt = revisions.at(-1)?.createdAt;
    }
    const heldFieldPaths = (mapping.heldFieldPaths ?? []).filter((path) => path !== conflict.fieldPath);
    const forcedPushFieldPaths = choose === "platform"
      ? [...new Set([...(mapping.forcedPushFieldPaths ?? []), conflict.fieldPath as FieldPath])]
      : mapping.forcedPushFieldPaths ?? [];
    const [resolved] = await this.db.update(channelCatalogConflicts).set({
      state: "resolved",
      resolvedBy: requireUserId(actor),
      updatedAt: new Date(),
    }).where(and(
      eq(channelCatalogConflicts.organizationId, orgId),
      eq(channelCatalogConflicts.id, id),
      eq(channelCatalogConflicts.state, "open"),
    )).returning();
    if (!resolved) return PluginErr("Catalog conflict not found or already resolved.", "NOT_FOUND");
    await this.db.update(channelEntityMap).set({
      heldFieldPaths,
      forcedPushFieldPaths,
      ...(resolutionBaselineAt ? { lastSyncedAt: resolutionBaselineAt } : {}),
    }).where(and(
      eq(channelEntityMap.organizationId, orgId),
      eq(channelEntityMap.id, mapping.id),
    ));
    await this.db.insert(channelCatalogConflictEvents).values({
      organizationId: orgId,
      conflictId: conflict.id,
      fromState: "open",
      toState: "resolved",
      reason: `Operator chose the ${choose} value.`,
      changedBy: requireUserId(actor),
    });
    if (choose === "platform") {
      await this.jobs!.enqueue("channel/push-catalog", {
        organizationId: orgId,
        storeId: conflict.storeId,
        entityIds: [conflict.entityId],
      }, {
        organizationId: orgId,
        concurrencyKey: catalogPushConcurrencyKey({ storeId: conflict.storeId, entityIds: [conflict.entityId] }),
        supersedes: true,
      });
    }
    return Ok(resolved as ChannelCatalogConflict);
  }

  private async applyStoreConflictValue(
    orgId: string,
    conflict: ChannelCatalogConflict,
    actor: Actor,
  ): Promise<PluginResult<void>> {
    const [root, segment, field] = conflict.fieldPath.split(".");
    if (root === "entity" && segment === "slug") {
      if (typeof conflict.storeValue !== "string") return PluginErr("The stored catalog value is not a valid slug.", "INVALID_CONFLICT_VALUE");
      const updated = await this.catalog.update(conflict.entityId, { slug: conflict.storeValue }, actor, CHANNEL_CONVERGENCE_CTX);
      return updated.ok ? Ok(undefined) : PluginErr(updated.error.message);
    }
    if (root === "entity" && segment === "status") {
      if (typeof conflict.storeValue !== "string") return PluginErr("The stored catalog value is not a valid status.", "INVALID_CONFLICT_VALUE");
      const status = ["draft", "active", "archived", "discontinued"].find((value) => value === conflict.storeValue);
      if (!status) return PluginErr("The stored catalog value is not a valid status.", "INVALID_CONFLICT_VALUE");
      const updated = await this.catalog.update(conflict.entityId, { status, isVisible: status === "active" }, actor, CHANNEL_CONVERGENCE_CTX);
      return updated.ok ? Ok(undefined) : PluginErr(updated.error.message);
    }
    if (root === "entity" && segment === "metadata" && field) {
      const [entity] = await this.db.select().from(sellableEntities).where(and(
        eq(sellableEntities.organizationId, orgId),
        eq(sellableEntities.id, conflict.entityId),
      ));
      if (!entity) return PluginErr("Catalog entity not found.", "NOT_FOUND");
      const updated = await this.catalog.update(conflict.entityId, {
        metadata: { ...(entity.metadata ?? {}), [field]: conflict.storeValue },
      }, actor, CHANNEL_CONVERGENCE_CTX);
      return updated.ok ? Ok(undefined) : PluginErr(updated.error.message);
    }
    if (root === "attributes" && segment && field && attributeFields.some((attributeField) => attributeField === field)) {
      const [attribute] = await this.db.select().from(sellableAttributes).where(and(
        eq(sellableAttributes.entityId, conflict.entityId),
        eq(sellableAttributes.locale, segment),
      ));
      const title = attribute?.title ?? "";
      const attrs: Parameters<CatalogService["setAttributes"]>[2] = { title };
      if (field === "title") {
        if (typeof conflict.storeValue !== "string") return PluginErr("The stored catalog value is not valid text.", "INVALID_CONFLICT_VALUE");
        attrs.title = conflict.storeValue;
      } else if (field === "subtitle") {
        if (typeof conflict.storeValue !== "string") return PluginErr("The stored catalog value is not valid text.", "INVALID_CONFLICT_VALUE");
        attrs.subtitle = conflict.storeValue;
      } else if (field === "description") {
        if (typeof conflict.storeValue !== "string") return PluginErr("The stored catalog value is not valid text.", "INVALID_CONFLICT_VALUE");
        attrs.description = conflict.storeValue;
      } else if (field === "richDescription") {
        attrs.richDescription = conflict.storeValue;
      } else if (field === "seoTitle") {
        if (typeof conflict.storeValue !== "string") return PluginErr("The stored catalog value is not valid text.", "INVALID_CONFLICT_VALUE");
        attrs.seoTitle = conflict.storeValue;
      } else if (field === "seoDescription") {
        if (typeof conflict.storeValue !== "string") return PluginErr("The stored catalog value is not valid text.", "INVALID_CONFLICT_VALUE");
        attrs.seoDescription = conflict.storeValue;
      }
      const updated = await this.catalog.setAttributes(conflict.entityId, segment, attrs, actor, CHANNEL_CONVERGENCE_CTX);
      return updated.ok ? Ok(undefined) : PluginErr(updated.error.message);
    }
    if (root === "customFields" && segment && field === "en") {
      const updated = await this.catalog.update(conflict.entityId, { customFields: { [segment]: conflict.storeValue } }, actor, CHANNEL_CONVERGENCE_CTX);
      return updated.ok ? Ok(undefined) : PluginErr(updated.error.message);
    }
    return PluginErr(`Conflict field path "${conflict.fieldPath}" cannot be resolved to the store value.`, "UNSUPPORTED_CONFLICT_FIELD");
  }

  async syncInventory(
    orgId: string,
    storeId: string,
    actor: Actor,
    options?: { maxItems?: number },
  ): Promise<PluginResult<{ synced: number; exhausted?: boolean }>> {
    const store = await this.getStoreRecord(orgId, storeId);
    if (!store || store.status !== "connected") return PluginErr("Connected store not found.", "NOT_FOUND");
    const connector = this.connectors.get(store.provider);
    if (!connector) return PluginErr(`No connector registered for provider "${store.provider}".`);
    if (connector.fetchInventoryPage) return this.syncInventoryPage(orgId, storeId, store, connector.fetchInventoryPage.bind(connector), actor);
    const inventory = await connector.fetchInventory(store as ChannelStore);
    if (!inventory.ok) return PluginErr(inventory.error.message);
    const mappings = await this.db.select().from(channelEntityMap).where(and(
      eq(channelEntityMap.organizationId, orgId),
      eq(channelEntityMap.storeId, storeId),
    ));
    const inventoryService = this.services.inventory as {
      setAbsolute(input: { entityId: string; variantId?: string; quantity: number; reason?: string }, actor: Actor): Promise<{ ok: boolean; error?: { message: string } }>;
    };
    const maxItems = options?.maxItems ?? CHANNEL_INVENTORY_MAX_ITEMS_PER_INVOCATION;
    const levels = inventory.value;
    let { offset } = parseInventoryResumePosition(store.inventoryCursor);

    const entityIdsForSlice = (from: number, to: number) => {
      const ids = new Set<string>();
      for (const level of levels.slice(from, to)) {
        const mapping = mappings.find((entry) => entry.externalId === level.externalId);
        if (mapping) ids.add(mapping.entityId);
      }
      return ids;
    };
    const loadedThrough = Math.min(offset + maxItems, levels.length);
    const batchEntityIds = entityIdsForSlice(offset, loadedThrough);
    const existingLevels = batchEntityIds.size === 0
      ? []
      : await this.db.select().from(inventoryLevels).where(and(
        eq(inventoryLevels.organizationId, orgId),
        inArray(inventoryLevels.entityId, [...batchEntityIds]),
      ));

    let synced = 0;
    let levelsWalked = 0;
    let exhausted = false;

    // No refill inside the loop: the window loaded above spans exactly `maxItems` levels and the
    // walk breaks at `maxItems`, so `offset` can never pass `loadedThrough` within one invocation.
    while (offset < levels.length) {
      if (levelsWalked >= maxItems) break;
      const level = levels[offset]!;
      offset += 1;
      levelsWalked += 1;
      const mapping = mappings.find((entry) => entry.externalId === level.externalId);
      if (!mapping) continue;
      const current = existingLevels.find((entry) => entry.entityId === mapping.entityId && entry.variantId === (mapping.variantId ?? null));
      // Stock cannot sit below zero here, so negative remote stock compares as the zero it is stored as.
      const quantity = Math.max(0, level.available);
      if (current?.quantityOnHand === quantity) continue;
      const result = await inventoryService.setAbsolute({
        entityId: mapping.entityId,
        ...(mapping.variantId ? { variantId: mapping.variantId } : {}),
        quantity,
        reason: `Inventory sync from ${store.provider}`,
      }, actor);
      if (!result.ok) return PluginErr(result.error?.message ?? "Inventory sync failed.");
      synced += 1;
    }

    if (offset >= levels.length) exhausted = true;
    const inventoryCursor = exhausted ? null : encodeInventoryResumePosition({ offset });
    await this.db.update(connectedStores).set({
      inventoryCursor,
      ...(exhausted ? { lastSyncAt: new Date() } : {}),
      updatedAt: new Date(),
    }).where(and(eq(connectedStores.organizationId, orgId), eq(connectedStores.id, storeId)));

    return Ok({ synced, exhausted });
  }

  /**
   * One step of a store's inventory sync for a connector that pages its inventory: ONE page fetch,
   * ONE mapping read for that page's variants, and ONE `inventory.setAbsoluteMany` (a constant
   * number of statements, one `inventory.afterAdjustMany` for the page). The next page's cursor is
   * stored on the store, so no step re-reads what an earlier one levelled — the old path re-read
   * the whole inventory and every map row on every 20-level step.
   */
  private async syncInventoryPage(
    orgId: string,
    storeId: string,
    store: typeof connectedStores.$inferSelect,
    fetchPage: NonNullable<ChannelConnector["fetchInventoryPage"]>,
    actor: Actor,
  ): Promise<PluginResult<{ synced: number; exhausted?: boolean }>> {
    const { pageCursor } = parseInventoryResumePosition(store.inventoryCursor);
    const page = await fetchPage(store as ChannelStore, pageCursor ?? null);
    if (!page.ok) return PluginErr(page.error.message);
    const externalIds = [...new Set(page.value.levels.map((level) => level.externalId))];
    const mappings = externalIds.length === 0 ? [] : await this.db.select({
      externalId: channelEntityMap.externalId, kind: channelEntityMap.kind, entityId: channelEntityMap.entityId, variantId: channelEntityMap.variantId,
    }).from(channelEntityMap).where(and(
      eq(channelEntityMap.organizationId, orgId),
      eq(channelEntityMap.storeId, storeId),
      inArray(channelEntityMap.externalId, externalIds),
    ));
    // A variant's own mapping wins over a product's mapping of the same external id.
    const byExternalId = new Map<string, (typeof mappings)[number]>();
    for (const mapping of mappings) {
      if (!byExternalId.has(mapping.externalId) || mapping.kind === "variant") byExternalId.set(mapping.externalId, mapping);
    }
    const rows = page.value.levels.flatMap((level) => {
      const mapping = byExternalId.get(level.externalId);
      return mapping === undefined ? [] : [{
        entityId: mapping.entityId,
        ...(mapping.variantId ? { variantId: mapping.variantId } : {}),
        quantity: Math.max(0, level.available),
      }];
    });
    const inventoryService = this.services.inventory as {
      setAbsoluteMany(
        rows: ReadonlyArray<{ entityId: string; variantId?: string; quantity: number }>,
        actor: Actor,
        ctx?: undefined,
        options?: { reason?: string },
      ): Promise<{ ok: true; value: { entities: Array<{ levels: unknown[] }> } } | { ok: false; error: { message: string } }>;
    };
    const written = await inventoryService.setAbsoluteMany(rows, actor, undefined, { reason: `Inventory sync from ${store.provider}` });
    if (!written.ok) return PluginErr(written.error.message);
    const synced = written.value.entities.reduce((total, entity) => total + entity.levels.length, 0);

    const exhausted = page.value.nextCursor === null;
    await this.db.update(connectedStores).set({
      inventoryCursor: exhausted ? null : JSON.stringify({ pageCursor: page.value.nextCursor }),
      ...(exhausted ? { lastSyncAt: new Date() } : {}),
      updatedAt: new Date(),
    }).where(and(eq(connectedStores.organizationId, orgId), eq(connectedStores.id, storeId)));
    return Ok({ synced, exhausted });
  }

  /**
   * One verified store delivery. The store's connector says what it means ({@link ChannelEvent}); this
   * acts on the meaning and never on a topic or payload field. A delivery the connector does not act
   * on is logged as unmapped and answered `processed: false`, never reported as applied.
   */
  async handleWebhook(orgId: string, storeId: string, delivery: ChannelWebhookEvent): Promise<PluginResult<{ processed: boolean; data?: ChannelComplianceData; redacted?: number }>> {
    const store = await this.getStoreRecord(orgId, storeId);
    if (!store) return PluginErr("Connected store not found.", "NOT_FOUND");
    const connector = this.connectors.get(store.provider);
    const decoded = connector?.decodeWebhook ? await connector.decodeWebhook(store as ChannelStore, delivery) : Ok<ChannelEvent[]>([]);
    if (!decoded.ok) return PluginErr(decoded.error.message, decoded.error.code);
    await this.db.update(connectedStores).set({ lastEventAt: new Date() }).where(and(eq(connectedStores.organizationId, orgId), eq(connectedStores.id, storeId)));
    if (decoded.value.length === 0) {
      console.warn(JSON.stringify({ event: "channel_webhook_unmapped", provider: store.provider, storeId, topic: delivery.type, deliveryId: delivery.id }));
      return Ok({ processed: false });
    }
    const actor = createSystemActor(orgId);
    const outcome: { processed: boolean; data?: ChannelComplianceData; redacted?: number } = { processed: true };
    const report: ChannelEventReport = { skipped: [], conflicts: [], warnings: [] };
    for (const event of decoded.value) {
      const applied = await this.applyChannelEvent(orgId, store, connector, event, actor, report);
      if (!applied.ok) return applied;
      if (applied.value.data) outcome.data = applied.value.data;
      if (applied.value.redacted !== undefined) outcome.redacted = applied.value.redacted;
    }
    if (report.skipped.length > 0 || report.conflicts.length > 0 || report.warnings.length > 0) {
      const merged = {
        ...(store.lastReconcileReport ?? {}),
        ...(report.skipped.length > 0 ? { skipped: uniqueSkipped(report.skipped) } : {}),
        ...(report.conflicts.length > 0 ? { conflicts: report.conflicts } : {}),
        ...(report.warnings.length > 0 ? { warnings: report.warnings } : {}),
      };
      await this.db.update(connectedStores).set({ lastReconcileReport: merged, updatedAt: new Date() }).where(and(
        eq(connectedStores.organizationId, orgId),
        eq(connectedStores.id, storeId),
      ));
    }
    return Ok(outcome);
  }

  private async applyChannelEvent(
    orgId: string,
    store: ConnectedStore,
    connector: ChannelConnector | undefined,
    event: ChannelEvent,
    actor: Actor,
    report: ChannelEventReport,
  ): Promise<PluginResult<{ data?: ChannelComplianceData; redacted?: number }>> {
    const storeId = store.id;
    switch (event.kind) {
      case "product.changed": {
        // A webhook is a notification, not a snapshot. The products are read fresh and converged
        // exactly as an import page would be, creating one this store has never mapped.
        if (!connector?.fetchCatalogItems) return PluginErr(`Connector "${store.provider}" cannot re-read products, so a product change cannot be applied.`, "CONNECTOR_CANNOT_REREAD");
        const read = await connector.fetchCatalogItems(store as ChannelStore, event.externalIds);
        if (!read.ok) return PluginErr(read.error.message, read.error.code);
        const found = new Set(read.value.map((item) => item.externalId));
        for (const externalId of event.externalIds.filter((id) => !found.has(id))) {
          // Gone between the delivery and the read: the same as a delete.
          const archived = await this.archiveMappedProduct(orgId, storeId, externalId, actor);
          if (!archived.ok) return archived;
          report.skipped.push(...archived.value);
        }
        if (read.value.length === 0) return Ok({});
        const converged = await this.convergeCatalogPage(orgId, storeId, read.value, actor);
        if (!converged.ok) return converged;
        const [failure] = converged.value.failures;
        if (failure) return PluginErr(`Product ${failure.externalId} could not be converged: ${failure.error}`, "CONVERGENCE_FAILED");
        report.skipped.push(...converged.value.skipped);
        report.conflicts.push(...converged.value.conflicts);
        report.warnings.push(...converged.value.warnings);
        if (converged.value.entityIds.length > 0) {
          await this.options.onStoreCatalogChanged?.({ orgId, storeId, entityIds: [...converged.value.entityIds], convergence: converged.value });
        }
        return Ok({});
      }
      case "product.deleted": {
        for (const externalId of event.externalIds) {
          const archived = await this.archiveMappedProduct(orgId, storeId, externalId, actor);
          if (!archived.ok) return archived;
          report.skipped.push(...archived.value);
        }
        return Ok({});
      }
      case "inventory.changed": {
        for (const level of event.levels) await this.setMappedInventory(orgId, storeId, level.externalId, level.available, actor);
        return Ok({});
      }
      case "order.cancelled":
      case "order.fulfilled": {
        const orderId = await this.orderForRemote(orgId, storeId, event.remoteOrderId);
        if (!orderId) return Ok({});
        const ordersService = this.services.orders as { addNote(orderId: string, input: { body: string }, actor: Actor): Promise<{ ok: boolean; error?: { message: string } }>; changeStatus(input: { orderId: string; newStatus: "processing" | "fulfilled" | "partially_fulfilled" | "cancelled"; reason: string }, actor: Actor): Promise<{ ok: boolean }> };
        const what = event.kind === "order.cancelled" ? "cancelled" : event.partial ? "partially fulfilled" : "fulfilled";
        const note = await ordersService.addNote(orderId, { body: `The store ${what} its order ${event.remoteOrderId}.` }, actor);
        if (!note.ok) return PluginErr(note.error?.message ?? "Could not add channel order note.");
        if (event.kind === "order.cancelled") {
          // The store cancelled: the platform follows, under a reason the cancel hook recognises, so
          // it does not turn round and cancel at the store again. An order already closed, or one the
          // machine cannot cancel (shipped), keeps its status; the note above records the delivery.
          const [order] = await this.db.select({ status: orders.status }).from(orders).where(and(eq(orders.organizationId, orgId), eq(orders.id, orderId)));
          if (order && !["cancelled", "refunded"].includes(order.status)) {
            await ordersService.changeStatus({ orderId, newStatus: "cancelled", reason: CHANNEL_ORDER_CANCELLED_REASON }, actor);
          }
          return Ok({});
        }
        // The parcels first, so whatever the status move announces (a shipped email) can read them.
        const recorded = await this.recordChannelFulfillments(orgId, storeId, orderId, event.shipments, actor);
        if (!recorded.ok) return recorded;
        const target = event.partial ? "partially_fulfilled" : "fulfilled";
        const [order] = await this.db.select({ status: orders.status }).from(orders).where(and(eq(orders.organizationId, orgId), eq(orders.id, orderId)));
        if (order?.status === "confirmed") await ordersService.changeStatus({ orderId, newStatus: "processing", reason: "channel_order_fulfilled" }, actor);
        const [after] = await this.db.select({ status: orders.status }).from(orders).where(and(eq(orders.organizationId, orgId), eq(orders.id, orderId)));
        if (after?.status === "processing" || (target === "fulfilled" && after?.status === "partially_fulfilled")) {
          await ordersService.changeStatus({ orderId, newStatus: target, reason: "channel_order_fulfilled" }, actor);
        }
        return Ok({});
      }
      case "refund.created": {
        const refund = await this.createRefundRequest(orgId, store, event, actor);
        return refund.ok ? Ok({}) : refund;
      }
      case "return.updated": {
        // The store's answer to a return the marketplace asked for. A return it never asked for is ignored.
        await this.db.update(channelReturns).set({ status: event.status, updatedAt: new Date() }).where(and(eq(channelReturns.organizationId, orgId), eq(channelReturns.storeId, storeId), eq(channelReturns.remoteReturnId, event.remoteReturnId)));
        return Ok({});
      }
      case "connection.revoked": {
        const disconnected = await this.disconnectStoreSystem(orgId, storeId);
        return disconnected.ok ? Ok({}) : disconnected;
      }
      case "compliance.request": {
        if (event.request === "customer_data") {
          const dataRequest = await this.channelCustomerDataRequest(orgId, storeId, event.data);
          return dataRequest.ok ? Ok({ data: dataRequest.value }) : dataRequest;
        }
        const redacted = event.request === "customer_redact" ? await this.redactCustomerData(orgId, storeId, event.data) : await this.redactShopData(orgId, storeId);
        return redacted.ok ? Ok({ redacted: redacted.value }) : redacted;
      }
    }
  }

  private complianceEmail(data: Record<string, unknown>): string | undefined {
    const customer = data.customer && typeof data.customer === "object" ? data.customer as Record<string, unknown> : undefined;
    const email = data.email ?? customer?.email;
    return typeof email === "string" && email ? email.toLowerCase() : undefined;
  }

  private async channelCustomerExports(orgId: string, storeId: string): Promise<ChannelOrderExport[]> {
    return await this.db.select().from(channelOrderExports).where(and(
      eq(channelOrderExports.organizationId, orgId),
      eq(channelOrderExports.storeId, storeId),
    )) as ChannelOrderExport[];
  }

  private async channelCustomerDataRequest(orgId: string, storeId: string, data: Record<string, unknown>): Promise<PluginResult<ChannelComplianceData>> {
    const rows = await this.channelCustomerExports(orgId, storeId);
    const email = this.complianceEmail(data);
    const matches = rows.filter((row) => email && row.customerData?.email.toLowerCase() === email && row.customerData !== null);
    return Ok({
      customer: {
        ...(typeof data.customer_id === "string" ? { id: data.customer_id } : {}),
        ...(email ? { email } : {}),
      },
      exports: matches.map((row) => ({
        exportId: row.id,
        orderId: row.orderId,
        customerData: row.customerData!,
      })),
    });
  }

  private async redactCustomerData(orgId: string, storeId: string, data: Record<string, unknown>): Promise<PluginResult<number>> {
    const rows = await this.channelCustomerExports(orgId, storeId);
    const email = this.complianceEmail(data);
    const matches = rows.filter((row) => email && row.customerData?.email.toLowerCase() === email && row.customerData !== null);
    for (const row of matches) {
      await this.db.update(channelOrderExports).set({ customerData: null, updatedAt: new Date() }).where(and(
        eq(channelOrderExports.organizationId, orgId),
        eq(channelOrderExports.id, row.id),
      ));
    }
    return Ok(matches.length);
  }

  private async redactShopData(orgId: string, storeId: string): Promise<PluginResult<number>> {
    const rows = await this.channelCustomerExports(orgId, storeId);
    await this.db.update(channelOrderExports).set({ customerData: null, updatedAt: new Date() }).where(and(
      eq(channelOrderExports.organizationId, orgId),
      eq(channelOrderExports.storeId, storeId),
    ));
    const disconnected = await this.disconnectStoreSystem(orgId, storeId, true);
    if (!disconnected.ok) return PluginErr(disconnected.error, disconnected.code);
    return Ok(rows.filter((row) => row.customerData !== null).length);
  }

  /**
   * For a read point (a shopper opening their order): each of the order's store orders not read for
   * {@link REMOTE_ORDER_REFRESH_MS} is queued for one refresh, so a store-side cancel, shipment or
   * refund whose delivery never arrived still reaches the platform. No schedule: someone looked.
   * Answers how many were queued.
   */
  async refreshStaleRemoteOrders(orgId: string, orderId: string, jobs: JobsAdapter): Promise<number> {
    const [order] = await this.db.select({ status: orders.status }).from(orders).where(and(eq(orders.organizationId, orgId), eq(orders.id, orderId)));
    if (!order || ["cancelled", "refunded"].includes(order.status)) return 0;
    const cutoff = new Date(Date.now() - REMOTE_ORDER_REFRESH_MS);
    // The claim and the window in one statement: two readers at once queue one refresh.
    const claimed = await this.db.update(channelOrderExports).set({ remoteCheckedAt: new Date() }).where(and(
      eq(channelOrderExports.organizationId, orgId),
      eq(channelOrderExports.orderId, orderId),
      inArray(channelOrderExports.state, ["exported", "confirmed"]),
      sql`${channelOrderExports.remoteOrderId} is not null`,
      or(isNull(channelOrderExports.remoteCheckedAt), lte(channelOrderExports.remoteCheckedAt, cutoff)),
    )).returning({ storeId: channelOrderExports.storeId, remoteOrderId: channelOrderExports.remoteOrderId });
    let queued = 0;
    for (const row of claimed) {
      if (!row.remoteOrderId) continue;
      const store = await this.getStoreRecord(orgId, row.storeId);
      if (!store || store.status !== "connected" || !this.connectors.get(store.provider)?.orderEvents) continue;
      await jobs.enqueue("channel/refresh-order", { orgId, storeId: row.storeId, remoteOrderId: row.remoteOrderId }, { organizationId: orgId, concurrencyKey: `webhook:${row.storeId}`, supersedes: false });
      queued += 1;
    }
    return queued;
  }

  /** The store's current state of one order we pushed, applied as if its delivery had arrived. */
  async refreshRemoteOrder(orgId: string, storeId: string, remoteOrderId: string): Promise<PluginResult<{ events: number }>> {
    const store = await this.getStoreRecord(orgId, storeId);
    if (!store) return PluginErr("Connected store not found.", "NOT_FOUND");
    const connector = this.connectors.get(store.provider);
    if (!connector?.orderEvents) return Ok({ events: 0 });
    const events = await connector.orderEvents(store as ChannelStore, remoteOrderId);
    if (!events.ok) return PluginErr(events.error.message, events.error.code);
    const report: ChannelEventReport = { skipped: [], conflicts: [], warnings: [] };
    const actor = createSystemActor(orgId);
    for (const event of events.value) {
      const applied = await this.applyChannelEvent(orgId, store, connector, event, actor, report);
      if (!applied.ok) return applied;
    }
    return Ok({ events: events.value.length });
  }

  private async orderForRemote(orgId: string, storeId: string, remoteOrderId: string): Promise<string | undefined> {
    const rows = await this.db.select({ orderId: channelOrderExports.orderId }).from(channelOrderExports).where(and(eq(channelOrderExports.organizationId, orgId), eq(channelOrderExports.storeId, storeId), eq(channelOrderExports.remoteOrderId, remoteOrderId)));
    return rows[0]?.orderId;
  }

  /** Archives this store's product mapped to `externalId`, unless the platform owns its status. */
  private async archiveMappedProduct(orgId: string, storeId: string, externalId: string, actor: Actor): Promise<PluginResult<CatalogFieldSkip[]>> {
    const [mapping] = await this.db.select().from(channelEntityMap).where(and(eq(channelEntityMap.organizationId, orgId), eq(channelEntityMap.storeId, storeId), eq(channelEntityMap.kind, "entity"), eq(channelEntityMap.externalId, externalId)));
    if (!mapping) return Ok([]);
    const owners = await this.catalog.resolveFieldOwners(mapping.entityId, storeId);
    if (owners.get("entity.status") === "platform") return Ok([{ entityId: mapping.entityId, fieldPath: "entity.status" }]);
    const archived = await this.catalog.archive(mapping.entityId, actor);
    return archived.ok ? Ok([]) : PluginErr(archived.error.message);
  }

  /**
   * Stock is a variant's. A provider can name a product and its only variant by the same id (a
   * WooCommerce simple product is both), so the variant mapping wins over the entity one, as the
   * paged sync's does; an entity mapping alone (a product imported with no variants) still takes it.
   */
  private async setMappedInventory(orgId: string, storeId: string, externalId: string, quantity: number, actor: Actor): Promise<void> {
    const rows = await this.db.select().from(channelEntityMap).where(and(eq(channelEntityMap.organizationId, orgId), eq(channelEntityMap.storeId, storeId), eq(channelEntityMap.externalId, externalId)));
    const mapping = rows.find((row) => row.kind === "variant") ?? rows[0];
    if (!mapping) return;
    await this.setInventoryLevel(mapping.entityId, mapping.variantId, quantity, actor);
  }

  private async setInventoryLevel(entityId: string, variantId: string | null, quantity: number, actor: Actor): Promise<void> {
    const inventory = this.services.inventory as { setAbsolute(input: { entityId: string; variantId?: string; quantity: number; reason?: string }, actor: Actor): Promise<{ ok: boolean }> };
    await inventory.setAbsolute({ entityId, ...(variantId ? { variantId } : {}), quantity: Math.max(0, Math.floor(quantity)), reason: "Inventory webhook sync" }, actor);
  }

  private async createRefundRequest(orgId: string, store: ConnectedStore, event: Extract<ChannelEvent, { kind: "refund.created" }>, actor: Actor): Promise<PluginResult<ChannelRefundRequest | null>> {
    const { remoteRefundId } = event;
    const orderId = await this.orderForRemote(orgId, store.id, event.remoteOrderId);
    // A refund on an order this store never received from us is the store's own business.
    if (!orderId) return Ok(null);
    const existing = await this.db.select().from(channelRefundRequests).where(and(eq(channelRefundRequests.storeId, store.id), eq(channelRefundRequests.remoteRefundId, remoteRefundId)));
    if (existing[0]) return Ok(existing[0] as ChannelRefundRequest);
    const orderLines = await this.db.select().from(orderLineItems).where(eq(orderLineItems.orderId, orderId));
    const mappings = await this.db.select().from(channelEntityMap).where(and(eq(channelEntityMap.organizationId, orgId), eq(channelEntityMap.storeId, store.id)));
    const refundLines: Array<{ lineItemId: string; quantity: number }> = [];
    // Every line the store named is one of ours, with that much still refundable.
    let mapped = true;
    for (const line of event.lines) {
      const externalId = line.externalVariantId;
      const quantity = line.quantity;
      const mapping = mappings.find((item) => item.externalId === externalId);
      const orderLine = mapping ? orderLines.find((item) => item.variantId === mapping.variantId || item.entityId === mapping.entityId) : undefined;
      if (!orderLine || !Number.isInteger(quantity) || quantity < 1 || quantity > orderLine.quantity - orderLine.refundedQuantity) mapped = false;
      else refundLines.push({ lineItemId: orderLine.id, quantity });
    }
    const priced = refundLines.reduce((sum, line) => {
      const item = orderLines.find((candidate) => candidate.id === line.lineItemId)!;
      return sum + Math.round((item.totalPrice + item.taxAmount - item.discountAmount) * line.quantity / item.quantity);
    }, 0);
    const [order] = await this.db.select().from(orders).where(and(eq(orders.organizationId, orgId), eq(orders.id, orderId)));
    if (!order) return PluginErr("Order not found.", "NOT_FOUND");
    const completed = (await this.db.select({ amount: orderRefunds.amount, shippingAmount: orderRefunds.shippingAmount }).from(orderRefunds)
      .where(and(eq(orderRefunds.orderId, orderId), eq(orderRefunds.status, "completed"))));
    const shippingLeft = Math.max(0, order.shippingTotal - completed.reduce((sum, refund) => sum + refund.shippingAmount, 0));
    const orderLeft = Math.max(0, order.grandTotal - completed.reduce((sum, refund) => sum + refund.amount, 0));
    // What the store refunded, and never more than the shopper paid for what it names: the lines at most
    // at the platform's own price (part of a line, or a line the store discounted, is less), the delivery
    // at most what of it is not refunded yet, money with no line behind it (goodwill) only when the refund
    // names no line, and the whole at most what the order has left.
    const storeShipping = Math.max(0, event.shippingAmount ?? 0);
    const shippingAmount = Math.min(storeShipping, shippingLeft);
    const rest = event.amount === undefined ? priced : Math.max(0, event.amount - storeShipping);
    const linesAmount = Math.min(rest, priced);
    const goodwill = event.lines.length === 0 ? rest : 0;
    const adjustmentAmount = Math.max(0, Math.min(goodwill, orderLeft - linesAmount - shippingAmount));
    const amount = Math.min(linesAmount + shippingAmount + adjustmentAmount, orderLeft);
    // A refund that pays nothing (a restock, or nothing left to pay) asks nobody for money.
    if (amount === 0) return Ok(null);
    const max = this.options.refundAutoMax ?? order.amountCaptured ?? order.grandTotal;
    const ageOk = Date.now() - store.createdAt.getTime() >= (this.options.newStoreDays ?? 7) * 86_400_000;
    // Only whole lines, at exactly the platform's price with exactly their delivery, are automatic; any
    // other amount is a person's call.
    const auto = mapped && refundLines.length > 0 && adjustmentAmount === 0 && linesAmount === priced && shippingAmount === storeShipping && ageOk && amount <= max;
    const rows = await this.db.insert(channelRefundRequests).values({ organizationId: orgId, storeId: store.id, orderId, remoteRefundId, amount, shippingAmount, adjustmentAmount, lines: mapped ? refundLines : null, state: auto ? "approved" : "requested", approvedBy: auto ? requireUserId(actor) : null }).returning();
    const request = rows[0] as ChannelRefundRequest;
    await this.db.insert(channelRefundEvents).values({ organizationId: orgId, requestId: request.id, fromState: null, toState: request.state, reason: auto ? "Automatic guarded refund" : "Operator approval required", changedBy: requireUserId(actor) });
    if (auto) {
      const result = await this.executeRefund(request, refundLines, actor);
      if (!result.ok) {
        // Nothing moved: an operator decides instead, rather than the request sticking as approved.
        await this.db.update(channelRefundRequests).set({ state: "requested", approvedBy: null, updatedAt: new Date() }).where(and(eq(channelRefundRequests.organizationId, orgId), eq(channelRefundRequests.id, request.id), eq(channelRefundRequests.state, "approved")));
        await this.db.insert(channelRefundEvents).values({ organizationId: orgId, requestId: request.id, fromState: "approved", toState: "requested", reason: `Automatic refund failed: ${result.error}`, changedBy: requireUserId(actor) });
        return Ok({ ...request, state: "requested" });
      }
    }
    return Ok(request);
  }

  private async executeRefund(request: ChannelRefundRequest, lines: Array<{ lineItemId: string; quantity: number }>, actor: Actor): Promise<PluginResult<ChannelRefundRequest>> {
    const ordersService = this.services.orders as { refundLines(orderId: string, input: { lines: Array<{ lineItemId: string; quantity: number }>; reason?: string; amount?: number; shippingAmount?: number; adjustmentAmount?: number }, actor: Actor): Promise<{ ok: boolean; error?: { message: string } }> };
    // A request that kept its lines pays back its own amount for them; an older one is priced from the
    // lines rebuilt for it. Delivery and goodwill ride beside the lines.
    const linesAmount = request.amount - request.shippingAmount - request.adjustmentAmount;
    const result = await ordersService.refundLines(request.orderId, {
      lines,
      reason: `Channel refund ${request.remoteRefundId}`,
      ...(request.lines && lines.length > 0 ? { amount: linesAmount } : {}),
      ...(request.shippingAmount > 0 ? { shippingAmount: request.shippingAmount } : {}),
      ...(request.adjustmentAmount > 0 ? { adjustmentAmount: request.adjustmentAmount } : {}),
    }, actor);
    if (!result.ok) return PluginErr(result.error?.message ?? "Refund execution failed.");
    const [updated] = await this.db.update(channelRefundRequests).set({ state: "executed", updatedAt: new Date() }).where(and(eq(channelRefundRequests.organizationId, request.organizationId), eq(channelRefundRequests.id, request.id), eq(channelRefundRequests.state, "approved"))).returning();
    await this.db.insert(channelRefundEvents).values({ organizationId: request.organizationId, requestId: request.id, fromState: "approved", toState: "executed", reason: "Platform refund executed", changedBy: requireUserId(actor) });
    return Ok(updated as ChannelRefundRequest);
  }

  /** Held refunds, each with the order number an approver knows the order by. */
  async listRefundRequests(orgId: string): Promise<PluginResult<Array<ChannelRefundRequest & { orderNumber: string | null }>>> {
    const rows = await this.db.select({ request: channelRefundRequests, orderNumber: orders.orderNumber }).from(channelRefundRequests)
      .leftJoin(orders, eq(orders.id, channelRefundRequests.orderId))
      .where(and(eq(channelRefundRequests.organizationId, orgId), eq(channelRefundRequests.state, "requested")));
    return Ok(rows.map((row) => ({ ...(row.request as ChannelRefundRequest), orderNumber: row.orderNumber })));
  }

  async approveRefund(orgId: string, id: string, actor: { userId: string }): Promise<PluginResult<ChannelRefundRequest>> {
    const [request] = await this.db.update(channelRefundRequests).set({ state: "approved", approvedBy: actor.userId, updatedAt: new Date() }).where(and(eq(channelRefundRequests.organizationId, orgId), eq(channelRefundRequests.id, id), eq(channelRefundRequests.state, "requested"))).returning();
    if (!request) return PluginErr("Refund request not found or already handled.", "NOT_FOUND");
    const lines = request.lines ?? await this.refundLinesForRequest(request as ChannelRefundRequest);
    const executed = await this.executeRefund(request as ChannelRefundRequest, lines, createSystemActor(orgId));
    if (!executed.ok) {
      // Nothing moved: back to `requested`, so the operator can approve again once the cause is fixed.
      await this.db.update(channelRefundRequests).set({ state: "requested", approvedBy: null, updatedAt: new Date() }).where(and(eq(channelRefundRequests.organizationId, orgId), eq(channelRefundRequests.id, id), eq(channelRefundRequests.state, "approved")));
      await this.db.insert(channelRefundEvents).values({ organizationId: orgId, requestId: id, fromState: "approved", toState: "requested", reason: `Execution failed: ${executed.error}`, changedBy: actor.userId });
    }
    return executed;
  }

  async rejectRefund(orgId: string, id: string, actor: { userId: string }): Promise<PluginResult<ChannelRefundRequest>> {
    const [request] = await this.db.update(channelRefundRequests).set({ state: "rejected", approvedBy: actor.userId, updatedAt: new Date() }).where(and(eq(channelRefundRequests.organizationId, orgId), eq(channelRefundRequests.id, id), eq(channelRefundRequests.state, "requested"))).returning();
    if (!request) return PluginErr("Refund request not found or already handled.", "NOT_FOUND");
    await this.db.insert(channelRefundEvents).values({ organizationId: orgId, requestId: id, fromState: "requested", toState: "rejected", reason: "Operator rejected refund", changedBy: actor.userId });
    return Ok(request as ChannelRefundRequest);
  }

  private async refundLinesForRequest(request: ChannelRefundRequest): Promise<Array<{ lineItemId: string; quantity: number }>> {
    const rows = await this.db.select().from(orderLineItems).where(eq(orderLineItems.orderId, request.orderId));
    let remaining = request.amount;
    return rows.flatMap((line) => {
      const unit = Math.round((line.totalPrice + line.taxAmount - line.discountAmount) / line.quantity);
      const quantity = Math.min(line.quantity - line.refundedQuantity, Math.floor(remaining / unit));
      remaining -= quantity * unit;
      return quantity > 0 ? [{ lineItemId: line.id, quantity }] : [];
    });
  }

  async createExport(
    orgId: string,
    storeId: string,
    orderId: string,
  ): Promise<PluginResult<ChannelOrderExport>> {
    const store = await this.getStoreRecord(orgId, storeId);
    if (!store || store.status !== "connected") {
      return PluginErr("Connected store not found.", "NOT_FOUND");
    }
    const existing = await this.db
      .select()
      .from(channelOrderExports)
      .where(and(
        eq(channelOrderExports.organizationId, orgId),
        eq(channelOrderExports.storeId, storeId),
        eq(channelOrderExports.orderId, orderId),
      ));
    if (existing[0]) return Ok(existing[0] as ChannelOrderExport);
    const rows = await this.db
      .insert(channelOrderExports)
      .values({ organizationId: orgId, storeId, orderId })
      .returning();
    return Ok(rows[0] as ChannelOrderExport);
  }

  async transitionExport(
    orgId: string,
    exportId: string,
    toState: ExportState,
    changedBy: string,
    reason?: string,
    failureKind?: "definitive" | "transient",
  ): Promise<PluginResult<ChannelOrderExport>> {
    return this.transact(async (tx) => {
      const currentRows = await tx
        .select()
        .from(channelOrderExports)
        .where(and(
          eq(channelOrderExports.organizationId, orgId),
          eq(channelOrderExports.id, exportId),
        ));
      const current = currentRows[0] as ChannelOrderExport | undefined;
      if (!current) return PluginErr("Channel order export not found.", "NOT_FOUND");
      if (!canExportTransition(current.state, toState)) {
        const error = new CommerceInvalidTransitionError(
          `Cannot transition channel export from ${current.state} to ${toState}.`,
        );
        return PluginErr(error.message, error.code);
      }

      const updatedRows = await tx
        .update(channelOrderExports)
        .set({
          state: toState,
          updatedAt: new Date(),
          ...(toState === "exported" ? { attempts: current.attempts + 1, lastError: null, failureKind: null } : {}),
          ...(toState === "failed" ? { lastError: reason ?? "Export failed." } : {}),
          ...(toState === "failed" ? { failureKind: failureKind ?? "definitive" } : {}),
        })
        .where(and(
          eq(channelOrderExports.organizationId, orgId),
          eq(channelOrderExports.id, exportId),
          eq(channelOrderExports.state, current.state),
        ))
        .returning();
      const updated = updatedRows[0] as ChannelOrderExport | undefined;
      if (!updated) return PluginErr("Channel order export changed concurrently.", "CONFLICT");

      await tx.insert(channelExportEvents).values({
        organizationId: orgId,
        exportId,
        fromState: current.state,
        toState,
        reason: reason ?? null,
        changedBy,
      });
      return Ok(updated);
    });
  }

  /**
   * Cancels this order at every store it was pushed to. Any refusal is returned as the error, so the
   * caller can refuse its own cancel: a store that has shipped must not see the marketplace refund
   * goods already on their way. A store with no connector able to cancel is left to its merchant.
   */
  async cancelRemoteOrders(orgId: string, orderId: string, input: ChannelCancelOrderInput): Promise<PluginResult<number>> {
    const exports = await this.db
      .select({ storeId: channelOrderExports.storeId, remoteOrderId: channelOrderExports.remoteOrderId })
      .from(channelOrderExports)
      .where(and(eq(channelOrderExports.organizationId, orgId), eq(channelOrderExports.orderId, orderId)));
    let cancelled = 0;
    for (const exported of exports) {
      if (exported.remoteOrderId === null) continue;
      const store = await this.getStoreRecord(orgId, exported.storeId);
      if (!store || store.status !== "connected") continue;
      // ponytail: a provider without cancelOrder is skipped silently; refuse instead if one ever ships without it.
      const connector = this.connectors.get(store.provider);
      if (!connector?.cancelOrder) continue;
      const result = await connector.cancelOrder(store as ChannelStore, exported.remoteOrderId, input);
      if (!result.ok) return PluginErr(result.error.message, result.error.code);
      cancelled += 1;
    }
    return Ok(cancelled);
  }

  /**
   * One core fulfilment record per store parcel, keyed on the store's parcel id
   * (`metadata.channelFulfillmentId`) so a replay records nothing twice. Each records the lines it
   * shipped, matched by the store's variant id; one whose lines cannot be matched (or that names
   * none) records every line not yet fulfilled.
   */
  private async recordChannelFulfillments(orgId: string, storeId: string, orderId: string, shipments: ChannelShipment[], actor: Actor): Promise<PluginResult<number>> {
    const existing = await this.db.select({ metadata: fulfillmentRecords.metadata }).from(fulfillmentRecords).where(eq(fulfillmentRecords.orderId, orderId));
    const recorded = new Set(existing.map((row) => String(row.metadata?.channelFulfillmentId ?? "")));
    const lines = await this.db.select({ id: orderLineItems.id, variantId: orderLineItems.variantId, quantity: orderLineItems.quantity }).from(orderLineItems).where(eq(orderLineItems.orderId, orderId));
    const fulfillment = this.services.fulfillment as { createFulfillment(input: { orderId: string; lineItems: Array<{ orderLineItemId: string; quantity: number }>; carrier?: string; trackingNumber?: string; trackingUrl?: string; status?: string; metadata?: Record<string, unknown> }, actor: Actor): Promise<{ ok: boolean; error?: { message: string } }> };
    let created = 0;
    for (const parcel of shipments) {
      if (recorded.has(parcel.remoteId)) continue;
      const externalIds = parcel.lines.map((line) => line.externalVariantId);
      const mapped = externalIds.length === 0 ? [] : await this.db
        .select({ externalId: channelEntityMap.externalId, variantId: channelEntityMap.variantId })
        .from(channelEntityMap)
        .where(and(eq(channelEntityMap.organizationId, orgId), eq(channelEntityMap.storeId, storeId), eq(channelEntityMap.kind, "variant"), inArray(channelEntityMap.externalId, externalIds)));
      const variantFor = new Map(mapped.map((row) => [row.externalId, row.variantId]));
      const matched = parcel.lines.flatMap((line) => {
        const variantId = variantFor.get(line.externalVariantId);
        const orderLine = variantId == null ? undefined : lines.find((candidate) => candidate.variantId === variantId);
        return orderLine ? [{ orderLineItemId: orderLine.id, quantity: line.quantity }] : [];
      });
      const lineItems = matched.length > 0 ? matched : await this.unfulfilledLines(lines);
      if (lineItems.length === 0) continue;
      const result = await fulfillment.createFulfillment({
        orderId,
        lineItems,
        ...(parcel.carrier ? { carrier: parcel.carrier } : {}),
        ...(parcel.trackingNumber ? { trackingNumber: parcel.trackingNumber } : {}),
        ...(parcel.trackingUrl ? { trackingUrl: parcel.trackingUrl } : {}),
        status: "shipped",
        metadata: { channelFulfillmentId: parcel.remoteId, storeId, ...(parcel.source ? { trackingSource: parcel.source } : {}) },
      }, actor);
      if (!result.ok) return PluginErr(result.error?.message ?? "Could not record the store's fulfilment.");
      recorded.add(parcel.remoteId);
      created += 1;
    }
    return Ok(created);
  }

  /** Every line with quantity still to ship, for a parcel whose own lines could not be matched. */
  private async unfulfilledLines(lines: Array<{ id: string; quantity: number }>): Promise<Array<{ orderLineItemId: string; quantity: number }>> {
    const ids = lines.map((line) => line.id);
    const shipped = ids.length === 0 ? [] : await this.db
      .select({ lineId: fulfillmentLineItems.orderLineItemId, quantity: sql<number>`coalesce(sum(${fulfillmentLineItems.quantity}), 0)::int` })
      .from(fulfillmentLineItems)
      .where(inArray(fulfillmentLineItems.orderLineItemId, ids))
      .groupBy(fulfillmentLineItems.orderLineItemId);
    const shippedBy = new Map(shipped.map((row) => [row.lineId, row.quantity]));
    return lines.flatMap((line) => {
      const remaining = line.quantity - (shippedBy.get(line.id) ?? 0);
      return remaining > 0 ? [{ orderLineItemId: line.id, quantity: remaining }] : [];
    });
  }

  /**
   * Asks the store this order was pushed to to take lines back. Each line is named to the store by its
   * own variant id; a line the store has no record of is refused before the store is asked anything.
   * The return is recorded as `requested`; the store's `returns/*` webhooks move it from there.
   */
  async requestReturn(
    orgId: string,
    orderId: string,
    input: { lines: Array<{ orderLineItemId: string; quantity: number }>; reason: string; note?: string },
  ): Promise<PluginResult<{ id: string; remoteReturnId: string; status: string }>> {
    if (input.lines.length === 0) return PluginErr("Name at least one line to return.", "VALIDATION_FAILED");
    const [exported] = await this.db
      .select({ storeId: channelOrderExports.storeId, remoteOrderId: channelOrderExports.remoteOrderId })
      .from(channelOrderExports)
      .where(and(eq(channelOrderExports.organizationId, orgId), eq(channelOrderExports.orderId, orderId)));
    if (!exported || exported.remoteOrderId === null) return PluginErr("This order never reached a store, so there is nothing to return there.", "NOT_FOUND");
    const store = await this.getStoreRecord(orgId, exported.storeId);
    if (!store || store.status !== "connected") return PluginErr("The store this order went to is not connected.", "NOT_FOUND");
    const connector = this.connectors.get(store.provider);
    // A store with no returns of its own (WooCommerce) has them held here, for its merchant to approve.
    const hosted = connector?.requestReturn === undefined && connector?.recordRefund !== undefined;
    if (!connector || (!connector.requestReturn && !hosted)) return PluginErr(`Returns are not available for ${store.provider} stores.`, "NOT_IMPLEMENTED");

    const lines = await this.db.select({ id: orderLineItems.id, variantId: orderLineItems.variantId, quantity: orderLineItems.quantity }).from(orderLineItems).where(eq(orderLineItems.orderId, orderId));
    const variantIds = lines.flatMap((line) => (line.variantId === null ? [] : [line.variantId]));
    const mapped = variantIds.length === 0 ? [] : await this.db
      .select({ variantId: channelEntityMap.variantId, externalId: channelEntityMap.externalId })
      .from(channelEntityMap)
      .where(and(eq(channelEntityMap.organizationId, orgId), eq(channelEntityMap.storeId, store.id), eq(channelEntityMap.kind, "variant"), inArray(channelEntityMap.variantId, variantIds)));
    const remote: Array<{ externalVariantId: string; quantity: number }> = [];
    for (const wanted of input.lines) {
      const line = lines.find((candidate) => candidate.id === wanted.orderLineItemId);
      if (!line) return PluginErr(`Line ${wanted.orderLineItemId} is not on this order.`, "VALIDATION_FAILED");
      if (!Number.isInteger(wanted.quantity) || wanted.quantity < 1 || wanted.quantity > line.quantity) return PluginErr(`Line ${wanted.orderLineItemId} has ${line.quantity} to return; asked for ${wanted.quantity}.`, "VALIDATION_FAILED");
      const externalId = mapped.find((entry) => entry.variantId === line.variantId)?.externalId;
      if (!externalId) return PluginErr(`The store has no record of line ${wanted.orderLineItemId}, so it cannot take it back.`, "CHANNEL_MAPPING_MISSING");
      remote.push({ externalVariantId: externalId, quantity: wanted.quantity });
    }

    let remoteReturnId = `${PLATFORM_RETURN_PREFIX}${crypto.randomUUID()}`;
    if (connector.requestReturn) {
      const asked = await connector.requestReturn(store as ChannelStore, exported.remoteOrderId, { lines: remote, reason: input.reason, ...(input.note ? { note: input.note } : {}) });
      if (!asked.ok) return PluginErr(asked.error.message, asked.error.code);
      remoteReturnId = asked.value.remoteReturnId;
    }
    const [row] = await this.db.insert(channelReturns).values({
      organizationId: orgId,
      storeId: store.id,
      orderId,
      remoteReturnId,
      status: "requested",
      lines: input.lines,
      reason: input.reason,
      note: input.note ?? null,
    }).returning({ id: channelReturns.id, remoteReturnId: channelReturns.remoteReturnId, status: channelReturns.status });
    if (!row) return PluginErr("The return could not be recorded.");
    return Ok(row);
  }

  /** Returns held on the platform (stores with none of their own) that wait for their merchant. */
  async listReturns(orgId: string, context?: StoreReadContext): Promise<PluginResult<ChannelReturnView[]>> {
    const allowed = await this.allowedStores(orgId, context);
    if (allowed !== null && allowed.length === 0) return Ok([]);
    const rows = await this.db.select().from(channelReturns).where(and(
      eq(channelReturns.organizationId, orgId),
      eq(channelReturns.status, "requested"),
      sql`${channelReturns.remoteReturnId} like ${`${PLATFORM_RETURN_PREFIX}%`}`,
      ...(allowed === null ? [] : [inArray(channelReturns.storeId, [...allowed])]),
    )).orderBy(desc(channelReturns.createdAt));
    if (rows.length === 0) return Ok([]);
    const orderIds = [...new Set(rows.map((row) => row.orderId))];
    const orderRows = await this.db.select({ id: orders.id, orderNumber: orders.orderNumber, shippingTotal: orders.shippingTotal }).from(orders)
      .where(and(eq(orders.organizationId, orgId), inArray(orders.id, orderIds)));
    const lineRows = await this.db.select({ id: orderLineItems.id, title: orderLineItems.title }).from(orderLineItems).where(inArray(orderLineItems.orderId, orderIds));
    const refunded = await this.db.select({ orderId: orderRefunds.orderId, shippingAmount: orderRefunds.shippingAmount }).from(orderRefunds)
      .where(and(inArray(orderRefunds.orderId, orderIds), eq(orderRefunds.status, "completed")));
    return Ok(rows.map((row) => {
      const order = orderRows.find((candidate) => candidate.id === row.orderId);
      const shippingRefunded = refunded.filter((refund) => refund.orderId === row.orderId).reduce((sum, refund) => sum + refund.shippingAmount, 0);
      return {
        ...row,
        orderNumber: order?.orderNumber ?? null,
        items: row.lines.map((line) => ({ orderLineItemId: line.orderLineItemId, title: lineRows.find((candidate) => candidate.id === line.orderLineItemId)?.title ?? "Item", quantity: line.quantity })),
        shippingRefundable: Math.max(0, (order?.shippingTotal ?? 0) - shippingRefunded),
      };
    }));
  }

  /**
   * The merchant takes a held return back: the shopper is paid back those lines (and the delivery, when
   * the merchant refunds it), then the refund is booked at the store with the stock put back, and kept
   * as an executed refund request under the store's own refund id so the store's webhook for it pays
   * nobody twice. If the store will not book it, the shopper has still been paid and the return stays
   * `approved`; approving again only books it, with the delivery decided the first time.
   */
  async approveReturn(orgId: string, id: string, context?: StoreReadContext, options: { refundShipping?: boolean } = {}): Promise<PluginResult<ChannelReturn>> {
    const [held] = await this.db.select().from(channelReturns).where(and(eq(channelReturns.organizationId, orgId), eq(channelReturns.id, id)));
    if (!held || !held.remoteReturnId.startsWith(PLATFORM_RETURN_PREFIX)) return PluginErr("Return not found.", "NOT_FOUND");
    const reached = await this.reachableStore(orgId, held.storeId, context);
    if (!reached.ok) return PluginErr("Return not found.", "NOT_FOUND");
    if (held.status !== "requested" && held.status !== "approved") return PluginErr(`This return is already ${held.status}.`, "CONFLICT");
    const store = reached.value;
    const connector = this.connectors.get(store.provider);
    if (!connector?.recordRefund) return PluginErr(`Returns are not available for ${store.provider} stores.`, "NOT_IMPLEMENTED");
    const [exported] = await this.db.select({ remoteOrderId: channelOrderExports.remoteOrderId }).from(channelOrderExports)
      .where(and(eq(channelOrderExports.organizationId, orgId), eq(channelOrderExports.orderId, held.orderId), eq(channelOrderExports.storeId, store.id)));
    if (!exported?.remoteOrderId) return PluginErr("This order never reached the store.", "NOT_FOUND");

    const orderLines = await this.db.select().from(orderLineItems).where(eq(orderLineItems.orderId, held.orderId));
    const priced: Array<{ lineItemId: string; quantity: number; variantId: string | null; amount: number }> = [];
    for (const line of held.lines) {
      const item = orderLines.find((candidate) => candidate.id === line.orderLineItemId);
      if (!item) return PluginErr(`Line ${line.orderLineItemId} is no longer on this order.`, "VALIDATION_FAILED");
      priced.push({ lineItemId: item.id, quantity: line.quantity, variantId: item.variantId, amount: Math.round((item.totalPrice + item.taxAmount - item.discountAmount) * line.quantity / item.quantity) });
    }
    const actor = createSystemActor(orgId);
    let shippingAmount = held.shippingAmount;
    if (held.status === "requested") {
      if (options.refundShipping === true) {
        const [order] = await this.db.select({ shippingTotal: orders.shippingTotal }).from(orders).where(and(eq(orders.organizationId, orgId), eq(orders.id, held.orderId)));
        const refunded = await this.db.select({ shippingAmount: orderRefunds.shippingAmount }).from(orderRefunds)
          .where(and(eq(orderRefunds.orderId, held.orderId), eq(orderRefunds.status, "completed")));
        shippingAmount = Math.max(0, (order?.shippingTotal ?? 0) - refunded.reduce((sum, refund) => sum + refund.shippingAmount, 0));
      }
      const ordersService = this.services.orders as { refundLines(orderId: string, input: { lines: Array<{ lineItemId: string; quantity: number }>; reason?: string; shippingAmount?: number }, actor: Actor): Promise<{ ok: boolean; error?: { message: string } }> };
      const refunded = await ordersService.refundLines(held.orderId, { lines: priced.map(({ lineItemId, quantity }) => ({ lineItemId, quantity })), reason: `Return ${held.id}`, ...(shippingAmount > 0 ? { shippingAmount } : {}) }, actor);
      if (!refunded.ok) return PluginErr(refunded.error?.message ?? "The shopper could not be paid back.", "REFUND_FAILED");
      await this.db.update(channelReturns).set({ status: "approved", shippingAmount, updatedAt: new Date() }).where(and(eq(channelReturns.organizationId, orgId), eq(channelReturns.id, held.id)));
    }

    const variantIds = priced.flatMap((line) => (line.variantId === null ? [] : [line.variantId]));
    const mapped = variantIds.length === 0 ? [] : await this.db.select({ variantId: channelEntityMap.variantId, externalId: channelEntityMap.externalId }).from(channelEntityMap)
      .where(and(eq(channelEntityMap.organizationId, orgId), eq(channelEntityMap.storeId, store.id), eq(channelEntityMap.kind, "variant"), inArray(channelEntityMap.variantId, variantIds)));
    const storeLines: Array<{ externalVariantId: string; quantity: number; amount: number }> = [];
    for (const line of priced) {
      const externalId = mapped.find((entry) => entry.variantId === line.variantId)?.externalId;
      if (!externalId) return PluginErr("The shopper was paid back, but the store has no record of a returned line, so it was not booked there.", "CHANNEL_MAPPING_MISSING");
      storeLines.push({ externalVariantId: externalId, quantity: line.quantity, amount: line.amount });
    }
    const amount = storeLines.reduce((sum, line) => sum + line.amount, 0) + shippingAmount;
    const booked = await connector.recordRefund(store as ChannelStore, exported.remoteOrderId, { lines: storeLines, amount, ...(shippingAmount > 0 ? { shippingAmount } : {}), reason: `Return: ${held.reason}`, restock: true });
    if (!booked.ok) return PluginErr(`The shopper was paid back, but the store did not record the refund (${booked.error.message}). Approve again to retry.`, "CHANNEL_REFUND_NOT_RECORDED");
    const lines = priced.map(({ lineItemId, quantity }) => ({ lineItemId, quantity }));
    await this.db.insert(channelRefundRequests)
      .values({ organizationId: orgId, storeId: store.id, orderId: held.orderId, remoteRefundId: booked.value.remoteRefundId, amount, shippingAmount, lines, state: "executed", approvedBy: requireUserId(actor) })
      .onConflictDoUpdate({ target: [channelRefundRequests.storeId, channelRefundRequests.remoteRefundId], set: { amount, shippingAmount, adjustmentAmount: 0, lines, state: "executed", updatedAt: new Date() } });
    const [closed] = await this.db.update(channelReturns).set({ status: "closed", updatedAt: new Date() }).where(and(eq(channelReturns.organizationId, orgId), eq(channelReturns.id, held.id))).returning();
    return closed ? Ok(closed) : PluginErr("Return not found.", "NOT_FOUND");
  }

  /** The merchant refuses a held return. Nothing moves. */
  async declineReturn(orgId: string, id: string, context?: StoreReadContext): Promise<PluginResult<ChannelReturn>> {
    const [held] = await this.db.select().from(channelReturns).where(and(eq(channelReturns.organizationId, orgId), eq(channelReturns.id, id)));
    if (!held || !held.remoteReturnId.startsWith(PLATFORM_RETURN_PREFIX)) return PluginErr("Return not found.", "NOT_FOUND");
    const reached = await this.reachableStore(orgId, held.storeId, context);
    if (!reached.ok) return PluginErr("Return not found.", "NOT_FOUND");
    const [declined] = await this.db.update(channelReturns).set({ status: "declined", updatedAt: new Date() })
      .where(and(eq(channelReturns.organizationId, orgId), eq(channelReturns.id, held.id), eq(channelReturns.status, "requested"))).returning();
    return declined ? Ok(declined) : PluginErr(`This return is already ${held.status}.`, "CONFLICT");
  }

  /** A cancelled or refunded order: nothing to push to a store, ever again. */
  async isOrderClosed(orgId: string, orderId: string): Promise<boolean> {
    const [order] = await this.db.select({ status: orders.status }).from(orders).where(and(eq(orders.organizationId, orgId), eq(orders.id, orderId)));
    return order?.status === "cancelled" || order?.status === "refunded";
  }

  async exportOrder(
    orgId: string,
    storeId: string,
    slice: ChannelOrderSlice,
    actor: Actor,
  ): Promise<PluginResult<ChannelOrderExport>> {
    const store = await this.getStoreRecord(orgId, storeId);
    if (!store || store.status !== "connected") {
      return PluginErr("Connected store not found.", "NOT_FOUND");
    }
    const connector = this.connectors.get(store.provider);
    if (!connector) return PluginErr(`No connector registered for provider "${store.provider}".`);

    const created = await this.createExport(orgId, storeId, slice.orderId);
    if (!created.ok) return created;
    if (created.value.state === "confirmed") return created;
    if (created.value.state !== "exported") {
      const exported = await this.transitionExport(
        orgId,
        created.value.id,
        "exported",
        requireUserId(actor),
        "Export attempt started.",
      );
      if (!exported.ok) return exported;
    }

    await this.db
      .update(channelOrderExports)
      .set({ customerData: slice.customer, updatedAt: new Date() })
      .where(and(
        eq(channelOrderExports.organizationId, orgId),
        eq(channelOrderExports.id, created.value.id),
      ));

    const pushed = await connector.pushOrder(store as ChannelStore, slice);
    if (!pushed.ok) {
      const failed = await this.transitionExport(
        orgId,
        created.value.id,
        "failed",
        requireUserId(actor),
        pushed.error.message,
        pushed.error.retriable === true ? "transient" : "definitive",
      );
      if (pushed.error.code === CHANNEL_OUT_OF_STOCK) {
        // The store has said nobody will send these goods: cancel, and let the host's cancel path
        // refund the shopper. Any other refusal can be fixed and retried, so it waits for an operator.
        const ordersService = this.services.orders as { changeStatus(input: { orderId: string; newStatus: "cancelled"; reason: string }, actor: Actor): Promise<{ ok: boolean }> };
        await ordersService.changeStatus({ orderId: slice.orderId, newStatus: "cancelled", reason: "channel_out_of_stock" }, actor);
      }
      return failed;
    }

    await this.db
      .update(channelOrderExports)
      .set({
        remoteOrderId: pushed.value.remoteOrderId,
        remoteUrl: pushed.value.remoteUrl ?? null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(channelOrderExports.organizationId, orgId),
        eq(channelOrderExports.id, created.value.id),
      ));

    const remoteStatus = await connector.fetchOrderStatus(
      store as ChannelStore,
      pushed.value.remoteOrderId,
    );
    if (!remoteStatus.ok) {
      return this.transitionExport(
        orgId,
        created.value.id,
        "failed",
        requireUserId(actor),
        remoteStatus.error.message,
        remoteStatus.error.retriable === true ? "transient" : "definitive",
      );
    }
    // `fulfilled` is a received order too: WooCommerce completes virtual and downloadable orders on
    // arrival, and an export waiting for `confirmed` would wait forever.
    if (remoteStatus.value.status === "confirmed" || remoteStatus.value.status === "fulfilled") {
      return this.transitionExport(
        orgId,
        created.value.id,
        "confirmed",
        requireUserId(actor),
        remoteStatus.value.status === "fulfilled" ? "Remote order received and completed by the store." : "Remote order confirmed.",
      );
    }
    if (remoteStatus.value.status === "failed" || remoteStatus.value.status === "cancelled") {
      return this.transitionExport(
        orgId,
        created.value.id,
        "failed",
        requireUserId(actor),
        `Remote order status: ${remoteStatus.value.status}.`,
      );
    }

    const refreshed = await this.getExport(orgId, created.value.id);
    return refreshed;
  }

  async buildOrderSlice(
    orgId: string,
    storeId: string,
    orderId: string,
  ): Promise<PluginResult<ChannelOrderSlice>> {
    const [order] = await this.db.select().from(orders).where(and(eq(orders.organizationId, orgId), eq(orders.id, orderId)));
    if (!order) return PluginErr("Order not found.", "NOT_FOUND");
    const lineItems = await this.db.select().from(orderLineItems).where(eq(orderLineItems.orderId, orderId));
    const entities = await this.db.select({ id: sellableEntities.id, sourceStoreId: sellableEntities.sourceStoreId }).from(sellableEntities).where(and(eq(sellableEntities.organizationId, orgId), inArray(sellableEntities.id, lineItems.map((line) => line.entityId))));
    const entityStores = new Map(entities.map((entity) => [entity.id, entity.sourceStoreId]));
    const mappings = await this.db.select().from(channelEntityMap).where(and(eq(channelEntityMap.organizationId, orgId), eq(channelEntityMap.storeId, storeId)));
    const selected = lineItems.filter((line) => entityStores.get(line.entityId) === storeId);
    const lines = [];
    for (const line of selected) {
      const mapping = (line.variantId && mappings.find((item) => item.kind === "variant" && item.variantId === line.variantId)) ?? mappings.find((item) => item.kind === "entity" && item.entityId === line.entityId);
      if (!mapping) return PluginErr(`External mapping is missing for order line ${line.id}.`, "MAPPING_MISSING");
      lines.push({ externalVariantId: mapping.externalId, ...(line.sku ? { sku: line.sku } : {}), title: line.title, quantity: line.quantity, unitPrice: line.unitPrice, totalPrice: line.totalPrice, ...(line.discountAmount > 0 ? { discountAmount: line.discountAmount } : {}) });
    }

    let email: string | null = null;
    let name = "";
    let shippingAddress: ChannelOrderAddress | null = null;
    if (order.customerId) {
      const [customer] = await this.db.select().from(customers).where(and(eq(customers.organizationId, orgId), eq(customers.id, order.customerId)));
      if (customer) {
        email = customer.email;
        name = `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim();
        // The saved default is a FALLBACK. It was read first and the order's own address only when it
        // was missing, so a shopper who typed an address, or picked a non-default one, had the order
        // shipped to their default. The order's address is applied below and wins.
        const addresses = await this.db.select().from(customerAddresses).where(and(eq(customerAddresses.customerId, customer.id), eq(customerAddresses.type, "shipping")));
        const address = addresses.find((item) => item.isDefault) ?? addresses[0];
        if (address) {
          shippingAddress = {
            firstName: address.firstName ?? "",
            lastName: address.lastName ?? "",
            line1: address.line1,
            ...(address.line2 ? { line2: address.line2 } : {}),
            city: address.city,
            ...(address.state ? { region: address.state } : {}),
            ...(address.postalCode ? { postalCode: address.postalCode } : {}),
            countryCode: address.country,
            ...(address.phone ? { phone: address.phone } : {}),
          };
        }
      }
    }
    const metadata = order.metadata ?? {};
    const guest = (metadata.customer ?? metadata.guestCustomer ?? {}) as Record<string, unknown>;
    email ??= typeof guest.email === "string" ? guest.email : null;
    name ||= typeof guest.name === "string" ? guest.name : `${typeof guest.firstName === "string" ? guest.firstName : ""} ${typeof guest.lastName === "string" ? guest.lastName : ""}`.trim();
    const orderShipping = metadata.shippingAddress ?? metadata.guestShippingAddress ?? (typeof metadata.guestCustomer === "object" && metadata.guestCustomer ? (metadata.guestCustomer as Record<string, unknown>).shippingAddress : undefined);
    if (orderShipping !== undefined) {
      const parsed = channelOrderAddressSchema.safeParse(orderShipping);
      if (!parsed.success) return PluginErr(`The order's shipping address is not a channel order address: ${parsed.error.issues[0]?.message ?? "invalid"}.`, "CUSTOMER_DATA_MISSING");
      shippingAddress = withoutUndefined(parsed.data);
    }
    if (!email || !shippingAddress) return PluginErr("Customer email and shipping address are required for channel order export.", "CUSTOMER_DATA_MISSING");
    const linesTotal = lines.reduce((sum, line) => sum + line.totalPrice, 0);
    // ponytail: a multi-store order sends no shipping to any store; apportion it when such orders exist.
    const shipping = selected.length === lineItems.length && order.shippingTotal > 0 ? { title: "Shipping", amount: order.shippingTotal } : null;
    // ponytail: like delivery, a discount is sent only with the whole order; apportion it when multi-store orders exist.
    const discountCode = typeof metadata.promotionCode === "string" && metadata.promotionCode.trim() !== "" ? metadata.promotionCode.trim() : "DISCOUNT";
    const discount = selected.length === lineItems.length && order.discountTotal > 0 ? { code: discountCode, amount: order.discountTotal } : null;
    // A line's discount travels with the order discount it is a share of, never without it.
    const slicedLines = discount ? lines : lines.map(({ discountAmount: _share, ...line }) => line);
    return Ok({ orderId, currency: order.currency, grandTotal: linesTotal + (shipping?.amount ?? 0) - (discount?.amount ?? 0), lines: slicedLines, ...(shipping ? { shipping } : {}), ...(discount ? { discount } : {}), customer: { name, email, shippingAddress } });
  }

  async reapExports(input: { definitiveMs: number; transientMs: number }): Promise<{ abandonedCount: number; refundedOrderIds: string[] }> {
    const now = Date.now();
    const rows = await this.db.select().from(channelOrderExports).where(inArray(channelOrderExports.state, ["exported", "failed"]));
    const abandoned: string[] = [];
    const orderService = this.services.orders as { changeStatus(input: { orderId: string; newStatus: "refunded"; reason: string }, actor: Actor): Promise<{ ok: boolean; error?: { message: string } }> };
    for (const row of rows as ChannelOrderExport[]) {
      const age = now - row.updatedAt.getTime();
      const cutoff = row.failureKind === "definitive" ? input.definitiveMs : input.transientMs;
      if (age < cutoff) continue;
      const reason = `Channel order export ${row.id} abandoned after ${row.failureKind ?? "transient"} SLA.`;
      const abandonedResult = await this.abandonExport(row.organizationId, row.id, "system", reason);
      if (!abandonedResult.ok) continue;
      const refunded = await orderService.changeStatus({ orderId: row.orderId, newStatus: "refunded", reason }, createSystemActor(row.organizationId));
      if (refunded.ok) abandoned.push(row.orderId);
    }
    return { abandonedCount: abandoned.length, refundedOrderIds: abandoned };
  }

  async getExport(orgId: string, id: string): Promise<PluginResult<ChannelOrderExport>> {
    const rows = await this.db
      .select()
      .from(channelOrderExports)
      .where(and(eq(channelOrderExports.organizationId, orgId), eq(channelOrderExports.id, id)));
    const item = rows[0] as ChannelOrderExport | undefined;
    if (!item) return PluginErr("Channel order export not found.", "NOT_FOUND");
    return Ok(item);
  }

  async listFailedExports(orgId: string): Promise<PluginResult<ChannelOrderExport[]>> {
    const rows = await this.db
      .select()
      .from(channelOrderExports)
      .where(and(
        eq(channelOrderExports.organizationId, orgId),
        eq(channelOrderExports.state, "failed"),
      ));
    return Ok(rows as ChannelOrderExport[]);
  }

  /**
   * The operator's retry of a failed export: it runs the push again, as a job. The connector looks for
   * an order it may already have created before creating one (an unclear first answer is exactly what
   * left the export failed), so a retry never puts a second order in the store.
   */
  async retryExport(
    orgId: string,
    exportId: string,
    changedBy: string,
  ): Promise<PluginResult<ChannelOrderExport>> {
    const moved = await this.transitionExport(orgId, exportId, "exported", changedBy, "Manual retry requested.");
    if (!moved.ok) return moved;
    const jobs = this.services.jobs as JobsAdapter | undefined;
    if (!jobs) return PluginErr("No jobs adapter is configured, so the retry cannot run.", "JOBS_UNAVAILABLE");
    const { storeId, orderId } = moved.value;
    await jobs.enqueue("channel/push-order", { orgId, storeId, orderId }, { organizationId: orgId, concurrencyKey: `push:${orderId}:${storeId}`, supersedes: true });
    return moved;
  }

  abandonExport(
    orgId: string,
    exportId: string,
    changedBy: string,
    reason?: string,
  ): Promise<PluginResult<ChannelOrderExport>> {
    return this.transitionExport(orgId, exportId, "abandoned", changedBy, reason);
  }

  async resolveCatalogPushEntityIds(
    orgId: string,
    storeId: string,
    entityIds?: string[],
  ): Promise<string[]> {
    if (entityIds !== undefined) return [...new Set(entityIds)].sort();
    const mappings = await this.db.select({ entityId: channelEntityMap.entityId }).from(channelEntityMap).where(and(
      eq(channelEntityMap.organizationId, orgId),
      eq(channelEntityMap.storeId, storeId),
      eq(channelEntityMap.kind, "entity"),
    ));
    return [...new Set(mappings.map((mapping) => mapping.entityId))].sort();
  }

  async createCatalogPush(
    orgId: string,
    storeId: string,
    entityId: string,
  ): Promise<PluginResult<ChannelCatalogPush>> {
    const store = await this.getStoreRecord(orgId, storeId);
    if (!store || store.status !== "connected") {
      return PluginErr("Connected store not found.", "NOT_FOUND");
    }
    const rows = await this.db
      .insert(channelCatalogPushes)
      .values({ organizationId: orgId, storeId, entityId })
      .onConflictDoNothing({ target: [channelCatalogPushes.storeId, channelCatalogPushes.entityId] })
      .returning();
    if (rows[0]) return Ok(rows[0] as ChannelCatalogPush);
    const existing = await this.db
      .select()
      .from(channelCatalogPushes)
      .where(and(
        eq(channelCatalogPushes.organizationId, orgId),
        eq(channelCatalogPushes.storeId, storeId),
        eq(channelCatalogPushes.entityId, entityId),
      ));
    if (!existing[0]) return PluginErr("Failed to create channel catalog push.");
    return Ok(existing[0] as ChannelCatalogPush);
  }

  async transitionCatalogPush(
    orgId: string,
    pushId: string,
    toState: CatalogPushState,
    changedBy: string,
    reason?: string,
    failureKind?: "definitive" | "transient",
    payloadSnapshot?: ChannelPushCatalogItem | null,
  ): Promise<PluginResult<ChannelCatalogPush>> {
    return this.transact(async (tx) => {
      const currentRows = await tx
        .select()
        .from(channelCatalogPushes)
        .where(and(
          eq(channelCatalogPushes.organizationId, orgId),
          eq(channelCatalogPushes.id, pushId),
        ));
      const current = currentRows[0] as ChannelCatalogPush | undefined;
      if (!current) return PluginErr("Channel catalog push not found.", "NOT_FOUND");
      if (!canCatalogPushTransition(current.state, toState)) {
        const error = new CommerceInvalidTransitionError(
          `Cannot transition channel catalog push from ${current.state} to ${toState}.`,
        );
        return PluginErr(error.message, error.code);
      }

      const updatedRows = await tx
        .update(channelCatalogPushes)
        .set({
          state: toState,
          updatedAt: new Date(),
          ...(payloadSnapshot !== undefined ? { payloadSnapshot } : {}),
          ...(toState === "exported" ? { attempts: current.attempts + 1, lastError: null, failureKind: null } : {}),
          ...(toState === "failed" ? { lastError: reason ?? "Catalog push failed." } : {}),
          ...(toState === "failed" ? { failureKind: failureKind ?? "definitive" } : {}),
          ...(toState === "confirmed" ? { lastError: null, failureKind: null } : {}),
        })
        .where(and(
          eq(channelCatalogPushes.organizationId, orgId),
          eq(channelCatalogPushes.id, pushId),
          eq(channelCatalogPushes.state, current.state),
        ))
        .returning();
      const updated = updatedRows[0] as ChannelCatalogPush | undefined;
      if (!updated) return PluginErr("Channel catalog push changed concurrently.", "CONFLICT");

      await tx.insert(channelCatalogPushEvents).values({
        organizationId: orgId,
        pushId,
        fromState: current.state,
        toState,
        reason: reason ?? null,
        changedBy,
      });
      return Ok(updated);
    });
  }

  private async recordCatalogPushRevisions(
    orgId: string,
    entityIds: string[],
    actor: Actor,
  ): Promise<PluginResult<void>> {
    if (entityIds.length === 0) return Ok(undefined);
    try {
      await this.transact(async (tx) => {
        const txContext = createTxContext(tx, { actor });
        for (const entityId of [...new Set(entityIds)]) {
          const revision = await this.catalog.recordEntityRevision(entityId, actor, "push", txContext);
          if (!revision.ok) throw new Error(revision.error.message);
        }
      });
    } catch (error) {
      return PluginErr(error instanceof Error ? error.message : "Failed to record catalog push revisions.");
    }
    return Ok(undefined);
  }

  async executeCatalogPushJob(
    orgId: string,
    storeId: string,
    options: { entityIds?: string[]; cursor?: string; forceFieldPaths?: Record<string, FieldPath[]> },
    actor: Actor,
    runtime: { jobs: JobsAdapter },
  ): Promise<PluginResult<CatalogPushJobResult>> {
    const store = await this.getStoreRecord(orgId, storeId);
    if (!store || store.status !== "connected") return PluginErr("Connected store not found.", "NOT_FOUND");
    if (!store.catalogWriteEnabled) return Ok({ noop: true });
    const connector = this.connectors.get(store.provider);
    if (!connector) return PluginErr(`No connector registered for provider "${store.provider}".`);
    if (!connector.pushCatalog) return Ok({ noop: true });
    if (isCatalogPushBreakerOpen(store.breakerState)) {
      await runtime.jobs.enqueue("channel/push-catalog", {
        organizationId: orgId,
        storeId,
        ...(options.entityIds ? { entityIds: options.entityIds } : {}),
        ...(options.forceFieldPaths ? { forceFieldPaths: options.forceFieldPaths } : {}),
        ...(options.cursor ? { cursor: options.cursor } : {}),
      }, {
        organizationId: orgId,
        concurrencyKey: catalogPushConcurrencyKey({ storeId, entityIds: options.entityIds }),
        supersedes: false,
        delayMs: CATALOG_PUSH_BREAKER_RETRY_MS,
      });
      return Ok({ rescheduled: true });
    }

    const allEntityIds = await this.resolveCatalogPushEntityIds(orgId, storeId, options.entityIds);
    const batchSize = catalogPushBatchSize(store.provider);
    const pageEntityIds = options.cursor
      ? allEntityIds.filter((entityId) => entityId > options.cursor!).slice(0, batchSize)
      : allEntityIds.slice(0, batchSize);
    if (pageEntityIds.length === 0) return Ok({ complete: true, pushed: 0, failed: 0 });

    // Abandoned is terminal: a row that exhausted its attempts stays out of
    // every later sweep until an operator re-arms it.
    const abandonedRows = await this.db.select({ entityId: channelCatalogPushes.entityId }).from(channelCatalogPushes).where(and(
      eq(channelCatalogPushes.organizationId, orgId),
      eq(channelCatalogPushes.storeId, storeId),
      eq(channelCatalogPushes.state, "abandoned"),
      inArray(channelCatalogPushes.entityId, pageEntityIds),
    ));
    const abandonedEntityIds = new Set(abandonedRows.map((row) => row.entityId));
    const batchEntityIds = pageEntityIds.filter((entityId) => !abandonedEntityIds.has(entityId));
    if (batchEntityIds.length === 0) {
      const batchCursor = pageEntityIds[pageEntityIds.length - 1]!;
      const hasMore = allEntityIds.some((entityId) => entityId > batchCursor);
      if (!hasMore) return Ok({ complete: true, pushed: 0, failed: 0 });
      await runtime.jobs.enqueue("channel/push-catalog", {
        organizationId: orgId,
        storeId,
        ...(options.entityIds ? { entityIds: options.entityIds } : {}),
        ...(options.forceFieldPaths ? { forceFieldPaths: options.forceFieldPaths } : {}),
        cursor: batchCursor,
      }, {
        organizationId: orgId,
        concurrencyKey: catalogPushConcurrencyKey({ storeId, entityIds: options.entityIds }),
        supersedes: false,
      });
      return Ok({ complete: false, cursor: batchCursor, pushed: 0, failed: 0 });
    }

    const assembled = await this.buildCatalogPushItems(orgId, storeId, batchEntityIds, {
      ...(options.forceFieldPaths ? { forceFieldPaths: options.forceFieldPaths } : {}),
    });
    if (!assembled.ok) return assembled;

    const mappings = await this.db.select({
      entityId: channelEntityMap.entityId,
      externalId: channelEntityMap.externalId,
    }).from(channelEntityMap).where(and(
      eq(channelEntityMap.organizationId, orgId),
      eq(channelEntityMap.storeId, storeId),
      eq(channelEntityMap.kind, "entity"),
      inArray(channelEntityMap.entityId, batchEntityIds),
    ));
    const externalByEntity = new Map(mappings.map((mapping) => [mapping.entityId, mapping.externalId]));
    const entityByExternal = new Map(mappings.map((mapping) => [mapping.externalId, mapping.entityId]));
    const itemByExternal = new Map(assembled.value.items.map((item) => [item.externalId, item]));

    let pushed = 0;
    let failed = 0;

    if (assembled.value.items.length === 0) {
      for (const entityId of batchEntityIds) {
        const created = await this.createCatalogPush(orgId, storeId, entityId);
        if (!created.ok) return created;
        if (created.value.state === "confirmed" || created.value.state === "abandoned") {
          if (created.value.state === "confirmed") pushed += 1;
          continue;
        }
        const confirmed = await this.transitionCatalogPush(
          orgId,
          created.value.id,
          "confirmed",
          requireUserId(actor),
          "No platform-owned fields to push.",
          undefined,
          null,
        );
        if (!confirmed.ok) return confirmed;
        pushed += 1;
      }
    } else {
      const pushIds = new Map<string, string>();
      const pushAttempts = new Map<string, number>();
      for (const entityId of batchEntityIds) {
        const externalId = externalByEntity.get(entityId);
        const item = externalId ? itemByExternal.get(externalId) : undefined;
        if (!item) continue;
        const created = await this.createCatalogPush(orgId, storeId, entityId);
        if (!created.ok) return created;
        pushIds.set(item.externalId, created.value.id);
        pushAttempts.set(item.externalId, created.value.attempts);
        if (created.value.state === "pending" || created.value.state === "confirmed" || created.value.state === "failed") {
          const exported = await this.transitionCatalogPush(
            orgId,
            created.value.id,
            "exported",
            requireUserId(actor),
            "Catalog push attempt started.",
            undefined,
            item,
          );
          if (!exported.ok) return exported;
          pushAttempts.set(item.externalId, exported.value.attempts);
        }
      }

      const items = assembled.value.items;
      const writeAhead = await this.recordOutboundPush(
        orgId,
        storeId,
        items.map((item) => ({ externalId: item.externalId, ok: true })),
        items,
        "write-ahead",
      );
      if (!writeAhead.ok) return writeAhead;

      let result: Awaited<ReturnType<NonNullable<typeof connector.pushCatalog>>>;
      try {
        result = await connector.pushCatalog(store as ChannelStore, items);
      } catch (error) {
        const connectorError = {
          code: "CATALOG_PUSH_THROWN",
          message: error instanceof Error ? error.message : "Catalog push failed.",
        };
        const cleared = await this.recordOutboundPush(
          orgId,
          storeId,
          items.map((item) => ({ externalId: item.externalId, ok: false, error: connectorError })),
          items,
        );
        if (!cleared.ok) return cleared;
        for (const item of items) {
          const pushId = pushIds.get(item.externalId);
          if (!pushId) continue;
          const attempts = pushAttempts.get(item.externalId) ?? 0;
          if (attempts >= CATALOG_PUSH_MAX_ATTEMPTS) {
            await this.transitionCatalogPush(
              orgId,
              pushId,
              "abandoned",
              requireUserId(actor),
              connectorError.message,
            );
          } else {
            await this.transitionCatalogPush(
              orgId,
              pushId,
              "failed",
              requireUserId(actor),
              connectorError.message,
              "transient",
            );
          }
          failed += 1;
        }
        const maxAttempts = Math.max(0, ...items.map((item) => pushAttempts.get(item.externalId) ?? 0));
        if (maxAttempts < CATALOG_PUSH_MAX_ATTEMPTS) {
          await runtime.jobs.enqueue("channel/push-catalog", {
            organizationId: orgId,
            storeId,
            ...(options.entityIds ? { entityIds: options.entityIds } : {}),
            ...(options.forceFieldPaths ? { forceFieldPaths: options.forceFieldPaths } : {}),
            ...(options.cursor ? { cursor: options.cursor } : {}),
          }, {
            organizationId: orgId,
            concurrencyKey: catalogPushConcurrencyKey({ storeId, entityIds: options.entityIds }),
            supersedes: false,
            delayMs: catalogPushRetryDelayMs(maxAttempts),
          });
        }
        return Ok({ rescheduled: true, pushed, failed });
      }

      if (!result.ok) {
        const cleared = await this.recordOutboundPush(
          orgId,
          storeId,
          items.map((item) => ({ externalId: item.externalId, ok: false, error: result.error })),
          items,
        );
        if (!cleared.ok) return cleared;
        for (const item of items) {
          const pushId = pushIds.get(item.externalId);
          if (!pushId) continue;
          const attempts = pushAttempts.get(item.externalId) ?? 0;
          const failureKind = result.error.retriable === true ? "transient" as const : "definitive" as const;
          if (failureKind === "transient" && attempts >= CATALOG_PUSH_MAX_ATTEMPTS) {
            await this.transitionCatalogPush(
              orgId,
              pushId,
              "abandoned",
              requireUserId(actor),
              result.error.message,
            );
          } else {
            await this.transitionCatalogPush(
              orgId,
              pushId,
              "failed",
              requireUserId(actor),
              result.error.message,
              failureKind,
            );
          }
          failed += 1;
        }
        if (result.error.retriable === true) {
          const maxAttempts = Math.max(0, ...items.map((item) => pushAttempts.get(item.externalId) ?? 0));
          if (maxAttempts < CATALOG_PUSH_MAX_ATTEMPTS) {
            await runtime.jobs.enqueue("channel/push-catalog", {
              organizationId: orgId,
              storeId,
              ...(options.entityIds ? { entityIds: options.entityIds } : {}),
              ...(options.forceFieldPaths ? { forceFieldPaths: options.forceFieldPaths } : {}),
              ...(options.cursor ? { cursor: options.cursor } : {}),
            }, {
              organizationId: orgId,
              concurrencyKey: catalogPushConcurrencyKey({ storeId, entityIds: options.entityIds }),
              supersedes: false,
              delayMs: catalogPushRetryDelayMs(maxAttempts),
            });
          }
          return Ok({ rescheduled: true, pushed, failed });
        }
        const batchCursor = pageEntityIds[pageEntityIds.length - 1]!;
        const hasMore = allEntityIds.some((entityId) => entityId > batchCursor);
        return Ok({ complete: !hasMore, pushed, failed });
      }

      const recorded = await this.recordOutboundPush(orgId, storeId, result.value.outcomes, items);
      if (!recorded.ok) return recorded;

      const successfulEntityIds: string[] = [];
      for (const outcome of result.value.outcomes) {
        const pushId = pushIds.get(outcome.externalId);
        const entityId = entityByExternal.get(outcome.externalId);
        if (!pushId || !entityId) continue;
        const item = itemByExternal.get(outcome.externalId);
        if (outcome.ok) {
          const confirmed = await this.transitionCatalogPush(
            orgId,
            pushId,
            "confirmed",
            requireUserId(actor),
            "Remote catalog confirmed item.",
            undefined,
            item ?? null,
          );
          if (!confirmed.ok) return confirmed;
          successfulEntityIds.push(entityId);
          pushed += 1;
          continue;
        }
        const failureKind = outcome.error?.retriable === true ? "transient" : "definitive";
        const attempts = pushAttempts.get(outcome.externalId) ?? 0;
        if (failureKind === "transient" && attempts >= CATALOG_PUSH_MAX_ATTEMPTS) {
          const abandoned = await this.transitionCatalogPush(
            orgId,
            pushId,
            "abandoned",
            requireUserId(actor),
            outcome.error?.message ?? "Catalog push failed.",
            undefined,
            item ?? null,
          );
          if (!abandoned.ok) return abandoned;
        } else {
          const failedPush = await this.transitionCatalogPush(
            orgId,
            pushId,
            "failed",
            requireUserId(actor),
            outcome.error?.message ?? "Catalog push failed.",
            failureKind,
            item ?? null,
          );
          if (!failedPush.ok) return failedPush;
          if (failureKind === "transient") {
            await runtime.jobs.enqueue("channel/push-catalog", {
              organizationId: orgId,
              storeId,
              entityIds: [entityId],
              ...(options.forceFieldPaths?.[entityId]
                ? { forceFieldPaths: { [entityId]: options.forceFieldPaths[entityId] } }
                : {}),
            }, {
              organizationId: orgId,
              concurrencyKey: catalogPushConcurrencyKey({ storeId, entityIds: [entityId] }),
              supersedes: true,
              delayMs: catalogPushRetryDelayMs(attempts),
            });
          }
        }
        failed += 1;
      }

      const revisions = await this.recordCatalogPushRevisions(orgId, successfulEntityIds, actor);
      if (!revisions.ok) return revisions;
    }

    const batchCursor = pageEntityIds[pageEntityIds.length - 1]!;
    const hasMore = allEntityIds.some((entityId) => entityId > batchCursor);
    if (hasMore) {
      await runtime.jobs.enqueue("channel/push-catalog", {
        organizationId: orgId,
        storeId,
        ...(options.entityIds ? { entityIds: options.entityIds } : {}),
        ...(options.forceFieldPaths ? { forceFieldPaths: options.forceFieldPaths } : {}),
        cursor: batchCursor,
      }, {
        organizationId: orgId,
        concurrencyKey: catalogPushConcurrencyKey({ storeId, entityIds: options.entityIds }),
        supersedes: false,
      });
      return Ok({ complete: false, cursor: batchCursor, pushed, failed });
    }

    return Ok({ complete: true, pushed, failed });
  }
}
