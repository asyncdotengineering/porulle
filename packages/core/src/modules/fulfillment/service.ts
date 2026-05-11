import { createHmac } from "node:crypto";
import { resolveOrgId } from "../../auth/org.js";
import type { Actor } from "../../auth/types.js";
import type { DatabaseAdapter } from "../../kernel/database/adapter.js";
import type { PluginDb } from "../../kernel/database/plugin-types.js";
import type { TxContext } from "../../kernel/database/tx-context.js";
import { CommerceNotFoundError } from "../../kernel/errors.js";
import { runAfterHooks } from "../../kernel/hooks/executor.js";
import { createHookContext } from "../../kernel/hooks/create-context.js";
import type { HookRegistry } from "../../kernel/hooks/registry.js";
import type { AfterHook, HookContext } from "../../kernel/hooks/types.js";
import { Err, Ok, type Result } from "../../kernel/result.js";
import { createLogger } from "../../utils/logger.js";
import type {
  FulfillmentRecord as FulfillmentDbRow,
  FulfillmentRepository,
} from "./repository/index.js";
import type { OrdersRepository } from "../orders/repository/index.js";
import type {
  FulfillmentLineItem,
  FulfillmentRecord,
  FulfillmentStrategy,
  FulfillmentStrategyContext,
} from "./types.js";
import { makeId } from "../../utils/id.js";

interface InventoryServiceLike {
  adjust(input: {
    entityId: string;
    variantId?: string;
    warehouseId?: string;
    adjustment: number;
    reason: string;
    referenceType?: string;
    referenceId?: string;
  }, actor?: unknown): Promise<unknown>;
  release(input: {
    entityId: string;
    variantId?: string;
    quantity: number;
    orderId: string;
    performedBy?: string;
  }): Promise<unknown>;
}

interface FulfillmentServiceDeps {
  repository: FulfillmentRepository;
  ordersRepository: OrdersRepository;
  inventoryService?: InventoryServiceLike;
  hooks: HookRegistry;
  services: Record<string, unknown>;
  database: DatabaseAdapter;
}

function toFulfillmentLineItem(lineItem: FulfillmentLineItem): {
  id: string;
  title: string;
  quantity: number;
  sku?: string;
} {
  return {
    id: lineItem.id,
    title: lineItem.title,
    quantity: lineItem.quantity,
    ...(lineItem.sku != null ? { sku: lineItem.sku } : {}),
  };
}

class PhysicalFulfillmentStrategy implements FulfillmentStrategy {
  type = "physical";

  async canFulfill(
    _lineItem: FulfillmentLineItem,
    _context: FulfillmentStrategyContext,
  ): Promise<Result<boolean>> {
    return Ok(true);
  }

  async fulfill(
    lineItem: FulfillmentLineItem,
    _context: FulfillmentStrategyContext,
  ): Promise<Result<FulfillmentRecord>> {
    return Ok({
      id: makeId(),
      orderId: lineItem.orderId,
      type: this.type,
      status: "pending",
      lineItems: [toFulfillmentLineItem(lineItem)],
    });
  }

  async reverse(
    _fulfillmentId: string,
    _context: FulfillmentStrategyContext,
  ): Promise<Result<void>> {
    return Ok(undefined);
  }
}

class DigitalDownloadFulfillmentStrategy implements FulfillmentStrategy {
  type = "digital-download";

  async canFulfill(
    _lineItem: FulfillmentLineItem,
    _context: FulfillmentStrategyContext,
  ): Promise<Result<boolean>> {
    return Ok(true);
  }

  async fulfill(
    lineItem: FulfillmentLineItem,
    _context: FulfillmentStrategyContext,
  ): Promise<Result<FulfillmentRecord>> {
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();
    return Ok({
      id: makeId(),
      orderId: lineItem.orderId,
      type: this.type,
      status: "fulfilled",
      downloadUrl: `https://downloads.local/${lineItem.id}?token=${createHmac("sha256", "download").update(lineItem.id).digest("hex")}`,
      downloadExpiresAt: expiresAt,
      maxDownloads: 5,
      downloadCount: 0,
      lineItems: [toFulfillmentLineItem(lineItem)],
      entityType: "digitalDownload",
      entityId: lineItem.entityId,
      ...(lineItem.customerId !== undefined
        ? { customerId: lineItem.customerId }
        : {}),
    });
  }

  async reverse(
    _fulfillmentId: string,
    _context: FulfillmentStrategyContext,
  ): Promise<Result<void>> {
    return Ok(undefined);
  }
}

class DigitalAccessFulfillmentStrategy implements FulfillmentStrategy {
  type = "digital-access";

