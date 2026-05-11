import { eq, and, desc, sql } from "drizzle-orm";
import type { TxContext } from "../../../kernel/database/tx-context.js";
import type {
  DrizzleDatabase,
  DbOrTx,
} from "../../../kernel/database/drizzle-db.js";
import { orders, orderLineItems, orderStatusHistory } from "../schema.js";

// Infer types from Drizzle schema
export type Order = typeof orders.$inferSelect;
export type OrderInsert = typeof orders.$inferInsert;
export type OrderLineItem = typeof orderLineItems.$inferSelect;
export type OrderLineItemInsert = typeof orderLineItems.$inferInsert;
export type OrderStatusHistory = typeof orderStatusHistory.$inferSelect;
export type OrderStatusHistoryInsert = typeof orderStatusHistory.$inferInsert;

/**
 * OrdersRepository provides type-safe database operations for orders.
 *
 * This repository manages orders, order line items, and order status history.
 * All methods support an optional TxContext parameter for transaction participation.
 */
export class OrdersRepository {
  constructor(private readonly db: DrizzleDatabase) {}

  private getDb(ctx?: TxContext): DbOrTx {
    return (ctx?.tx as DbOrTx | undefined) ?? this.db;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Orders
  // ─────────────────────────────────────────────────────────────────────────────

  async findById(orgId: string, id: string, ctx?: TxContext): Promise<Order | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(orders)
      .where(and(eq(orders.organizationId, orgId), eq(orders.id, id)));
    return rows[0];
  }

