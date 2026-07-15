import { eq, and } from "@porulle/core/drizzle";
import { Ok, Err } from "@porulle/core";
import type { PluginDb, PluginResult } from "@porulle/core";
import { layaways, layawayPayments, type LayawayItem } from "./schema.js";

export type Layaway = typeof layaways.$inferSelect;
export type LayawayPayment = typeof layawayPayments.$inferSelect;

export interface LayawayPluginOptions {
  /** Default deposit percentage when neither depositAmount nor depositPercent is given. Default: 20. */
  defaultDepositPercent?: number;
  /**
   * Forfeit policy hook — runs after a layaway is forfeited (deposit
   * retention, customer notification, etc.). Errors are surfaced to the
   * caller.
   */
  onForfeit?: (layaway: Layaway) => Promise<void> | void;
}

interface CoreServices {
  inventory: {
    reserve(input: { entityId: string; variantId?: string; quantity: number; orderId: string; performedBy?: string }, actor?: unknown): Promise<{ ok: boolean; error?: { message?: string } }>;
    release(input: { entityId: string; variantId?: string; quantity: number; orderId: string; performedBy?: string }, actor?: unknown): Promise<{ ok: boolean; error?: { message?: string } }>;
  };
  orders: {
    create(input: Record<string, unknown>, actor: unknown, ctx?: unknown, opts?: { trustedPricing?: boolean; stockPolicy?: "reserve" | "backorder" }): Promise<{ ok: boolean; value?: { id: string }; error?: { message?: string } }>;
  };
}

/**
 * Layaway plans (issue #58): reserve items with a deposit, pay in
 * installments, complete to a core order automatically at full payment.
 */
export class LayawayService {
  constructor(
    private db: PluginDb,
    private services: Record<string, unknown>,
    private options: LayawayPluginOptions = {},
  ) {}

  private get core(): CoreServices {
    return this.services as unknown as CoreServices;
  }

  async create(
    orgId: string,
    input: {
      currency: string;
      items: LayawayItem[];
      customerId?: string | undefined;
      depositAmount?: number | undefined;
      depositPercent?: number | undefined;
      expiresAt?: string | undefined;
      initialPayment?: { amount: number; method: string; reference?: string | undefined } | undefined;
    },
    actor: { userId: string } & Record<string, unknown>,
  ): Promise<PluginResult<{ layaway: Layaway; payments: LayawayPayment[] }>> {
    if (input.items.length === 0) return Err("At least one item is required");
    for (const item of input.items) {
      if (!Number.isInteger(item.quantity) || item.quantity < 1) return Err("Item quantity must be a positive integer");
      if (item.unitPrice < 0) return Err("Item unitPrice must be non-negative");
    }
    const total = input.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
    const depositPercent = input.depositPercent ?? this.options.defaultDepositPercent ?? 20;
    const depositAmount = input.depositAmount ?? Math.round((total * depositPercent) / 100);
    if (depositAmount > total) return Err("Deposit cannot exceed the plan total");

    const rows = await this.db
      .insert(layaways)
      .values({
        organizationId: orgId,
        customerId: input.customerId ?? null,
        currency: input.currency,
        items: input.items,
        total,
        depositAmount,
        createdBy: actor.userId,
        ...(input.expiresAt ? { expiresAt: new Date(input.expiresAt) } : {}),
      })
      .returning();
    let layaway = rows[0] as Layaway;

    // Reserve stock while the plan is active (released on completion/forfeit).
    for (const item of input.items) {
      const reserved = await this.core.inventory.reserve(
        {
          entityId: item.entityId,
          ...(item.variantId ? { variantId: item.variantId } : {}),
          quantity: item.quantity,
          orderId: layaway.id,
          performedBy: actor.userId,
        },
        actor,
      );
      if (!reserved.ok) {
        // Roll back: release what was reserved so far and drop the plan.
        await this.releaseItems(layaway, actor, item);
        await this.db.delete(layaways).where(eq(layaways.id, layaway.id));
        return Err(reserved.error?.message ?? `Could not reserve ${item.title}`);
      }
    }

    const payments: LayawayPayment[] = [];
    if (input.initialPayment) {
      const paid = await this.addPayment(orgId, layaway.id, input.initialPayment, actor);
      if (!paid.ok) return Err(paid.error);
      layaway = paid.value.layaway;
      payments.push(paid.value.payment);
    }

    return Ok({ layaway, payments });
  }

  private async releaseItems(
    layaway: Layaway,
    actor: { userId: string } & Record<string, unknown>,
    upTo?: LayawayItem,
  ): Promise<void> {
    for (const item of layaway.items) {
      if (upTo && item === upTo) break;
      await this.core.inventory.release(
        {
          entityId: item.entityId,
          ...(item.variantId ? { variantId: item.variantId } : {}),
          quantity: item.quantity,
          orderId: layaway.id,
          performedBy: actor.userId,
        },
        actor,
      );
    }
  }