  async canFulfill(
    _lineItem: FulfillmentLineItem,
    _context: FulfillmentStrategyContext,
  ): Promise<Result<boolean>> {
    return Ok(true);
  }

  async fulfill(
    lineItem: FulfillmentLineItem,
    _context: FulfillmentStrategyContext,
  ): Promise<Result<FulfillmentRecord>> {
    return Ok({
      id: makeId(),
      orderId: lineItem.orderId,
      type: this.type,
      status: "fulfilled",
      lineItems: [toFulfillmentLineItem(lineItem)],
      entityType: "course",
      entityId: lineItem.entityId,
      ...(lineItem.customerId !== undefined
        ? { customerId: lineItem.customerId }
        : {}),
      isActive: true,
      grantedAt: new Date().toISOString(),
    });
  }

  async reverse(
    _fulfillmentId: string,
    _context: FulfillmentStrategyContext,
  ): Promise<Result<void>> {
    return Ok(undefined);
  }
}

class InternalTransferFulfillmentStrategy implements FulfillmentStrategy {
  type = "internal-transfer";

  async canFulfill(
    _lineItem: FulfillmentLineItem,
    _context: FulfillmentStrategyContext,
  ): Promise<Result<boolean>> {
    return Ok(true);
  }

  async fulfill(
    lineItem: FulfillmentLineItem,
    _context: FulfillmentStrategyContext,
  ): Promise<Result<FulfillmentRecord>> {
    return Ok({
      id: makeId(),
      orderId: lineItem.orderId,
      type: this.type,
      status: "processing",
      lineItems: [toFulfillmentLineItem(lineItem)],
    });
  }

  async reverse(
    _fulfillmentId: string,
    _context: FulfillmentStrategyContext,
  ): Promise<Result<void>> {
    return Ok(undefined);
  }
}

class AppointmentFulfillmentStrategy implements FulfillmentStrategy {
  type = "appointment";

  async canFulfill(
    _lineItem: FulfillmentLineItem,
    _context: FulfillmentStrategyContext,
  ): Promise<Result<boolean>> {
    return Ok(true);
  }

  async fulfill(
    lineItem: FulfillmentLineItem,
    _context: FulfillmentStrategyContext,
  ): Promise<Result<FulfillmentRecord>> {
    return Ok({
      id: makeId(),
      orderId: lineItem.orderId,
      type: this.type,
      status: "pending",
      lineItems: [toFulfillmentLineItem(lineItem)],
    });
  }

  async reverse(
    _fulfillmentId: string,
    _context: FulfillmentStrategyContext,
  ): Promise<Result<void>> {
    return Ok(undefined);
  }
}

export class FulfillmentService {
  private strategies = new Map<string, FulfillmentStrategy>();

  constructor(private deps: FulfillmentServiceDeps) {
    this.strategies.set("physical", new PhysicalFulfillmentStrategy());
    this.strategies.set(
      "digital-download",
      new DigitalDownloadFulfillmentStrategy(),
    );
    this.strategies.set(
      "digital-access",
      new DigitalAccessFulfillmentStrategy(),
    );
    this.strategies.set(
      "internal-transfer",
      new InternalTransferFulfillmentStrategy(),
    );
    this.strategies.set("appointment", new AppointmentFulfillmentStrategy());
  }

  async fulfillOrder(orderId: string, actor?: Actor | null, ctx?: TxContext): Promise<Result<void>> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const order = await this.deps.ordersRepository.findById(orgId, orderId, ctx);
    if (!order) return Err(new CommerceNotFoundError("Order not found."));

    const lineItems = await this.deps.ordersRepository.findLineItemsByOrderId(
      orderId,
      ctx,
    );

