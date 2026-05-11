import { eq, and, lt } from "drizzle-orm";
import type { TxContext } from "../../../kernel/database/tx-context.js";
import type {
  DrizzleDatabase,
  DbOrTx,
} from "../../../kernel/database/drizzle-db.js";
import { carts, cartLineItems } from "../schema.js";

// Infer types from Drizzle schema
export type Cart = typeof carts.$inferSelect;
export type CartInsert = typeof carts.$inferInsert;
export type CartLineItem = typeof cartLineItems.$inferSelect;
export type CartLineItemInsert = typeof cartLineItems.$inferInsert;

/**
 * CartRepository provides type-safe database operations for shopping carts.
 *
 * This repository manages carts and cart line items.
 * All methods support an optional TxContext parameter for transaction participation.
 */
export class CartRepository {
  constructor(private readonly db: DrizzleDatabase) {}

  private getDb(ctx?: TxContext): DbOrTx {
    return (ctx?.tx as DbOrTx | undefined) ?? this.db;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Carts
  // ─────────────────────────────────────────────────────────────────────────────

  async findById(orgId: string, id: string, ctx?: TxContext): Promise<Cart | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(carts)
      .where(and(eq(carts.organizationId, orgId), eq(carts.id, id)));
    return rows[0];
  }

  async findByCustomerId(
    orgId: string,
    customerId: string,
    ctx?: TxContext,
  ): Promise<Cart | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(carts)
      .where(and(eq(carts.organizationId, orgId), eq(carts.customerId, customerId), eq(carts.status, "active")));
    return rows[0];
  }

  async findActiveByCustomerId(
    orgId: string,
    customerId: string,
    ctx?: TxContext,
  ): Promise<Cart | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(carts)
      .where(and(eq(carts.organizationId, orgId), eq(carts.customerId, customerId), eq(carts.status, "active")));
    return rows[0];
  }

  async findExpiredCarts(ctx?: TxContext): Promise<Cart[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(carts)
      .where(and(eq(carts.status, "active"), lt(carts.expiresAt, new Date())));
  }

  async create(data: CartInsert, ctx?: TxContext): Promise<Cart> {
    const db = this.getDb(ctx);
    const rows = await db.insert(carts).values(data).returning();
    return rows[0]!;
  }

  async update(
    id: string,
    data: Partial<Omit<CartInsert, "id">>,
    ctx?: TxContext,
  ): Promise<Cart | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .update(carts)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(carts.id, id))
      .returning();
    return rows[0];
  }

  async updateStatus(
    id: string,
    status: Cart["status"],
    ctx?: TxContext,
  ): Promise<Cart | undefined> {
    return this.update(id, { status }, ctx);
  }

  /**
   * Atomically transitions a cart from "active" to "checking_out".
   * Returns the updated cart if the transition succeeded, or undefined if
   * the cart was not in "active" status (e.g., a concurrent checkout already
   * claimed it). This prevents TOCTOU race conditions on double-checkout.
   */
  async transitionToCheckingOut(
    id: string,
    ctx?: TxContext,
  ): Promise<Cart | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .update(carts)
      .set({ status: "checking_out", updatedAt: new Date() })
      .where(and(eq(carts.id, id), eq(carts.status, "active")))
      .returning();
    return rows[0];
  }

  async delete(id: string, ctx?: TxContext): Promise<boolean> {
    const db = this.getDb(ctx);
    const result = await db.delete(carts).where(eq(carts.id, id)).returning();
    return result.length > 0;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Cart Line Items
  // ─────────────────────────────────────────────────────────────────────────────

  async findLineItemById(
    id: string,
    ctx?: TxContext,
  ): Promise<CartLineItem | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(cartLineItems)
      .where(eq(cartLineItems.id, id));
    return rows[0];
  }

  async findLineItemsByCartId(
    cartId: string,
    ctx?: TxContext,
  ): Promise<CartLineItem[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(cartLineItems)
      .where(eq(cartLineItems.cartId, cartId));
  }

  async findLineItemByEntity(
    cartId: string,
    entityId: string,
    variantId?: string,
    ctx?: TxContext,
  ): Promise<CartLineItem | undefined> {
    const db = this.getDb(ctx);
    const conditions = [
      eq(cartLineItems.cartId, cartId),
      eq(cartLineItems.entityId, entityId),
    ];

    if (variantId !== undefined) {
      conditions.push(eq(cartLineItems.variantId, variantId));
    }

    const rows = await db
      .select()
      .from(cartLineItems)
      .where(and(...conditions));

    // Filter for exact variantId match
    return rows.find((r) => r.variantId === (variantId ?? null));
  }

  async createLineItem(
    data: CartLineItemInsert,
    ctx?: TxContext,
  ): Promise<CartLineItem> {
    const db = this.getDb(ctx);
    const rows = await db.insert(cartLineItems).values(data).returning();
    return rows[0]!;
  }

  async updateLineItem(
    id: string,
    data: Partial<Omit<CartLineItemInsert, "id">>,
    ctx?: TxContext,
  ): Promise<CartLineItem | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .update(cartLineItems)
      .set(data)
      .where(eq(cartLineItems.id, id))
      .returning();
    return rows[0];
  }

  async deleteLineItem(id: string, ctx?: TxContext): Promise<boolean> {
    const db = this.getDb(ctx);
    const result = await db
      .delete(cartLineItems)
      .where(eq(cartLineItems.id, id))
      .returning();
    return result.length > 0;
  }

  async deleteLineItemsByCartId(
    cartId: string,
    ctx?: TxContext,
  ): Promise<void> {
    const db = this.getDb(ctx);
    await db.delete(cartLineItems).where(eq(cartLineItems.cartId, cartId));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Cart with Line Items (Aggregate)
  // ─────────────────────────────────────────────────────────────────────────────

  async findWithLineItems(
    orgId: string,
    id: string,
    ctx?: TxContext,
  ): Promise<{ cart: Cart; lineItems: CartLineItem[] } | undefined> {
    const cart = await this.findById(orgId, id, ctx);
    if (!cart) return undefined;
    const lineItems = await this.findLineItemsByCartId(id, ctx);
    return { cart, lineItems };
  }
}
