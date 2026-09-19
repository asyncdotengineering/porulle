import { eq, desc, and, sql, exists } from "drizzle-orm";
import type { TxContext } from "../../../kernel/database/tx-context.js";
import type {
  DrizzleDatabase,
  DbOrTx,
} from "../../../kernel/database/drizzle-db.js";
import {
  fulfillmentRecords,
  fulfillmentLineItems,
  fulfillmentEvents,
} from "../schema.js";
import { orders } from "../../orders/schema.js";

// Infer types from Drizzle schema
export type FulfillmentRecord = typeof fulfillmentRecords.$inferSelect;
export type FulfillmentRecordInsert = typeof fulfillmentRecords.$inferInsert;
export type FulfillmentLineItem = typeof fulfillmentLineItems.$inferSelect;
export type FulfillmentLineItemInsert =
  typeof fulfillmentLineItems.$inferInsert;
export type FulfillmentEvent = typeof fulfillmentEvents.$inferSelect;
export type FulfillmentEventInsert = typeof fulfillmentEvents.$inferInsert;

/**
 * FulfillmentRepository provides type-safe database operations for fulfillments.
 *
 * This repository manages fulfillment records, line item associations, and events.
 * Supports physical shipments, digital deliveries, and access grants.
 * All methods support an optional TxContext parameter for transaction participation.
 */
export class FulfillmentRepository {
  constructor(private readonly db: DrizzleDatabase) {}

  private getDb(ctx?: TxContext): DbOrTx {
    return (ctx?.tx as DbOrTx | undefined) ?? this.db;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Fulfillment Records
  // ─────────────────────────────────────────────────────────────────────────────

  async findById(
    orgId: string,
    id: string,
    ctx?: TxContext,
  ): Promise<FulfillmentRecord | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select({ fulfillment: fulfillmentRecords })
      .from(fulfillmentRecords)
      .innerJoin(orders, eq(fulfillmentRecords.orderId, orders.id))
      .where(
        and(
          eq(fulfillmentRecords.id, id),
          eq(orders.organizationId, orgId),
        ),
      );
    return rows[0]?.fulfillment;
  }

  async findByOrderId(
    orgId: string,
    orderId: string,
    ctx?: TxContext,
  ): Promise<FulfillmentRecord[]> {
    const db = this.getDb(ctx);
    const rows = await db
      .select({ fulfillment: fulfillmentRecords })
      .from(fulfillmentRecords)
      .innerJoin(orders, eq(fulfillmentRecords.orderId, orders.id))
      .where(
        and(
          eq(fulfillmentRecords.orderId, orderId),
          eq(orders.organizationId, orgId),
        ),
      )
      .orderBy(desc(fulfillmentRecords.createdAt));
    return rows.map((row) => row.fulfillment);
  }

  // not tenant-scoped; do not use for tenant-facing access
  async findByCustomerId(
    customerId: string,
    ctx?: TxContext,
  ): Promise<FulfillmentRecord[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(fulfillmentRecords)
      .where(eq(fulfillmentRecords.customerId, customerId))
      .orderBy(desc(fulfillmentRecords.createdAt));
  }

  // not tenant-scoped; do not use for tenant-facing access
  async findByStatus(
    status: string,
    ctx?: TxContext,
  ): Promise<FulfillmentRecord[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(fulfillmentRecords)
      .where(eq(fulfillmentRecords.status, status))
      .orderBy(desc(fulfillmentRecords.createdAt));
  }

  // not tenant-scoped; do not use for tenant-facing access
  async findByType(
    type: string,
    ctx?: TxContext,
  ): Promise<FulfillmentRecord[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(fulfillmentRecords)
      .where(eq(fulfillmentRecords.type, type))
      .orderBy(desc(fulfillmentRecords.createdAt));
  }

  // not tenant-scoped; do not use for tenant-facing access
  async findByOrderIdAndStatus(
    orderId: string,
    status: string,
    ctx?: TxContext,
  ): Promise<FulfillmentRecord[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(fulfillmentRecords)
      .where(
        and(
          eq(fulfillmentRecords.orderId, orderId),
          eq(fulfillmentRecords.status, status),
        ),
      )
      .orderBy(desc(fulfillmentRecords.createdAt));
  }

  // not tenant-scoped; do not use for tenant-facing access
  async findActiveAccessGrants(
    customerId: string,
    ctx?: TxContext,
  ): Promise<FulfillmentRecord[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(fulfillmentRecords)
      .where(
        and(
          eq(fulfillmentRecords.customerId, customerId),
          eq(fulfillmentRecords.type, "access_grant"),
          eq(fulfillmentRecords.isActive, true),
        ),
      )
      .orderBy(desc(fulfillmentRecords.grantedAt));
  }