  async findByOrderNumber(
    orgId: string,
    orderNumber: string,
    ctx?: TxContext,
  ): Promise<Order | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(orders)
      .where(and(eq(orders.organizationId, orgId), eq(orders.orderNumber, orderNumber)));
    return rows[0];
  }

  async findByCustomerId(
    orgId: string,
    customerId: string,
    ctx?: TxContext,
  ): Promise<Order[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(orders)
      .where(and(eq(orders.organizationId, orgId), eq(orders.customerId, customerId)))
      .orderBy(desc(orders.placedAt));
  }

  async findByStatus(orgId: string, status: string, ctx?: TxContext): Promise<Order[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(orders)
      .where(and(eq(orders.organizationId, orgId), eq(orders.status, status)))
      .orderBy(desc(orders.placedAt));
  }

  async findAll(
    orgId: string,
    options?: { limit?: number; offset?: number },
    ctx?: TxContext,
  ): Promise<Order[]> {
    const db = this.getDb(ctx);
    let query = db
      .select()
      .from(orders)
      .where(eq(orders.organizationId, orgId))
      .orderBy(desc(orders.placedAt))
      .$dynamic();

    if (options?.limit !== undefined) {
      query = query.limit(options.limit);
    }
    if (options?.offset !== undefined) {
      query = query.offset(options.offset);
    }
    return query;
  }

  async create(data: OrderInsert, ctx?: TxContext): Promise<Order> {
    const db = this.getDb(ctx);
    const rows = await db.insert(orders).values(data).returning();
    return rows[0]!;
  }

  async update(
    id: string,
    data: Partial<Omit<OrderInsert, "id">>,
    ctx?: TxContext,
  ): Promise<Order | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .update(orders)
      .set(data)
      .where(eq(orders.id, id))
      .returning();
    return rows[0];
  }

  async updateStatus(
    id: string,
    currentStatus: string,
    newStatus: string,
    ctx?: TxContext,
  ): Promise<Order | undefined> {
    const db = this.getDb(ctx);
    const data: Partial<OrderInsert> = { status: newStatus };
    if (newStatus === "fulfilled") {
      data.fulfilledAt = new Date();
    } else if (newStatus === "cancelled") {
      data.cancelledAt = new Date();
    }
    // Atomic guard: only update if current status matches expected
    const rows = await db
      .update(orders)
      .set(data)
      .where(and(eq(orders.id, id), eq(orders.status, currentStatus)))
      .returning();
    return rows[0];
  }

  async delete(id: string, ctx?: TxContext): Promise<boolean> {
    const db = this.getDb(ctx);
    const result = await db.delete(orders).where(eq(orders.id, id)).returning();
    return result.length > 0;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Order Line Items
  // ─────────────────────────────────────────────────────────────────────────────

  async findAllLineItems(ctx?: TxContext): Promise<OrderLineItem[]> {
    const db = this.getDb(ctx);
    return db.select().from(orderLineItems);
  }

  async findLineItemById(
    id: string,
    ctx?: TxContext,
  ): Promise<OrderLineItem | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(orderLineItems)
      .where(eq(orderLineItems.id, id));
    return rows[0];
  }

  async findLineItemsByOrderId(
    orderId: string,
    ctx?: TxContext,
  ): Promise<OrderLineItem[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(orderLineItems)
      .where(eq(orderLineItems.orderId, orderId));
  }

  async createLineItem(
    data: OrderLineItemInsert,
    ctx?: TxContext,
  ): Promise<OrderLineItem> {
    const db = this.getDb(ctx);
    const rows = await db.insert(orderLineItems).values(data).returning();
    return rows[0]!;
  }

  async createLineItems(
    data: OrderLineItemInsert[],
    ctx?: TxContext,
  ): Promise<OrderLineItem[]> {
    if (data.length === 0) return [];
    const db = this.getDb(ctx);
    return db.insert(orderLineItems).values(data).returning();
  }

  async updateLineItem(
    id: string,
    data: Partial<Omit<OrderLineItemInsert, "id">>,
    ctx?: TxContext,
  ): Promise<OrderLineItem | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .update(orderLineItems)
      .set(data)
      .where(eq(orderLineItems.id, id))
      .returning();
    return rows[0];
  }

  async deleteLineItem(id: string, ctx?: TxContext): Promise<boolean> {
    const db = this.getDb(ctx);
    const result = await db
      .delete(orderLineItems)
      .where(eq(orderLineItems.id, id))
      .returning();
    return result.length > 0;
  }

  async deleteLineItemsByOrderId(
    orderId: string,
    ctx?: TxContext,
  ): Promise<void> {
    const db = this.getDb(ctx);
    await db.delete(orderLineItems).where(eq(orderLineItems.orderId, orderId));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Order Status History
  // ─────────────────────────────────────────────────────────────────────────────

  async findStatusHistoryByOrderId(
    orderId: string,
    ctx?: TxContext,
  ): Promise<OrderStatusHistory[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(orderStatusHistory)
      .where(eq(orderStatusHistory.orderId, orderId))
      .orderBy(desc(orderStatusHistory.changedAt));
  }

  async createStatusHistory(
    data: OrderStatusHistoryInsert,
    ctx?: TxContext,
  ): Promise<OrderStatusHistory> {
    const db = this.getDb(ctx);
    const rows = await db.insert(orderStatusHistory).values(data).returning();
    return rows[0]!;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Order with Line Items (Aggregate)
  // ─────────────────────────────────────────────────────────────────────────────

  async findWithLineItems(
    orgId: string,
    id: string,
    ctx?: TxContext,
  ): Promise<{ order: Order; lineItems: OrderLineItem[] } | undefined> {
    const order = await this.findById(orgId, id, ctx);
    if (!order) return undefined;
    const lineItems = await this.findLineItemsByOrderId(id, ctx);
    return { order, lineItems };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Order Number Generation
  // ─────────────────────────────────────────────────────────────────────────────

  async getNextOrderNumber(ctx?: TxContext): Promise<string> {
    const year = new Date().getFullYear();
    const db = this.getDb(ctx);
    const result = await db.execute(sql`SELECT nextval('order_number_seq') AS seq`);
    const rows = Array.isArray(result)
      ? (result as Record<string, unknown>[])
      : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);
    const raw = rows[0]?.seq;
    if (raw == null) {
      throw new Error("Failed to get next order number — sequence returned null");
    }
    const seqNum = typeof raw === "bigint" ? Number(raw) : Number(raw);
    if (!Number.isFinite(seqNum)) {
      throw new Error("Failed to get next order number — non-numeric sequence");
    }
    return `ORD-${year}-${String(seqNum).padStart(6, "0")}`;
  }
}