    for (const lineItem of lineItems) {
      const strategyId =
        lineItem.entityType === "digitalDownload"
          ? "digital-download"
          : lineItem.entityType === "course"
            ? "digital-access"
            : lineItem.entityType === "internalAsset"
              ? "internal-transfer"
              : "physical";
      const strategy = this.strategies.get(strategyId)!;
      const result = await strategy.fulfill(
        {
          ...lineItem,
          orderId,
          ...(order.customerId != null ? { customerId: order.customerId } : {}),
        },
        {},
      );
      if (!result.ok) return result;

      const record = result.value;

      // Persist the fulfillment record via repository
      const created = await this.deps.repository.create(
        {
          id: record.id,
          orderId: record.orderId,
          type: record.type,
          status: record.status,
          carrier: record.carrier ?? null,
          trackingNumber: record.trackingNumber ?? null,
          trackingUrl: record.trackingUrl ?? null,
          downloadUrl: record.downloadUrl ?? null,
          downloadExpiresAt: record.downloadExpiresAt
            ? new Date(record.downloadExpiresAt)
            : null,
          maxDownloads: record.maxDownloads ?? null,
          downloadCount: record.downloadCount ?? 0,
          entityType: record.entityType ?? null,
          entityId: record.entityId ?? null,
          grantedAt: record.grantedAt ? new Date(record.grantedAt) : null,
          expiresAt: record.expiresAt ? new Date(record.expiresAt) : null,
          isActive: record.isActive ?? true,
          customerId: record.customerId ?? null,
        },
        ctx,
      );

      const afterHooks = this.deps.hooks.resolve(
        "fulfillment.afterCreate",
      ) as AfterHook<FulfillmentRecord>[];
      const hookCtx: HookContext = createHookContext({
        actor: actor ?? ctx?.actor ?? null,
        tx: ctx?.tx ?? null,
        logger: createLogger("fulfillment"),
        services: this.deps.services,
        context: { moduleName: "fulfillment" },
        database: { db: this.deps.database.db as PluginDb },
      });
      await runAfterHooks(afterHooks, null, record, "create", hookCtx);

      // Create a fulfillment line item linking this fulfillment to the order line item
      for (const li of record.lineItems) {
        await this.deps.repository.createLineItem(
          {
            fulfillmentId: created.id,
            orderLineItemId: li.id,
            quantity: li.quantity,
          },
          ctx,
        );
      }

    }

    return Ok(undefined);
  }

  async getByOrderId(
    orderId: string,
    ctx?: TxContext,
  ): Promise<Result<FulfillmentRecord[]>> {
    const dbRecords = await this.deps.repository.findByOrderId(orderId, ctx);

    // Hydrate each record with its associated line items
    const records: FulfillmentRecord[] = [];
    for (const dbRecord of dbRecords) {
      const fulfillmentLineItems =
        await this.deps.repository.findLineItemsByFulfillmentId(
          dbRecord.id,
          ctx,
        );
      records.push(toServiceRecord(dbRecord, fulfillmentLineItems));
    }

    return Ok(records);
  }

  async updateTracking(
    input: {
      fulfillmentId: string;
      carrier?: string;
      trackingNumber?: string;
      trackingUrl?: string;
      status?: string;
    },
    ctx?: TxContext,
  ): Promise<Result<void>> {
    const existing = await this.deps.repository.findById(
      input.fulfillmentId,
      ctx,
    );
    if (!existing) {
      return Err(new CommerceNotFoundError("Fulfillment record not found."));
    }

    const updateData: Record<string, unknown> = {};
    if (input.carrier !== undefined) updateData.carrier = input.carrier;
    if (input.trackingNumber !== undefined)
      updateData.trackingNumber = input.trackingNumber;
    if (input.trackingUrl !== undefined)
      updateData.trackingUrl = input.trackingUrl;
    if (input.status !== undefined) updateData.status = input.status;
    if (input.status === "shipped") updateData.shippedAt = new Date();
    if (input.status === "delivered") updateData.deliveredAt = new Date();

    await this.deps.repository.update(input.fulfillmentId, updateData, ctx);
    return Ok(undefined);
  }

  async getDownloadUrl(
    orderId: string,
    lineItemId: string,
    userId: string,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<{ url: string; remaining: number; expiresAt: string }>> {
    const dbRecords = await this.deps.repository.findByOrderId(orderId, ctx);

    let matchedRecord: (typeof dbRecords)[number] | undefined;
    for (const dbRecord of dbRecords) {
      if (dbRecord.type !== "digital-download" && dbRecord.type !== "digital")
        continue;
      const fliItems = await this.deps.repository.findLineItemsByFulfillmentId(
        dbRecord.id,
        ctx,
      );
      if (fliItems.some((item) => item.orderLineItemId === lineItemId)) {
        matchedRecord = dbRecord;
        break;
      }
    }

    if (!matchedRecord) {
      return Err(new CommerceNotFoundError("Digital download not found."));
    }

    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const order = await this.deps.ordersRepository.findById(orgId, orderId, ctx);
    if (!order || order.customerId !== userId) {
      return Err(new CommerceNotFoundError("Order not found."));
    }

    if (!matchedRecord.downloadExpiresAt || !matchedRecord.downloadUrl) {
      return Err(new CommerceNotFoundError("Download metadata missing."));
    }

    if (new Date(matchedRecord.downloadExpiresAt).getTime() < Date.now()) {
      return Err(new CommerceNotFoundError("Download link expired."));
    }

    const updated = await this.deps.repository.incrementDownloadCount(
      matchedRecord.id,
      ctx,
    );
    const downloadCount =
      updated?.downloadCount ?? matchedRecord.downloadCount + 1;
    const remaining = Math.max(
      0,
      (matchedRecord.maxDownloads ?? 5) - downloadCount,
    );

    return Ok({
      url: matchedRecord.downloadUrl,
      remaining,
      expiresAt: matchedRecord.downloadExpiresAt.toISOString(),
    });
  }

  async getDigitalAccess(
    userId: string,
    type = "course",
    ctx?: TxContext,
  ): Promise<
    Result<
      Array<{
        entityId: string;
        title: string;
        grantedAt: string;
        expiresAt: string | null;
        isActive: boolean;
        orderId: string;
      }>
    >
  > {
    const output: Array<{
      entityId: string;
      title: string;
      grantedAt: string;
      expiresAt: string | null;
      isActive: boolean;
      orderId: string;
    }> = [];

    // Find all fulfillments for this customer
    const dbRecords = await this.deps.repository.findByCustomerId(userId, ctx);

    for (const entry of dbRecords) {
      if (entry.type !== "digital-access" && entry.type !== "access_grant")
        continue;
      if (entry.entityType !== type) continue;
      if (!entry.entityId || !entry.grantedAt) continue;

      // Get the first fulfillment line item to extract the title
      const fliItems = await this.deps.repository.findLineItemsByFulfillmentId(
        entry.id,
        ctx,
      );
      let title = "Untitled";
      if (fliItems.length > 0) {
        const orderLineItem = await this.deps.ordersRepository.findLineItemById(
          fliItems[0]!.orderLineItemId,
          ctx,
        );
        if (orderLineItem) {
          title = orderLineItem.title;
        }
      }

      output.push({
        entityId: entry.entityId,
        title,
        grantedAt: entry.grantedAt.toISOString(),
        expiresAt: entry.expiresAt?.toISOString() ?? null,
        isActive: entry.isActive,
        orderId: entry.orderId,
      });
    }

    return Ok(output);
  }
}