  async getById(orgId: string, id: string): Promise<PluginResult<Layaway & { payments: LayawayPayment[] }>> {
    const rows = await this.db
      .select()
      .from(layaways)
      .where(and(eq(layaways.id, id), eq(layaways.organizationId, orgId)));
    const layaway = rows[0] as Layaway | undefined;
    if (!layaway) return Err("Layaway not found");
    const payments = (await this.db
      .select()
      .from(layawayPayments)
      .where(eq(layawayPayments.layawayId, id))) as LayawayPayment[];
    return Ok({ ...layaway, payments });
  }

  async list(orgId: string, status?: string): Promise<PluginResult<Layaway[]>> {
    const conditions = [eq(layaways.organizationId, orgId)];
    if (status) conditions.push(eq(layaways.status, status as Layaway["status"]));
    const rows = await this.db.select().from(layaways).where(and(...conditions));
    return Ok(rows as Layaway[]);
  }

  /**
   * Records an installment. When cumulative payments reach the plan total,
   * the plan completes automatically: a core order is created (cross-linked)
   * and the inventory hold is released to the normal order flow.
   */
  async addPayment(
    orgId: string,
    layawayId: string,
    input: { amount: number; method: string; reference?: string | undefined },
    actor: { userId: string } & Record<string, unknown>,
  ): Promise<PluginResult<{ layaway: Layaway; payment: LayawayPayment; completed: boolean }>> {
    if (input.amount <= 0) return Err("Payment amount must be positive");
    const found = await this.getById(orgId, layawayId);
    if (!found.ok) return found;
    const layaway = found.value;
    if (layaway.status !== "active") return Err(`Layaway is ${layaway.status}`);
    const remaining = layaway.total - layaway.paidTotal;
    if (input.amount > remaining) {
      return Err(`Payment exceeds the remaining balance (${remaining})`);
    }

    const paymentRows = await this.db
      .insert(layawayPayments)
      .values({
        layawayId,
        amount: input.amount,
        method: input.method,
        reference: input.reference ?? null,
        performedBy: actor.userId,
      })
      .returning();
    const payment = paymentRows[0] as LayawayPayment;

    const paidTotal = layaway.paidTotal + input.amount;
    let completed = false;
    let orderId: string | null = null;

    if (paidTotal >= layaway.total) {
      // Full payment → create the core order and release the hold.
      const order = await this.core.orders.create(
        {
          currency: layaway.currency,
          subtotal: layaway.total,
          taxTotal: 0,
          shippingTotal: 0,
          grandTotal: layaway.total,
          ...(layaway.customerId ? { customerId: layaway.customerId } : {}),
          metadata: { layawayId: layaway.id, source: "layaway" },
          lineItems: layaway.items.map((item) => ({
            entityId: item.entityId,
            entityType: "product",
            ...(item.variantId ? { variantId: item.variantId } : {}),
            ...(item.sku ? { sku: item.sku } : {}),
            title: item.title,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            totalPrice: item.unitPrice * item.quantity,
          })),
        },
        actor,
        undefined,
        // Layaway prices were fixed + stock reserved at plan creation, so the
        // completion order is trusted (no re-derive, no double reservation).
        { trustedPricing: true },
      );
      if (!order.ok || !order.value) {
        return Err(order.error?.message ?? "Layaway completion failed to create the order");
      }
      orderId = order.value.id;
      await this.releaseItems({ ...layaway, items: layaway.items }, actor);
      completed = true;
    }

    const updated = await this.db
      .update(layaways)
      .set({
        paidTotal,
        ...(completed ? { status: "completed" as const, orderId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(layaways.id, layawayId))
      .returning();

    return Ok({ layaway: updated[0] as Layaway, payment, completed });
  }

  /** Forfeits an active plan: releases stock and runs the forfeit policy hook. */
  async forfeit(
    orgId: string,
    layawayId: string,
    reason: string | undefined,
    actor: { userId: string } & Record<string, unknown>,
  ): Promise<PluginResult<Layaway>> {
    const found = await this.getById(orgId, layawayId);
    if (!found.ok) return found;
    const layaway = found.value;
    if (layaway.status !== "active") return Err(`Layaway is ${layaway.status}`);

    await this.releaseItems(layaway, actor);
    const rows = await this.db
      .update(layaways)
      .set({
        status: "forfeited",
        forfeitedAt: new Date(),
        forfeitReason: reason ?? null,
        updatedAt: new Date(),
      })
      .where(eq(layaways.id, layawayId))
      .returning();
    const forfeited = rows[0] as Layaway;

    if (this.options.onForfeit) {
      await this.options.onForfeit(forfeited);
    }
    return Ok(forfeited);
  }
}
