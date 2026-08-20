import { createHash } from "node:crypto";
import {
  CommerceInvalidTransitionError,
  CommerceValidationError,
  Ok,
  PluginErr,
  createTxContext,
  createSystemActor,
} from "@porulle/core";
import type {
  Actor,
  ChannelCatalogItem,
  ChannelConnector,
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
  TxContext,
} from "@porulle/core";
import { isValidFieldPath } from "@porulle/core";
import type { FieldOwner, FieldPath } from "@porulle/core";
import type { JobsAdapter } from "@porulle/core";
import { CHANNEL_CONVERGENCE_CTX } from "./catalog-push-trigger.js";
import { and, desc, eq, inArray, isNull, lte } from "@porulle/core/drizzle";
import {
  brands,
  categories,
  customerAddresses,
  customers,
  entityMedia,
  entityTags,
  inventoryLevels,
  mediaAssets,
  optionTypes,
  optionValues,
  orderLineItems,
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
import {
  channelCatalogPushEvents,
  channelCatalogPushes,
  channelCatalogConflicts,
  channelCatalogConflictEvents,
  channelEntityMap,
  channelExportEvents,
  channelOrderExports,
  connectedStores,
  channelRefundEvents,
  channelRefundRequests,
  type ChannelCatalogPush,
  type ChannelCatalogConflict,
  type ChannelOrderExport,
  type ChannelRefundRequest,
  type ConnectedStore,
} from "./schema.js";
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
  skipped?: CatalogFieldSkip[];
  conflicts?: CatalogFieldConflict[];
  warnings?: string[];
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

export interface ChannelConnectorPluginOptions {
  connectors?: ChannelConnector[];
  oauth?: { stateSecret: string; postConnectRedirect: string };
  inventoryTimeoutMs?: number;
  jobs?: JobsAdapter;
  exportSla?: { definitiveMs?: number; transientMs?: number };
  refundAutoMax?: number;
  newStoreDays?: number;
  driftAlertThreshold?: number;
  reconcileJitterWindowMs?: number;
}

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

interface CatalogConvergenceStats {
  imported: number;
  converged: number;
  entitiesTouched: number;
  attributesCreated: number;
  mediaImported: number;
  variantsGivenOptionValues: number;
  skipped: CatalogFieldSkip[];
  conflicts: CatalogFieldConflict[];
  warnings: string[];
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
  attachToEntity(
    input: {
      entityId: string;
      mediaAssetId: string;
      role: "primary" | "gallery" | "thumbnail" | "video" | "document";
      variantId?: string;
      sortOrder?: number;
    },
    actor: Actor,
  ): Promise<ServiceResult<undefined>>;
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

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

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

function redactStore(store: ConnectedStore): PublicConnectedStore {
  return {
    id: store.id,
    organizationId: store.organizationId,
    provider: store.provider,
    credentials: "[REDACTED]",
    storeDomain: store.storeDomain,
    status: store.status,
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
      this.connectors.set(connector.providerId, connector);
    }
    this.jobs = options.jobs ?? (services.jobs as JobsAdapter | undefined);
    this.transact = transaction ?? ((fn) => this.db.transaction(fn));
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

  private async persistCatalogConflicts(
    orgId: string,
    conflicts: DetectedCatalogFieldConflict[],
    changedBy: string,
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
        reason: "Shared catalog field changed on both sides.",
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
    const existingTypes = await this.db.select().from(optionTypes).where(eq(optionTypes.entityId, entityId));
    let changed = false;
    for (const [typeIndex, sourceType] of (item.options ?? []).entries()) {
      let optionType = existingTypes.find((row) => row.name === sourceType.name);
      if (!optionType) {
        const created = await this.catalog.createOptionType({ entityId, name: sourceType.name, values: [] }, actor);
        if (!created.ok) return PluginErr(created.error.message);
        const [createdType] = await this.db.select().from(optionTypes).where(eq(optionTypes.id, created.value.id));
        if (!createdType) return PluginErr(`Option type "${sourceType.name}" was not persisted.`);
        optionType = createdType;
        existingTypes.push(optionType);
        changed = true;
      }
      await this.db.update(optionTypes).set({
        displayName: sourceType.displayName,
        sortOrder: sourceType.sortOrder ?? typeIndex,
      }).where(eq(optionTypes.id, optionType.id));

      const existingValues = await this.db.select().from(optionValues).where(eq(optionValues.optionTypeId, optionType.id));
      const valueIds = new Map<string, string>();
      for (const [valueIndex, sourceValue] of sourceType.values.entries()) {
        let optionValue = existingValues.find((row) => row.value === sourceValue.value);
        if (!optionValue) {
          const created = await this.catalog.createOptionValue({ optionTypeId: optionType.id, value: sourceValue.value }, actor);
          if (!created.ok) return PluginErr(created.error.message);
          const [createdValue] = await this.db.select().from(optionValues).where(eq(optionValues.id, created.value.id));
          if (!createdValue) return PluginErr(`Option value "${sourceValue.value}" was not persisted.`);
          optionValue = createdValue;
          existingValues.push(optionValue);
          changed = true;
        }
        await this.db.update(optionValues).set({
          displayValue: sourceValue.displayValue,
          sortOrder: sourceValue.sortOrder ?? valueIndex,
        }).where(eq(optionValues.id, optionValue.id));
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
    for (const sourceVariant of item.variants) {
      const fullSourceVariant = fullItem.variants.find((variant) => variant.externalId === sourceVariant.externalId) ?? sourceVariant;
      let mapping = mappings.find((row) => row.externalId === sourceVariant.externalId);
      let variantId = mapping?.variantId;
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
        if (mapping) mappings.push(mapping);
      }
      if (!variantId) {
        warnings.push(`Skipped variant "${sourceVariant.externalId}": no local variant mapping exists.`);
        continue;
      }
      variantIds.set(sourceVariant.externalId, variantId);
      if (applyOptionValues) {
        const desiredOptionValueIds = Object.entries(sourceVariant.optionValues ?? {})
          .map(([name, value]) => optionValueIds.get(name)?.get(value))
          .filter((optionValueId): optionValueId is string => optionValueId !== undefined);
        const currentOptionValues = await this.db.select().from(variantOptionValues).where(eq(variantOptionValues.variantId, variantId));
        const currentIds = currentOptionValues.map((row) => row.optionValueId).sort();
        const desiredIds = [...new Set(desiredOptionValueIds)].sort();
        if (currentIds.length !== desiredIds.length || currentIds.some((id, index) => id !== desiredIds[index])) {
          await this.db.delete(variantOptionValues).where(eq(variantOptionValues.variantId, variantId));
          if (desiredIds.length > 0) {
            await this.db.insert(variantOptionValues).values(desiredIds.map((optionValueId) => ({ variantId, optionValueId }))).onConflictDoNothing();
            repaired += 1;
          }
          changed = true;
        }
        if (createdVariant && desiredIds.length > 0) {
          repaired += 1;
          changed = true;
        }
      }
      for (const price of sourceVariant.prices ?? []) {
        const priced = await this.pricing.setBasePrice({
          entityId,
          variantId,
          currency: price.currency,
          amount: price.amount,
          compareAtAmount: price.compareAtAmount ?? null,
        }, actor);
        if (!priced.ok) return PluginErr(priced.error.message);
      }
      if (mapping) {
        await this.db.update(channelEntityMap).set({
          syncHash: hash(fullSourceVariant),
        }).where(eq(channelEntityMap.id, mapping.id));
      }
    }
    return Ok({ value: variantIds, repaired, changed });
  }

  private async applyTaxonomy(
    orgId: string,
    entityId: string,
    item: ChannelCatalogItem,
    actor: Actor,
    warnings: string[],
  ): Promise<PluginResult<void>> {
    const categoryRows = await this.db.select().from(categories).where(eq(categories.organizationId, orgId));
    for (const slug of new Set(item.categories ?? [])) {
      let category = categoryRows.find((row) => row.slug === slug);
      if (category?.status === "archived") {
        warnings.push(`Skipped archived category "${slug}".`);
        continue;
      }
      if (!category) {
        const created = await this.catalog.createCategory({ slug }, actor);
        if (!created.ok) return PluginErr(created.error.message);
        const [createdCategory] = await this.db.select().from(categories).where(eq(categories.id, created.value.id));
        if (!createdCategory) return PluginErr(`Category "${slug}" was not persisted.`);
        category = createdCategory;
        categoryRows.push(category);
      }
      const linked = await this.catalog.addToCategory(entityId, category.id, actor);
      if (!linked.ok) return PluginErr(linked.error.message);
    }

    const brandRows = await this.db.select().from(brands).where(eq(brands.organizationId, orgId));
    if (item.brand) {
      let brand = brandRows.find((row) => row.slug === item.brand);
      if (!brand) {
        const created = await this.catalog.createBrand({ slug: item.brand, displayName: item.brand }, actor);
        if (!created.ok) return PluginErr(created.error.message);
        const [createdBrand] = await this.db.select().from(brands).where(eq(brands.id, created.value.id));
        if (!createdBrand) return PluginErr(`Brand "${item.brand}" was not persisted.`);
        brand = createdBrand;
        brandRows.push(brand);
      }
      const linked = await this.catalog.addToBrand(entityId, brand.id, actor);
      if (!linked.ok) return PluginErr(linked.error.message);
    }

    const tagRows = await this.db.select().from(tags).where(eq(tags.organizationId, orgId));
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
      await this.db.insert(entityTags).values({ entityId, tagId: tag.id }).onConflictDoNothing();
    }
    return Ok(undefined);
  }

  private async applyMedia(
    orgId: string,
    entityId: string,
    item: ChannelCatalogItem,
    variantIds: Map<string, string>,
    actor: Actor,
    warnings: string[],
    owners: Map<FieldPath, FieldOwner>,
  ): Promise<PluginResult<{ imported: number; changed: boolean; skipped: FieldPath[] }>> {
    const assets = await this.db.select().from(mediaAssets).where(eq(mediaAssets.organizationId, orgId));
    const links = await this.db.select().from(entityMedia).where(eq(entityMedia.entityId, entityId));
    let imported = 0;
    let changed = false;
    const skipped: FieldPath[] = [];
    for (const image of item.images ?? []) {
      const urlHash = hash(image.url);
      const asset = assets.find((row) => {
        const metadata = row.metadata ?? {};
        return (image.externalId != null && metadata.channelImageExternalId === image.externalId)
          || metadata.channelImageUrlHash === urlHash;
      });
      let mediaAssetId = asset?.id;
      if (!mediaAssetId) {
        let response: Response;
        try {
          response = await fetch(image.url);
        } catch (error) {
          warnings.push(`Skipped image "${image.externalId ?? image.url}": ${error instanceof Error ? error.message : "download failed"}.`);
          continue;
        }
        if (!response.ok) {
          warnings.push(`Skipped image "${image.externalId ?? image.url}": download returned ${response.status}.`);
          continue;
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
          warnings.push(`Skipped image "${image.externalId ?? image.url}": ${uploaded.error.code === "STORAGE_NOT_SUPPORTED" ? "storage adapter is not configured" : uploaded.error.message}.`);
          continue;
        }
        mediaAssetId = uploaded.value.id;
        imported += 1;
        changed = true;
        const [createdAsset] = await this.db.select().from(mediaAssets).where(eq(mediaAssets.id, mediaAssetId));
        if (createdAsset) assets.push(createdAsset);
      }
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
            await this.db.update(entityMedia).set({ role: image.role, sortOrder: image.sortOrder ?? 0 }).where(and(
              eq(entityMedia.entityId, entityId),
              eq(entityMedia.mediaAssetId, mediaAssetId),
              target.variantId === undefined ? isNull(entityMedia.variantId) : eq(entityMedia.variantId, target.variantId),
            ));
            changed = true;
          }
          continue;
        }
        const attached = await this.media.attachToEntity({
          entityId,
          mediaAssetId,
          role: image.role,
          sortOrder: image.sortOrder ?? 0,
          ...(target.variantId !== undefined ? { variantId: target.variantId } : {}),
        }, actor);
        if (!attached.ok) return PluginErr(attached.error.message);
        changed = true;
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
    return Ok({ imported, changed, skipped });
  }

  private async getStoreRecord(orgId: string, id: string): Promise<ConnectedStore | undefined> {
    const rows = await this.db
      .select()
      .from(connectedStores)
      .where(and(eq(connectedStores.organizationId, orgId), eq(connectedStores.id, id)));
    return rows[0] as ConnectedStore | undefined;
  }

  async getStoreByDomain(shopDomain: string): Promise<ConnectedStore | undefined> {
    const rows = await this.db
      .select()
      .from(connectedStores)
      .where(eq(connectedStores.storeDomain, shopDomain));
    return rows[0] as ConnectedStore | undefined;
  }

  // A shop_domain can map to more than one connected store (reconnect, or the same
  // shop under two orgs). Compliance webhooks must fan out to all of them.
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

  async connectStore(
    orgId: string,
    input: {
      provider: string;
      credentials: Record<string, unknown>;
      storeDomain: string;
      webhookSecret?: string;
    },
  ): Promise<PluginResult<PublicConnectedStore>> {
    if (!this.connectors.has(input.provider)) {
      return PluginErr(`No connector registered for provider "${input.provider}".`, "NOT_FOUND");
    }
    const existingRows = await this.db
      .select()
      .from(connectedStores)
      .where(and(
        eq(connectedStores.organizationId, orgId),
        eq(connectedStores.provider, input.provider),
        eq(connectedStores.storeDomain, input.storeDomain),
      ));
    const reconnect = existingRows.find((row) => row.status !== "connected");
    const rows = reconnect
      ? await this.db
        .update(connectedStores)
        .set({
          credentials: input.credentials,
          status: "connected",
          catalogWriteEnabled: false,
          webhookSecret: input.webhookSecret ?? crypto.randomUUID(),
          updatedAt: new Date(),
        })
        .where(eq(connectedStores.id, reconnect.id))
        .returning()
      : await this.db
        .insert(connectedStores)
        .values({
          organizationId: orgId,
          provider: input.provider,
          credentials: input.credentials,
          storeDomain: input.storeDomain,
          webhookSecret: input.webhookSecret ?? crypto.randomUUID(),
        })
        .returning();
    const connector = this.connectors.get(input.provider)!;
    const store = rows[0] as ConnectedStore;
    if (connector.registerWebhooks) {
      const registration = await connector.registerWebhooks(store as ChannelStore, [
        "products/update",
        "products/delete",
        "inventory_levels/update",
        "orders/fulfilled",
        "orders/cancelled",
        "refunds/create",
        "app/uninstalled",
      ], `/api/channels/webhooks/${store.id}`);
      if (!registration.ok) {
        await this.db.update(connectedStores).set({ status: "error", updatedAt: new Date() }).where(eq(connectedStores.id, store.id));
        return PluginErr(registration.error.message, "CONNECTOR_REGISTRATION_FAILED");
      }
    }
    const jobs = this.optionsJobs;
    if (jobs) {
      await jobs.enqueue("channel/import-catalog", { orgId, storeId: (rows[0] as ConnectedStore).id }, {
        organizationId: orgId,
        concurrencyKey: (rows[0] as ConnectedStore).id,
        supersedes: true,
      });
    }
    return Ok(redactStore(store));
  }

  private get optionsJobs(): JobsAdapter | undefined {
    return this.jobs;
  }

  async disconnectStore(orgId: string, id: string): Promise<PluginResult<PublicConnectedStore>> {
    return this.disconnectStoreSystem(orgId, id);
  }

  async disconnectStoreSystem(orgId: string, id: string, redactDomain = false): Promise<PluginResult<PublicConnectedStore>> {
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

  async getStore(orgId: string, id: string): Promise<PluginResult<PublicConnectedStore>> {
    const store = await this.getStoreRecord(orgId, id);
    if (!store) return PluginErr("Connected store not found.", "NOT_FOUND");
    return Ok(redactStore(store));
  }

  async listStores(orgId: string): Promise<PluginResult<PublicConnectedStore[]>> {
    const rows = await this.db
      .select()
      .from(connectedStores)
      .where(eq(connectedStores.organizationId, orgId));
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

  async importCatalog(
    orgId: string,
    storeId: string,
    actor: Actor,
  ): Promise<PluginResult<{ imported: number; cursor: string | null; skipped?: CatalogFieldSkip[]; conflicts?: CatalogFieldConflict[]; warnings?: string[] }>> {
    const store = await this.getStoreRecord(orgId, storeId);
    if (!store || store.status !== "connected") {
      return PluginErr("Connected store not found.", "NOT_FOUND");
    }
    const connector = this.connectors.get(store.provider);
    if (!connector) return PluginErr(`No connector registered for provider "${store.provider}".`);

    const items: ChannelCatalogItem[] = [];
    let cursor: string | undefined = store.catalogCursor ?? undefined;
    do {
      const page = await connector.importCatalog(store as ChannelStore, cursor);
      if (!page.ok) return PluginErr(page.error.message);
      items.push(...page.value.items);
      cursor = page.value.nextCursor ?? undefined;
    } while (cursor);

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
      const page = await connector.importCatalog(store as ChannelStore, cursor);
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
      skipped: [],
      conflicts: [],
      warnings: [],
    };
    const assets = await this.db.select().from(mediaAssets).where(eq(mediaAssets.organizationId, orgId));
    for (const item of items) {
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

  private async convergeCatalogItems(
    orgId: string,
    storeId: string,
    items: ChannelCatalogItem[],
    actor: Actor,
    force = false,
    dryRun = false,
  ): Promise<PluginResult<CatalogConvergenceStats>> {
    if (dryRun) return this.estimateCatalogItems(orgId, storeId, items);
    let imported = 0;
    let converged = 0;
    let entitiesTouched = 0;
    let attributesCreated = 0;
    let mediaImported = 0;
    let variantsGivenOptionValues = 0;
    const skipped: CatalogFieldSkip[] = [];
    const conflicts: CatalogFieldConflict[] = [];
    const warnings: string[] = [];
    for (const item of items) {
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
      const entityMapping = existing.find((entry) => entry.kind === "entity");
      let entityId: string;
      let isNew = false;
      let entityTouched = false;
      let existingEntity: typeof sellableEntities.$inferSelect | undefined;
      if (entityMapping) {
        const [entity] = await this.db.select().from(sellableEntities).where(and(
          eq(sellableEntities.organizationId, orgId),
          eq(sellableEntities.id, entityMapping.entityId),
        ));
        if (!entity) {
          warnings.push(`Skipped "${item.externalId}": mapped entity ${entityMapping.entityId} no longer exists.`);
          continue;
        }
        entityId = entityMapping.entityId;
        existingEntity = entity;
      } else {
        const status = item.status;
        const entity = await this.catalog.create({
          type: "product",
          slug: item.slug,
          sourceStoreId: storeId,
          metadata: mergeMetadata(undefined, item.metadata ?? {}),
          ...(status !== undefined ? { status, isVisible: status === "active" } : {}),
        }, actor);
        if (!entity.ok) return PluginErr(entity.error.message);
        entityId = entity.value.id;
        isNew = true;
        imported += 1;
        entityTouched = true;
      }

      const ownershipBeforeSeed = await this.catalog.resolveFieldOwners(entityId, storeId);
      const seedPaths = importedFieldPaths(item).filter((path) => !ownershipBeforeSeed.has(path));
      const seeded = await this.catalog.seedImportedFieldOwnership(entityId, storeId, seedPaths);
      if (!seeded.ok) return PluginErr(seeded.error.message);
      for (const path of seedPaths) ownershipBeforeSeed.set(path, "store");
      const owners = ownershipBeforeSeed;
      const outboundEcho = entityMapping ? this.isOutboundEcho(entityMapping, item) : false;
      const remoteChanged = entityMapping === undefined || entityMapping.syncHash !== remoteHash;
      // An unchanged remote item writes nothing and advances no baseline:
      // converging a stale replay would revert local edits to shared and
      // unowned fields that the store never actually changed.
      if (!force && !remoteChanged && existingEntity && existingEntity.status !== "archived") {
        continue;
      }
      const shared = existingEntity
        ? await this.detectSharedConflicts(
            entityId, storeId, existingEntity, entityMapping, item, owners,
            importedFieldPaths(item), remoteHash,
            outboundEcho ? { certifiedPaths: new Set(entityMapping?.outboundFieldPaths ?? []) } : undefined,
          )
        : { paths: [], conflicts: [] };
      const persistedConflicts = await this.persistCatalogConflicts(orgId, shared.conflicts, actor.userId);
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
        if (ownerAllows(owners, "entity.slug") && !blockedPaths.has("entity.slug") && existingEntity.slug !== writable.slug) {
          updateInput.slug = writable.slug;
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
          converged += 1;
          if (Object.keys(updateInput).length > 0) {
            const updated = await this.catalog.update(entityMapping.entityId, updateInput, actor, CHANNEL_CONVERGENCE_CTX);
            if (!updated.ok) return PluginErr(updated.error.message);
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
      if (!variantIds.ok) return variantIds;
      const taxonomy = await this.applyTaxonomy(orgId, entityId, writable, actor, warnings);
      if (!taxonomy.ok) return taxonomy;
      const media = await this.applyMedia(orgId, entityId, writable, variantIds.value.value, actor, warnings, owners);
      if (!media.ok) return media;
      attributesCreated += attributes.value.created;
      mediaImported += media.value.imported;
      variantsGivenOptionValues += variantIds.value.repaired;
      skipped.push(...media.value.skipped.map((fieldPath) => ({ entityId, fieldPath })));
      entityTouched = entityTouched || optionAxes.value.changed || variantIds.value.changed || media.value.changed || attributes.value.changed;
      if (entityTouched) entitiesTouched += 1;

      if (entityTouched) {
        const revision = await this.catalog.recordEntityRevision(entityId, actor, "import");
        if (!revision.ok) return PluginErr(revision.error.message);
      }

      const revisionMarkers = await this.catalog.repository.findRevisionMarkers(entityId);
      const latestRevisionAt = revisionMarkers.at(-1)?.createdAt;
      const lastSyncedAt = latestRevisionAt ?? entityMapping?.lastSyncedAt ?? new Date();

      if (isNew) {
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
    }
    return Ok({
      imported,
      converged,
      entitiesTouched,
      attributesCreated,
      mediaImported,
      variantsGivenOptionValues,
      skipped,
      conflicts,
      warnings,
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
      const page = await connector.importCatalog(store as ChannelStore, cursor);
      if (!page.ok) return PluginErr(page.error.message);
      items.push(...page.value.items);
      cursor = page.value.nextCursor ?? undefined;
    } while (cursor);

    const converged = await this.convergeCatalogItems(orgId, storeId, items, actor);
    if (!converged.ok) return converged;
    const present = new Set(items.map((item) => item.externalId));
    let archived = 0;
    const skipped = [...converged.value.skipped];
    for (const mapping of entityMappings) {
      if (present.has(mapping.externalId)) continue;
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

    const inventory = await connector.fetchInventory(store as ChannelStore, mappings.map((mapping) => mapping.externalId));
    if (!inventory.ok) return PluginErr(inventory.error.message);
    const existingLevels = await this.db.select().from(inventoryLevels).where(eq(inventoryLevels.organizationId, orgId));
    const inventoryService = this.services.inventory as {
      setAbsolute(input: { entityId: string; variantId?: string; quantity: number; reason?: string }, actor: Actor): Promise<{ ok: boolean; error?: { message: string } }>;
    };
    let inventoryUpdated = 0;
    for (const level of inventory.value) {
      const mapping = mappings.find((entry) => entry.externalId === level.externalId);
      if (!mapping) continue;
      const current = existingLevels.find((entry) => entry.entityId === mapping.entityId && entry.variantId === (mapping.variantId ?? null));
      if (current?.quantityOnHand === level.available) continue;
      const result = await inventoryService.setAbsolute({
        entityId: mapping.entityId,
        ...(mapping.variantId ? { variantId: mapping.variantId } : {}),
        quantity: level.available,
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
      driftAlert: converged.value.imported + converged.value.converged + archived > threshold,
      ...(skipped.length > 0 ? { skipped: uniqueSkipped(skipped) } : {}),
      ...(converged.value.conflicts.length > 0 ? { conflicts: converged.value.conflicts } : {}),
      ...(converged.value.warnings.length > 0 ? { warnings: converged.value.warnings } : {}),
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
      resolvedBy: actor.userId,
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
      changedBy: actor.userId,
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
  ): Promise<PluginResult<{ synced: number }>> {
    const store = await this.getStoreRecord(orgId, storeId);
    if (!store || store.status !== "connected") return PluginErr("Connected store not found.", "NOT_FOUND");
    const connector = this.connectors.get(store.provider);
    if (!connector) return PluginErr(`No connector registered for provider "${store.provider}".`);
    const inventory = await connector.fetchInventory(store as ChannelStore);
    if (!inventory.ok) return PluginErr(inventory.error.message);
    const mappings = await this.db.select().from(channelEntityMap).where(and(
      eq(channelEntityMap.organizationId, orgId),
      eq(channelEntityMap.storeId, storeId),
    ));
    const inventoryService = this.services.inventory as {
      setAbsolute(input: { entityId: string; variantId?: string; quantity: number; reason?: string }, actor: Actor): Promise<{ ok: boolean; error?: { message: string } }>;
    };
    let synced = 0;
    for (const level of inventory.value) {
      const mapping = mappings.find((entry) => entry.externalId === level.externalId);
      if (!mapping) continue;
      const result = await inventoryService.setAbsolute({
        entityId: mapping.entityId,
        ...(mapping.variantId ? { variantId: mapping.variantId } : {}),
        quantity: level.available,
        reason: `Inventory sync from ${store.provider}`,
      }, actor);
      if (!result.ok) return PluginErr(result.error?.message ?? "Inventory sync failed.");
      synced += 1;
    }
    await this.db.update(connectedStores).set({ inventoryCursor: new Date().toISOString(), lastSyncAt: new Date(), updatedAt: new Date() }).where(and(
      eq(connectedStores.organizationId, orgId),
      eq(connectedStores.id, storeId),
    ));
    return Ok({ synced });
  }

  async handleWebhook(orgId: string, storeId: string, event: { id: string; type: string; data: unknown }): Promise<PluginResult<{ processed: true; data?: ChannelComplianceData; redacted?: number }>> {
    const store = await this.getStoreRecord(orgId, storeId);
    if (!store) return PluginErr("Connected store not found.", "NOT_FOUND");
    const actor = createSystemActor(orgId);
    const data = event.data as Record<string, unknown>;
    let skipped: CatalogFieldSkip[] = [];
    let conflicts: CatalogFieldConflict[] = [];
    let warnings: string[] = [];
    if (event.type === "products/update") {
      const productId = String(data.id ?? data.product_id ?? "");
      const mapping = await this.db.select().from(channelEntityMap).where(and(eq(channelEntityMap.organizationId, orgId), eq(channelEntityMap.storeId, storeId), eq(channelEntityMap.kind, "entity"), eq(channelEntityMap.externalId, productId)));
      if (mapping[0]) {
        const converged = await this.convergeCatalogItem(orgId, storeId, mapping[0].entityId, data, actor);
        if (!converged.ok) return converged;
        skipped = converged.value.skipped;
        conflicts = converged.value.conflicts;
        warnings = converged.value.warnings;
      }
    } else if (event.type === "products/delete") {
      const productId = String(data.id ?? data.product_id ?? "");
      const mapping = await this.db.select().from(channelEntityMap).where(and(eq(channelEntityMap.organizationId, orgId), eq(channelEntityMap.storeId, storeId), eq(channelEntityMap.kind, "entity"), eq(channelEntityMap.externalId, productId)));
      if (mapping[0]) {
        const owners = await this.catalog.resolveFieldOwners(mapping[0].entityId, storeId);
        if (owners.get("entity.status") === "platform") {
          skipped.push({ entityId: mapping[0].entityId, fieldPath: "entity.status" });
        } else {
          const archived = await this.catalog.archive(mapping[0].entityId, actor);
          if (!archived.ok) return PluginErr(archived.error.message);
        }
      }
    } else if (event.type === "inventory_levels/update") {
      const externalId = String(data.inventory_item_id ?? data.variation_id ?? data.product_id ?? "");
      const available = Number(data.available ?? data.stock_quantity ?? 0);
      await this.setMappedInventory(orgId, storeId, externalId, available, actor);
    } else if (event.type === "orders/fulfilled" || event.type === "orders/cancelled") {
      const orderId = await this.resolveOrderId(orgId, storeId, data);
      if (orderId) {
        const ordersService = this.services.orders as { addNote(orderId: string, input: { body: string }, actor: Actor): Promise<{ ok: boolean; error?: { message: string } }>; changeStatus(input: { orderId: string; newStatus: "processing" | "fulfilled"; reason: string }, actor: Actor): Promise<{ ok: boolean }> };
        const note = await ordersService.addNote(orderId, { body: `Channel ${event.type}: ${String(data.id ?? data.order_id ?? "remote order")}.` }, actor);
        if (!note.ok) return PluginErr(note.error?.message ?? "Could not add channel order note.");
        if (event.type === "orders/fulfilled") {
          const [order] = await this.db.select({ status: orders.status }).from(orders).where(and(eq(orders.organizationId, orgId), eq(orders.id, orderId)));
          if (order?.status === "confirmed") await ordersService.changeStatus({ orderId, newStatus: "processing", reason: "channel_order_fulfilled" }, actor);
          const [after] = await this.db.select({ status: orders.status }).from(orders).where(and(eq(orders.organizationId, orgId), eq(orders.id, orderId)));
          if (after?.status === "processing") await ordersService.changeStatus({ orderId, newStatus: "fulfilled", reason: "channel_order_fulfilled" }, actor);
        }
      }
    } else if (event.type === "refunds/create") {
      const refund = await this.createRefundRequest(orgId, store, data, actor);
      if (!refund.ok) return refund;
    } else if (event.type === "customers/data_request") {
      const dataRequest = await this.channelCustomerDataRequest(orgId, storeId, data);
      if (!dataRequest.ok) return dataRequest;
      return Ok({ processed: true, data: dataRequest.value });
    } else if (event.type === "customers/redact") {
      const redacted = await this.redactCustomerData(orgId, storeId, data);
      if (!redacted.ok) return redacted;
      return Ok({ processed: true, redacted: redacted.value });
    } else if (event.type === "shop/redact") {
      const redacted = await this.redactShopData(orgId, storeId);
      if (!redacted.ok) return redacted;
      return Ok({ processed: true, redacted: redacted.value });
    } else if (event.type === "app/uninstalled") {
      const disconnected = await this.disconnectStoreSystem(orgId, storeId);
      if (!disconnected.ok) return disconnected;
      return Ok({ processed: true });
    }
    if (skipped.length > 0 || conflicts.length > 0 || warnings.length > 0) {
      const report = {
        ...(store.lastReconcileReport ?? {}),
        ...(skipped.length > 0 ? { skipped: uniqueSkipped(skipped) } : {}),
        ...(conflicts.length > 0 ? { conflicts } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
      await this.db.update(connectedStores).set({ lastReconcileReport: report, updatedAt: new Date() }).where(and(
        eq(connectedStores.organizationId, orgId),
        eq(connectedStores.id, storeId),
      ));
    }
    return Ok({ processed: true });
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

  private async resolveOrderId(orgId: string, storeId: string, data: Record<string, unknown>): Promise<string | undefined> {
    const nestedOrder = data.order && typeof data.order === "object" ? data.order as Record<string, unknown> : undefined;
    const remoteOrderId = String(data.order_id ?? data.orderId ?? nestedOrder?.id ?? "");
    const rows = await this.db.select({ orderId: channelOrderExports.orderId }).from(channelOrderExports).where(and(eq(channelOrderExports.organizationId, orgId), eq(channelOrderExports.storeId, storeId), eq(channelOrderExports.remoteOrderId, remoteOrderId)));
    return rows[0]?.orderId;
  }

  private async setMappedInventory(orgId: string, storeId: string, externalId: string, quantity: number, actor: Actor): Promise<void> {
    const [mapping] = await this.db.select().from(channelEntityMap).where(and(eq(channelEntityMap.organizationId, orgId), eq(channelEntityMap.storeId, storeId), eq(channelEntityMap.externalId, externalId)));
    if (!mapping) return;
    const inventory = this.services.inventory as { setAbsolute(input: { entityId: string; variantId?: string; quantity: number; reason?: string }, actor: Actor): Promise<{ ok: boolean }> };
    await inventory.setAbsolute({ entityId: mapping.entityId, ...(mapping.variantId ? { variantId: mapping.variantId } : {}), quantity: Math.max(0, Math.floor(quantity)), reason: "Inventory webhook sync" }, actor);
  }

  private async convergeCatalogItem(
    orgId: string,
    storeId: string,
    entityId: string,
    data: Record<string, unknown>,
    actor: Actor,
  ): Promise<PluginResult<{ skipped: CatalogFieldSkip[]; conflicts: CatalogFieldConflict[]; warnings: string[] }>> {
    const product = data.product && typeof data.product === "object" ? data.product as Record<string, unknown> : data;
    const remoteMetadata = product.metadata && typeof product.metadata === "object" && !Array.isArray(product.metadata)
      ? product.metadata as Record<string, unknown>
      : {};
    const [mapping] = await this.db.select().from(channelEntityMap).where(and(
      eq(channelEntityMap.organizationId, orgId),
      eq(channelEntityMap.storeId, storeId),
      eq(channelEntityMap.kind, "entity"),
      eq(channelEntityMap.entityId, entityId),
    ));
    const [entity] = await this.db.select().from(sellableEntities).where(and(
      eq(sellableEntities.organizationId, orgId),
      eq(sellableEntities.id, entityId),
    ));
    if (!mapping || !entity) return Ok({ skipped: [], conflicts: [], warnings: [] });
    const [currentAttribute] = await this.db.select().from(sellableAttributes).where(and(
      eq(sellableAttributes.entityId, entityId),
      eq(sellableAttributes.locale, "en"),
    ));
    const title = typeof product.title === "string" ? product.title : currentAttribute?.title ?? entity.slug;
    const description = product.description !== undefined
      ? String(product.description)
      : currentAttribute?.description ?? undefined;
    const status = typeof product.status === "string" && ["draft", "active", "archived", "discontinued"].includes(product.status)
      ? product.status as NonNullable<ChannelCatalogItem["status"]>
      : undefined;
    const customFields = product.customFields && typeof product.customFields === "object" && !Array.isArray(product.customFields)
      ? product.customFields as Record<string, unknown>
      : undefined;
    const images = Array.isArray(product.images)
      ? product.images.flatMap((raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
        const image = raw as Record<string, unknown>;
        const role = typeof image.role === "string" ? pushCatalogImageRole(image.role) : undefined;
        const url = typeof image.url === "string" ? image.url : typeof image.src === "string" ? image.src : undefined;
        return role && url ? [{ role, url }] : [];
      })
      : [];
    const remoteItem = {
      externalId: mapping.externalId,
      slug: typeof product.slug === "string" ? product.slug : entity.slug,
      title,
      ...(description !== undefined ? { description } : {}),
      ...(status !== undefined ? { status } : {}),
      attributes: [{ locale: "en", title, ...(description !== undefined ? { description } : {}) }],
      ...(Object.keys(remoteMetadata).length > 0 ? { metadata: remoteMetadata } : {}),
      ...(customFields !== undefined ? { customFields } : {}),
      ...(images.length > 0 ? { images } : {}),
      variants: [],
    } as ChannelCatalogItem & { customFields?: Record<string, unknown> };
    const fieldPaths: FieldPath[] = [];
    if (typeof product.slug === "string") fieldPaths.push("entity.slug");
    if (status !== undefined) fieldPaths.push("entity.status");
    for (const key of Object.keys(remoteMetadata)) {
      const path = `entity.metadata.${key}`;
      if (isValidFieldPath(path)) fieldPaths.push(path);
    }
    if (typeof product.title === "string") fieldPaths.push("attributes.en.title");
    if (product.description !== undefined) fieldPaths.push("attributes.en.description");
    for (const [name, locales] of Object.entries(customFields ?? {})) {
      if (!locales || typeof locales !== "object" || Array.isArray(locales)) continue;
      for (const locale of Object.keys(locales as Record<string, unknown>)) {
        const path = `customFields.${name}.${locale}`;
        if (isValidFieldPath(path)) fieldPaths.push(path);
      }
    }
    for (const image of images) fieldPaths.push(`media.${image.role}`);
    const ownershipBeforeSeed = await this.catalog.resolveFieldOwners(entityId, storeId);
    const seedPaths = fieldPaths.filter((path) => !ownershipBeforeSeed.has(path));
    const seeded = await this.catalog.seedImportedFieldOwnership(entityId, storeId, seedPaths);
    if (!seeded.ok) return PluginErr(seeded.error.message);
    for (const path of seedPaths) ownershipBeforeSeed.set(path, "store");
    const owners = ownershipBeforeSeed;
    const remoteHash = hash(product);
    const outboundEcho = this.isOutboundEcho(mapping, remoteItem);
    const shared = await this.detectSharedConflicts(
      entityId, storeId, entity, mapping, remoteItem, owners, fieldPaths, remoteHash,
      outboundEcho ? { certifiedPaths: new Set(mapping.outboundFieldPaths ?? []) } : undefined,
    );
    const persistedConflicts = await this.persistCatalogConflicts(orgId, shared.conflicts, actor.userId);
    if (!persistedConflicts.ok) return persistedConflicts;
    const owned = this.filterOwnedFieldsAtPaths(remoteItem, owners, fieldPaths);
    const heldPaths = [...new Set([...(mapping.heldFieldPaths ?? []), ...shared.paths])];
    // Same revocation as the reconcile path: a newly held path cancels any force
    // left from an earlier resolution, so a webhook-raised conflict cannot be
    // pre-empted by an operator's answer to a previous one.
    const survivingForcedPaths = (mapping.forcedPushFieldPaths ?? []).filter(
      (path) => !heldPaths.includes(path),
    );
    const held = this.filterConflictingFields(owned.writable, heldPaths);
    const blockedPaths = new Set<FieldPath>([
      ...owned.skipped,
      ...heldPaths,
      ...(!fieldPaths.includes("attributes.en.title") ? ["attributes.en.title" as FieldPath] : []),
    ]);
    const skipped = owned.skipped.map((fieldPath) => ({ entityId, fieldPath }));
    const conflicts = shared.conflicts.map(({ platformValue: _platformValue, storeValue: _storeValue, ...conflict }) => conflict);
    const warnings = conflicts.map((conflict) => `Held shared field conflict for entity "${conflict.entityId}", store "${conflict.storeId}", field "${conflict.fieldPath}" (local ${conflict.localValueSummary}, remote ${conflict.remoteValueSummary}).`);
    const writable = held.writable;
    const updateInput: {
      slug?: string;
      metadata?: Record<string, unknown>;
      status?: string;
      isVisible?: boolean;
    } = {};
    if (fieldPaths.includes("entity.slug") && ownerAllows(owners, "entity.slug") && !blockedPaths.has("entity.slug") && entity.slug !== writable.slug) {
      updateInput.slug = writable.slug;
    }
    if (Object.keys(writable.metadata ?? {}).length > 0) {
      const remoteEntityMetadata = mergeMetadata(entity.metadata, writable.metadata ?? {});
      if (hash(remoteEntityMetadata) !== hash(entity.metadata ?? {})) updateInput.metadata = remoteEntityMetadata;
    }
    if (fieldPaths.includes("entity.status") && ownerAllows(owners, "entity.status") && !blockedPaths.has("entity.status") && typeof writable.status === "string" && writable.status !== entity.status) {
      updateInput.status = writable.status;
      updateInput.isVisible = writable.status === "active";
    }
    if (Object.keys(updateInput).length > 0) {
      const updated = await this.catalog.update(entityId, updateInput, actor, CHANNEL_CONVERGENCE_CTX);
      if (!updated.ok) return PluginErr(updated.error.message);
    }
    const attributes = await this.setCatalogAttributesIfWritable(entityId, writable, actor, blockedPaths, CHANNEL_CONVERGENCE_CTX);
    if (!attributes.ok) return attributes;
    const levels = Array.isArray(product.variants) ? product.variants as Array<Record<string, unknown>> : [];
    for (const variant of levels) {
      const externalId = String(variant.id ?? variant.variation_id ?? "");
      const available = variant.inventory_quantity ?? variant.stock_quantity;
      if (externalId && available !== undefined) await this.setMappedInventory(orgId, storeId, externalId, Number(available), actor);
    }
    const revisionMarkers = await this.catalog.repository.findRevisionMarkers(entityId);
    const lastSyncedAt = revisionMarkers.at(-1)?.createdAt ?? mapping.lastSyncedAt;
    await this.db.update(channelEntityMap).set({
      syncHash: remoteHash,
      lastSyncedAt,
      heldFieldPaths: heldPaths,
      forcedPushFieldPaths: survivingForcedPaths,
    }).where(eq(channelEntityMap.id, mapping.id));
    return Ok({ skipped, conflicts, warnings });
  }

  private async createRefundRequest(orgId: string, store: ConnectedStore, data: Record<string, unknown>, actor: Actor): Promise<PluginResult<ChannelRefundRequest>> {
    const remoteRefundId = String(data.id ?? data.refund_id ?? "");
    const orderId = await this.resolveOrderId(orgId, store.id, data);
    if (!remoteRefundId || !orderId) return PluginErr("Refund webhook is missing a mapped order or refund id.", "REFUND_MAPPING_MISSING");
    const existing = await this.db.select().from(channelRefundRequests).where(and(eq(channelRefundRequests.storeId, store.id), eq(channelRefundRequests.remoteRefundId, remoteRefundId)));
    if (existing[0]) return Ok(existing[0] as ChannelRefundRequest);
    const lineData = Array.isArray(data.line_items) ? data.line_items : Array.isArray(data.lineItems) ? data.lineItems : [];
    const orderLines = await this.db.select().from(orderLineItems).where(eq(orderLineItems.orderId, orderId));
    const mappings = await this.db.select().from(channelEntityMap).where(and(eq(channelEntityMap.organizationId, orgId), eq(channelEntityMap.storeId, store.id)));
    const refundLines: Array<{ lineItemId: string; quantity: number }> = [];
    let clean = lineData.length > 0;
    for (const raw of lineData) {
      const line = raw as Record<string, unknown>;
      const externalId = String(line.variant_id ?? line.variantId ?? line.product_id ?? "");
      const quantity = Number(line.quantity ?? 0);
      const mapping = mappings.find((item) => item.externalId === externalId);
      const orderLine = mapping ? orderLines.find((item) => item.variantId === mapping.variantId || item.entityId === mapping.entityId) : undefined;
      if (!orderLine || !Number.isInteger(quantity) || quantity < 1 || quantity > orderLine.quantity - orderLine.refundedQuantity) clean = false;
      else refundLines.push({ lineItemId: orderLine.id, quantity });
    }
    const amount = refundLines.reduce((sum, line) => {
      const item = orderLines.find((candidate) => candidate.id === line.lineItemId)!;
      return sum + Math.round((item.totalPrice + item.taxAmount - item.discountAmount) * line.quantity / item.quantity);
    }, 0);
    const [order] = await this.db.select().from(orders).where(and(eq(orders.organizationId, orgId), eq(orders.id, orderId)));
    if (!order) return PluginErr("Order not found.", "NOT_FOUND");
    const max = this.options.refundAutoMax ?? order.amountCaptured ?? order.grandTotal;
    const ageOk = Date.now() - store.createdAt.getTime() >= (this.options.newStoreDays ?? 7) * 86_400_000;
    const auto = clean && amount > 0 && ageOk && amount <= max;
    const rows = await this.db.insert(channelRefundRequests).values({ organizationId: orgId, storeId: store.id, orderId, remoteRefundId, amount, state: auto ? "approved" : "requested", approvedBy: auto ? actor.userId : null }).returning();
    const request = rows[0] as ChannelRefundRequest;
    await this.db.insert(channelRefundEvents).values({ organizationId: orgId, requestId: request.id, fromState: null, toState: request.state, reason: auto ? "Automatic guarded refund" : "Operator approval required", changedBy: actor.userId });
    if (auto) {
      const result = await this.executeRefund(request, refundLines, actor);
      if (!result.ok) return PluginErr(result.error);
    }
    return Ok(request);
  }

  private async executeRefund(request: ChannelRefundRequest, lines: Array<{ lineItemId: string; quantity: number }>, actor: Actor): Promise<PluginResult<ChannelRefundRequest>> {
    const ordersService = this.services.orders as { refundLines(orderId: string, input: { lines: Array<{ lineItemId: string; quantity: number }>; reason?: string }, actor: Actor): Promise<{ ok: boolean; error?: { message: string } }> };
    const result = await ordersService.refundLines(request.orderId, { lines, reason: `Channel refund ${request.remoteRefundId}` }, actor);
    if (!result.ok) return PluginErr(result.error?.message ?? "Refund execution failed.");
    const [updated] = await this.db.update(channelRefundRequests).set({ state: "executed", updatedAt: new Date() }).where(and(eq(channelRefundRequests.organizationId, request.organizationId), eq(channelRefundRequests.id, request.id), eq(channelRefundRequests.state, "approved"))).returning();
    await this.db.insert(channelRefundEvents).values({ organizationId: request.organizationId, requestId: request.id, fromState: "approved", toState: "executed", reason: "Platform refund executed", changedBy: actor.userId });
    return Ok(updated as ChannelRefundRequest);
  }

  async listRefundRequests(orgId: string): Promise<PluginResult<ChannelRefundRequest[]>> {
    return Ok(await this.db.select().from(channelRefundRequests).where(and(eq(channelRefundRequests.organizationId, orgId), eq(channelRefundRequests.state, "requested"))) as ChannelRefundRequest[]);
  }

  async approveRefund(orgId: string, id: string, actor: { userId: string }): Promise<PluginResult<ChannelRefundRequest>> {
    const [request] = await this.db.update(channelRefundRequests).set({ state: "approved", approvedBy: actor.userId, updatedAt: new Date() }).where(and(eq(channelRefundRequests.organizationId, orgId), eq(channelRefundRequests.id, id), eq(channelRefundRequests.state, "requested"))).returning();
    if (!request) return PluginErr("Refund request not found or already handled.", "NOT_FOUND");
    const lines = await this.refundLinesForRequest(request as ChannelRefundRequest);
    return this.executeRefund(request as ChannelRefundRequest, lines, createSystemActor(orgId));
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
        actor.userId,
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
      return this.transitionExport(
        orgId,
        created.value.id,
        "failed",
        actor.userId,
        pushed.error.message,
        pushed.error.retriable === true ? "transient" : "definitive",
      );
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
        actor.userId,
        remoteStatus.error.message,
        remoteStatus.error.retriable === true ? "transient" : "definitive",
      );
    }
    if (remoteStatus.value.status === "confirmed") {
      return this.transitionExport(
        orgId,
        created.value.id,
        "confirmed",
        actor.userId,
        "Remote order confirmed.",
      );
    }
    if (remoteStatus.value.status === "failed" || remoteStatus.value.status === "cancelled") {
      return this.transitionExport(
        orgId,
        created.value.id,
        "failed",
        actor.userId,
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
      lines.push({ externalVariantId: mapping.externalId, ...(line.sku ? { sku: line.sku } : {}), title: line.title, quantity: line.quantity, unitPrice: line.unitPrice, totalPrice: line.totalPrice });
    }

    let email: string | null = null;
    let name = "";
    let shippingAddress: Record<string, unknown> | null = null;
    if (order.customerId) {
      const [customer] = await this.db.select().from(customers).where(and(eq(customers.organizationId, orgId), eq(customers.id, order.customerId)));
      if (customer) {
        email = customer.email;
        name = `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim();
        const addresses = await this.db.select().from(customerAddresses).where(and(eq(customerAddresses.customerId, customer.id), eq(customerAddresses.type, "shipping")));
        const address = addresses.find((item) => item.isDefault) ?? addresses[0];
        if (address) shippingAddress = { first_name: address.firstName, last_name: address.lastName, address1: address.line1, ...(address.line2 ? { address2: address.line2 } : {}), city: address.city, ...(address.state ? { state: address.state } : {}), ...(address.postalCode ? { zip: address.postalCode } : {}), country: address.country, ...(address.phone ? { phone: address.phone } : {}) };
      }
    }
    const metadata = order.metadata ?? {};
    const guest = (metadata.customer ?? metadata.guestCustomer ?? {}) as Record<string, unknown>;
    email ??= typeof guest.email === "string" ? guest.email : null;
    name ||= typeof guest.name === "string" ? guest.name : `${typeof guest.firstName === "string" ? guest.firstName : ""} ${typeof guest.lastName === "string" ? guest.lastName : ""}`.trim();
    const guestShipping = metadata.shippingAddress ?? metadata.guestShippingAddress ?? (typeof metadata.guestCustomer === "object" && metadata.guestCustomer ? (metadata.guestCustomer as Record<string, unknown>).shippingAddress : undefined);
    if (!shippingAddress && guestShipping && typeof guestShipping === "object") shippingAddress = guestShipping as Record<string, unknown>;
    if (!email || !shippingAddress) return PluginErr("Customer email and shipping address are required for channel order export.", "CUSTOMER_DATA_MISSING");
    return Ok({ orderId, currency: order.currency, grandTotal: lines.reduce((sum, line) => sum + line.totalPrice, 0), lines, customer: { name, email, shippingAddress } });
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

  retryExport(
    orgId: string,
    exportId: string,
    changedBy: string,
  ): Promise<PluginResult<ChannelOrderExport>> {
    return this.transitionExport(orgId, exportId, "exported", changedBy, "Manual retry requested.");
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
    if (!connector?.pushCatalog) return Ok({ noop: true });
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
          actor.userId,
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
            actor.userId,
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
              actor.userId,
              connectorError.message,
            );
          } else {
            await this.transitionCatalogPush(
              orgId,
              pushId,
              "failed",
              actor.userId,
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
              actor.userId,
              result.error.message,
            );
          } else {
            await this.transitionCatalogPush(
              orgId,
              pushId,
              "failed",
              actor.userId,
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
            actor.userId,
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
            actor.userId,
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
            actor.userId,
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