/**
 * Maps a Drizzle FulfillmentRecord + its fulfillment line items back to
 * the service-layer FulfillmentRecord shape used by callers.
 */
function toServiceRecord(
  dbRecord: FulfillmentDbRow,
  fulfillmentLineItems: Awaited<
    ReturnType<FulfillmentRepository["findLineItemsByFulfillmentId"]>
  >,
): FulfillmentRecord {
  return {
    id: dbRecord.id,
    orderId: dbRecord.orderId,
    type: dbRecord.type,
    status: dbRecord.status,
    lineItems: fulfillmentLineItems.map((fli) => ({
      id: fli.orderLineItemId,
      title: "", // Title is on the order line item; callers should join if needed
      quantity: fli.quantity,
    })),
    ...(dbRecord.carrier != null ? { carrier: dbRecord.carrier } : {}),
    ...(dbRecord.trackingNumber != null
      ? { trackingNumber: dbRecord.trackingNumber }
      : {}),
    ...(dbRecord.trackingUrl != null
      ? { trackingUrl: dbRecord.trackingUrl }
      : {}),
    ...(dbRecord.estimatedDelivery != null
      ? { estimatedDelivery: dbRecord.estimatedDelivery.toISOString() }
      : {}),
    ...(dbRecord.shippedAt != null
      ? { shippedAt: dbRecord.shippedAt.toISOString() }
      : {}),
    ...(dbRecord.deliveredAt != null
      ? { deliveredAt: dbRecord.deliveredAt.toISOString() }
      : {}),
    ...(dbRecord.downloadUrl != null
      ? { downloadUrl: dbRecord.downloadUrl }
      : {}),
    ...(dbRecord.downloadExpiresAt != null
      ? { downloadExpiresAt: dbRecord.downloadExpiresAt.toISOString() }
      : {}),
    ...(dbRecord.maxDownloads != null
      ? { maxDownloads: dbRecord.maxDownloads }
      : {}),
    downloadCount: dbRecord.downloadCount,
    ...(dbRecord.customerId != null ? { customerId: dbRecord.customerId } : {}),
    ...(dbRecord.entityType != null ? { entityType: dbRecord.entityType } : {}),
    ...(dbRecord.entityId != null ? { entityId: dbRecord.entityId } : {}),
    ...(dbRecord.grantedAt != null
      ? { grantedAt: dbRecord.grantedAt.toISOString() }
      : {}),
    ...(dbRecord.expiresAt != null
      ? { expiresAt: dbRecord.expiresAt.toISOString() }
      : {}),
    isActive: dbRecord.isActive,
  };
}
