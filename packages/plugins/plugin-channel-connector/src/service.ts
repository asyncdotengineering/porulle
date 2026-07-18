import { createHash } from "node:crypto";
import {
  CommerceInvalidTransitionError,
  CommerceValidationError,
  Ok,
  PluginErr,
  createSystemActor,
} from "@porulle/core";
import type {
  Actor,
  ChannelCatalogItem,
  ChannelConnector,
  ChannelInventoryLevel,
  ChannelOrderSlice,
  ChannelStore,
  PluginDb,
  PluginResult,
  PluginTxFn,
} from "@porulle/core";
import type { JobsAdapter } from "@porulle/core";
import { and, eq, inArray } from "@porulle/core/drizzle";
import { customerAddresses, customers, inventoryLevels, orderLineItems, orders, sellableEntities } from "@porulle/core/schema";
import {
  channelEntityMap,
  channelExportEvents,
  channelOrderExports,
  connectedStores,
  channelRefundEvents,
  channelRefundRequests,
  type ChannelOrderExport,
  type ChannelRefundRequest,
  type ConnectedStore,
} from "./schema.js";

export type ExportState = ChannelOrderExport["state"];

export interface ReconcileReport extends Record<string, unknown> {
  imported: number;
  converged: number;
  archived: number;
  inventoryUpdated: number;
  driftAlert: boolean;
}

export type PublicConnectedStore = Omit<ConnectedStore, "credentials" | "webhookSecret"> & {
  credentials: "[REDACTED]";
  webhookSecret: "[REDACTED]";
};

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

interface CatalogService {
  update(
    id: string,
    input: { slug?: string; status?: string; metadata?: Record<string, unknown>; isVisible?: boolean },
    actor: Actor,
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: { message: string } }>;
  archive(id: string, actor: Actor): Promise<{ ok: true; value: unknown } | { ok: false; error: { message: string } }>;
  create(
    input: {
      type: string;
      slug: string;
      sourceStoreId: string;
      metadata: Record<string, unknown>;
    },
    actor: Actor,
  ): Promise<{ ok: true; value: { id: string } } | { ok: false; error: { message: string } }>;
  createVariant(
    input: { entityId: string; options: Record<string, string>; sku?: string; barcode?: string },
    actor: Actor,
  ): Promise<{ ok: true; value: { id: string } } | { ok: false; error: { message: string } }>;
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

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
    const rows = await this.db
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
  ): Promise<PluginResult<{ imported: number; cursor: string | null }>> {
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
    return Ok({ imported: result.value.imported, cursor: null });
  }

  private async convergeCatalogItems(
    orgId: string,
    storeId: string,
    items: ChannelCatalogItem[],
    actor: Actor,
  ): Promise<PluginResult<{ imported: number; converged: number }>> {
    let imported = 0;
    let converged = 0;
    for (const item of items) {
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
      if (entityMapping) {
        const [entity] = await this.db.select().from(sellableEntities).where(and(
          eq(sellableEntities.organizationId, orgId),
          eq(sellableEntities.id, entityMapping.entityId),
        ));
        if (entityMapping.syncHash !== hash(item) || entity?.status === "archived") {
          const updated = await this.catalog.update(entityMapping.entityId, {
            slug: item.slug,
            metadata: {
              ...(item.metadata ?? {}),
              title: item.title,
              ...(item.description !== undefined ? { description: item.description } : {}),
            },
            ...(entity?.status === "archived" ? { status: "active", isVisible: true } : {}),
          }, actor);
          if (!updated.ok) return PluginErr(updated.error.message);
          await this.db.update(channelEntityMap).set({ syncHash: hash(item), lastSyncedAt: new Date() }).where(eq(channelEntityMap.id, entityMapping.id));
          converged += 1;
        }
        continue;
      }

      const entity = await this.catalog.create(
        {
          type: "product",
          slug: item.slug,
          sourceStoreId: storeId,
          metadata: {
            ...(item.metadata ?? {}),
            title: item.title,
            ...(item.description !== undefined ? { description: item.description } : {}),
          },
        },
        actor,
      );
      if (!entity.ok) return PluginErr(entity.error.message);

      await this.db.insert(channelEntityMap).values({
        organizationId: orgId,
        storeId,
        kind: "entity",
        externalId: item.externalId,
        entityId: entity.value.id,
        syncHash: hash(item),
      });

      for (const sourceVariant of item.variants) {
        const variant = await this.catalog.createVariant(
          {
            entityId: entity.value.id,
            options: {},
            ...(sourceVariant.sku !== undefined ? { sku: sourceVariant.sku } : {}),
            ...(sourceVariant.barcode !== undefined ? { barcode: sourceVariant.barcode } : {}),
          },
          actor,
        );
        if (!variant.ok) return PluginErr(variant.error.message);
        await this.db.insert(channelEntityMap).values({
          organizationId: orgId,
          storeId,
          kind: "variant",
          externalId: sourceVariant.externalId,
          entityId: entity.value.id,
          variantId: variant.value.id,
          syncHash: hash(sourceVariant),
        });
      }
      imported += 1;
    }
    return Ok({ imported, converged });
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
    for (const mapping of entityMappings) {
      if (present.has(mapping.externalId)) continue;
      const [entity] = await this.db.select({ status: sellableEntities.status }).from(sellableEntities).where(and(
        eq(sellableEntities.organizationId, orgId),
        eq(sellableEntities.id, mapping.entityId),
      ));
      if (entity?.status !== "archived") {
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
    const report: ReconcileReport = {
      imported: converged.value.imported,
      converged: converged.value.converged,
      archived,
      inventoryUpdated,
      driftAlert: converged.value.imported + converged.value.converged + archived > threshold,
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
    if (event.type === "products/update") {
      const productId = String(data.id ?? data.product_id ?? "");
      const mapping = await this.db.select().from(channelEntityMap).where(and(eq(channelEntityMap.organizationId, orgId), eq(channelEntityMap.storeId, storeId), eq(channelEntityMap.kind, "entity"), eq(channelEntityMap.externalId, productId)));
      if (mapping[0]) await this.convergeCatalogItem(orgId, storeId, mapping[0].entityId, data, actor);
    } else if (event.type === "products/delete") {
      const productId = String(data.id ?? data.product_id ?? "");
      const mapping = await this.db.select().from(channelEntityMap).where(and(eq(channelEntityMap.organizationId, orgId), eq(channelEntityMap.storeId, storeId), eq(channelEntityMap.kind, "entity"), eq(channelEntityMap.externalId, productId)));
      if (mapping[0]) {
        const archived = await this.catalog.archive(mapping[0].entityId, actor);
        if (!archived.ok) return PluginErr(archived.error.message);
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

  private async convergeCatalogItem(orgId: string, storeId: string, entityId: string, data: Record<string, unknown>, actor: Actor): Promise<void> {
    const product = data.product && typeof data.product === "object" ? data.product as Record<string, unknown> : data;
    const levels = Array.isArray(product.variants) ? product.variants as Array<Record<string, unknown>> : [];
    for (const variant of levels) {
      const externalId = String(variant.id ?? variant.variation_id ?? "");
      const available = variant.inventory_quantity ?? variant.stock_quantity;
      if (externalId && available !== undefined) await this.setMappedInventory(orgId, storeId, externalId, Number(available), actor);
    }
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
}