  // not tenant-scoped; do not use for tenant-facing access
  async findAll(
    options?: { limit?: number; offset?: number },
    ctx?: TxContext,
  ): Promise<FulfillmentRecord[]> {
    const db = this.getDb(ctx);
    let query = db
      .select()
      .from(fulfillmentRecords)
      .orderBy(desc(fulfillmentRecords.createdAt))
      .$dynamic();

    if (options?.limit !== undefined) {
      query = query.limit(options.limit);
    }
    if (options?.offset !== undefined) {
      query = query.offset(options.offset);
    }
    return query;
  }

  async create(
    data: FulfillmentRecordInsert,
    ctx?: TxContext,
  ): Promise<FulfillmentRecord> {
    const db = this.getDb(ctx);
    const rows = await db.insert(fulfillmentRecords).values(data).returning();
    return rows[0]!;
  }

  async update(
    orgId: string,
    id: string,
    data: Partial<Omit<FulfillmentRecordInsert, "id">>,
    ctx?: TxContext,
  ): Promise<FulfillmentRecord | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .update(fulfillmentRecords)
      .set({ ...data, updatedAt: new Date() })
      .where(
        and(
          eq(fulfillmentRecords.id, id),
          exists(
            db
              .select({ id: orders.id })
              .from(orders)
              .where(
                and(
                  eq(orders.id, fulfillmentRecords.orderId),
                  eq(orders.organizationId, orgId),
                ),
              ),
          ),
        ),
      )
      .returning();
    return rows[0];
  }

  async updateStatus(
    orgId: string,
    id: string,
    status: string,
    ctx?: TxContext,
  ): Promise<FulfillmentRecord | undefined> {
    const data: Partial<FulfillmentRecordInsert> = { status };

    // Set timestamps based on status
    if (status === "shipped") {
      data.shippedAt = new Date();
    } else if (status === "delivered") {
      data.deliveredAt = new Date();
    }

    return this.update(orgId, id, data, ctx);
  }

  // not tenant-scoped; do not use for tenant-facing access — this is an unscoped WRITE and
  // has no caller today; it needs the same orgId predicate as `update` before it gains one
  async delete(id: string, ctx?: TxContext): Promise<boolean> {
    const db = this.getDb(ctx);
    const result = await db
      .delete(fulfillmentRecords)
      .where(eq(fulfillmentRecords.id, id))
      .returning();
    return result.length > 0;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Digital Delivery Operations
  // ─────────────────────────────────────────────────────────────────────────────

  async incrementDownloadCount(
    orgId: string,
    id: string,
    ctx?: TxContext,
  ): Promise<FulfillmentRecord | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .update(fulfillmentRecords)
      .set({
        downloadCount: sql`${fulfillmentRecords.downloadCount} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(fulfillmentRecords.id, id),
          exists(
            db
              .select({ id: orders.id })
              .from(orders)
              .where(
                and(
                  eq(orders.id, fulfillmentRecords.orderId),
                  eq(orders.organizationId, orgId),
                ),
              ),
          ),
        ),
      )
      .returning();
    return rows[0];
  }

  async isDownloadAllowed(
    orgId: string,
    id: string,
    ctx?: TxContext,
  ): Promise<boolean> {
    const fulfillment = await this.findById(orgId, id, ctx);
    if (!fulfillment || fulfillment.type !== "digital") return false;

    // Check expiration
    if (
      fulfillment.downloadExpiresAt &&
      new Date() > fulfillment.downloadExpiresAt
    ) {
      return false;
    }

    // Check download limit
    if (
      fulfillment.maxDownloads !== null &&
      fulfillment.downloadCount >= fulfillment.maxDownloads
    ) {
      return false;
    }

    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Access Grant Operations
  // ─────────────────────────────────────────────────────────────────────────────

  async deactivateAccessGrant(
    orgId: string,
    id: string,
    ctx?: TxContext,
  ): Promise<FulfillmentRecord | undefined> {
    return this.update(orgId, id, { isActive: false }, ctx);
  }

  async activateAccessGrant(
    orgId: string,
    id: string,
    ctx?: TxContext,
  ): Promise<FulfillmentRecord | undefined> {
    return this.update(orgId, id, { isActive: true, grantedAt: new Date() }, ctx);
  }

  async isAccessGrantActive(
    orgId: string,
    id: string,
    ctx?: TxContext,
  ): Promise<boolean> {
    const fulfillment = await this.findById(orgId, id, ctx);
    if (!fulfillment || fulfillment.type !== "access_grant") return false;

    if (!fulfillment.isActive) return false;

    // Check expiration
    if (fulfillment.expiresAt && new Date() > fulfillment.expiresAt) {
      return false;
    }

    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Fulfillment Line Items
  // ─────────────────────────────────────────────────────────────────────────────

  // not tenant-scoped; do not use for tenant-facing access
  async findLineItemsByFulfillmentId(
    fulfillmentId: string,
    ctx?: TxContext,
  ): Promise<FulfillmentLineItem[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(fulfillmentLineItems)
      .where(eq(fulfillmentLineItems.fulfillmentId, fulfillmentId));
  }

  // not tenant-scoped; do not use for tenant-facing access
  async findLineItemsByOrderLineItemId(
    orderLineItemId: string,
    ctx?: TxContext,
  ): Promise<FulfillmentLineItem[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(fulfillmentLineItems)
      .where(eq(fulfillmentLineItems.orderLineItemId, orderLineItemId));
  }

  // not tenant-scoped; do not use for tenant-facing access
  async createLineItem(
    data: FulfillmentLineItemInsert,
    ctx?: TxContext,
  ): Promise<FulfillmentLineItem> {
    const db = this.getDb(ctx);
    const rows = await db.insert(fulfillmentLineItems).values(data).returning();
    return rows[0]!;
  }

  // not tenant-scoped; do not use for tenant-facing access
  async createLineItems(
    data: FulfillmentLineItemInsert[],
    ctx?: TxContext,
  ): Promise<FulfillmentLineItem[]> {
    if (data.length === 0) return [];
    const db = this.getDb(ctx);
    return db.insert(fulfillmentLineItems).values(data).returning();
  }

  // not tenant-scoped; do not use for tenant-facing access
  async deleteLineItemsByFulfillmentId(
    fulfillmentId: string,
    ctx?: TxContext,
  ): Promise<void> {
    const db = this.getDb(ctx);
    await db
      .delete(fulfillmentLineItems)
      .where(eq(fulfillmentLineItems.fulfillmentId, fulfillmentId));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Fulfillment Events
  // ─────────────────────────────────────────────────────────────────────────────

  // not tenant-scoped; do not use for tenant-facing access
  async findEventsByFulfillmentId(
    fulfillmentId: string,
    ctx?: TxContext,
  ): Promise<FulfillmentEvent[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(fulfillmentEvents)
      .where(eq(fulfillmentEvents.fulfillmentId, fulfillmentId))
      .orderBy(desc(fulfillmentEvents.occurredAt));
  }

  // not tenant-scoped; do not use for tenant-facing access
  async createEvent(
    data: FulfillmentEventInsert,
    ctx?: TxContext,
  ): Promise<FulfillmentEvent> {
    const db = this.getDb(ctx);
    const rows = await db.insert(fulfillmentEvents).values(data).returning();
    return rows[0]!;
  }

  // not tenant-scoped; do not use for tenant-facing access
  async recordStatusChange(
    fulfillmentId: string,
    fromStatus: string,
    toStatus: string,
    actorId?: string,
    description?: string,
    ctx?: TxContext,
  ): Promise<FulfillmentEvent> {
    return this.createEvent(
      {
        fulfillmentId,
        eventType: "status_change",
        fromStatus,
        toStatus,
        actorId,
        description,
      },
      ctx,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Aggregate Operations
  // ─────────────────────────────────────────────────────────────────────────────

  async findWithLineItems(
    orgId: string,
    id: string,
    ctx?: TxContext,
  ): Promise<
    | { fulfillment: FulfillmentRecord; lineItems: FulfillmentLineItem[] }
    | undefined
  > {
    const fulfillment = await this.findById(orgId, id, ctx);
    if (!fulfillment) return undefined;
    const lineItems = await this.findLineItemsByFulfillmentId(id, ctx);
    return { fulfillment, lineItems };
  }

  async findWithEvents(
    orgId: string,
    id: string,
    ctx?: TxContext,
  ): Promise<
    { fulfillment: FulfillmentRecord; events: FulfillmentEvent[] } | undefined
  > {
    const fulfillment = await this.findById(orgId, id, ctx);
    if (!fulfillment) return undefined;
    const events = await this.findEventsByFulfillmentId(id, ctx);
    return { fulfillment, events };
  }

  /**
   * Get fulfilled quantity for an order line item.
   * Sums all fulfillment line items linked to the order line item.
   */
  // not tenant-scoped; do not use for tenant-facing access
  async getFulfilledQuantity(
    orderLineItemId: string,
    ctx?: TxContext,
  ): Promise<number> {
    const db = this.getDb(ctx);
    const result = await db
      .select({
        total: sql<number>`COALESCE(SUM(${fulfillmentLineItems.quantity}), 0)::int`,
      })
      .from(fulfillmentLineItems)
      .where(eq(fulfillmentLineItems.orderLineItemId, orderLineItemId));
    return result[0]?.total ?? 0;
  }
}
