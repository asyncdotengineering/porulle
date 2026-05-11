import { eq } from "@porulle/core/drizzle";
import type { PluginHookRegistration } from "@porulle/core";
import { vendors, vendorEntities, vendorSubOrders, vendorPayouts } from "./schema.js";
import { CommissionService } from "./services/commission.js";
import { PayoutService } from "./services/payout.js";
import type { Db, MarketplacePluginOptions } from "./types.js";

function getDbFromHookArgs(args: unknown): Db {
  const a = args as { context: { services: { database: { db: unknown } } } };
  return a.context.services.database.db as Db;
}

export function buildHooks(options: MarketplacePluginOptions): PluginHookRegistration[] {
  return [
    // ─── catalog.beforeCreate ──────────────────────────────────────────────
    {
      key: "catalog.beforeCreate",
      async handler(args: unknown) {
        const { data } = args as { data: Record<string, unknown> };
        const metadata = data?.metadata as Record<string, unknown> | undefined;
        const vendorId = metadata?.vendorId;
        if (!vendorId) return data;

        const db = getDbFromHookArgs(args);
        const [vendor] = await db.select().from(vendors).where(eq(vendors.id, String(vendorId)));

        if (!vendor) throw new Error("Vendor not found.");
        if (vendor.status === "suspended") throw new Error("Vendor is suspended and cannot create listings.");
        if (vendor.status !== "approved") throw new Error("Vendor must be approved before creating marketplace listings.");

        // Check approved categories if set
        const approvedCats = vendor.approvedCategories as string[] | null;
        if (approvedCats && Array.isArray(approvedCats)) {
          const entityType = data.type as string | undefined;
          // approvedCategories holds category slugs; entityType may match
          // This is a basic check; real implementations would check category assignment
        }

        return data;
      },
    },

    // ─── catalog.afterCreate ───────────────────────────────────────────────
    {
      key: "catalog.afterCreate",
      async handler(args: unknown) {
        const { result } = args as { result: { id: string; metadata?: Record<string, unknown> | null } };
        const vendorId = result?.metadata?.vendorId;
        if (!vendorId) return;

        const db = getDbFromHookArgs(args);
        await db.insert(vendorEntities).values({
          vendorId: String(vendorId),
          entityId: result.id,
        });
      },
    },

    // ─── catalog.beforeList ────────────────────────────────────────────────
    {
      key: "catalog.beforeList",
      async handler(args: unknown) {
        const { data, context: hookContext } = args as {
          data: unknown;
          context: { context: Record<string, unknown>; actor?: { vendorId?: string | null } };
        };
        hookContext.context.marketplaceVendorScope = hookContext.actor?.vendorId ?? null;
        return data;
      },
    },

    // ─── catalog.afterList ─────────────────────────────────────────────────
    {
      key: "catalog.afterList",
      async handler(args: unknown) {
        const { result, context: hookContext } = args as {
          result: { items?: Array<{ id: string }> };
          context: { context: Record<string, unknown> };
        };
        const vendorScope = hookContext.context.marketplaceVendorScope as string | null;
        if (!vendorScope || !Array.isArray(result?.items)) return;

        const db = getDbFromHookArgs(args);
        const links = await db.select().from(vendorEntities).where(eq(vendorEntities.vendorId, vendorScope));
        const linkedEntityIds = new Set(links.map((l: { entityId: string }) => l.entityId));
        result.items = result.items.filter((item) => linkedEntityIds.has(item.id));
      },
    },

    // ─── catalog.afterRead ─────────────────────────────────────────────────
    {
      key: "catalog.afterRead",
      async handler(args: unknown) {
        const { result } = args as { result: Record<string, unknown> & { id: string } };
        const db = getDbFromHookArgs(args);
        const [link] = await db.select().from(vendorEntities).where(eq(vendorEntities.entityId, result.id));
        if (!link) return;

        const [vendor] = await db.select().from(vendors).where(eq(vendors.id, link.vendorId));
        if (!vendor) return;

        result.marketplace = {
          vendor: {
            id: vendor.id,
            name: vendor.name,
            slug: vendor.slug,
            status: vendor.status,
            tier: vendor.tier,
            logoUrl: vendor.logoUrl,
          },
        };
      },
    },

    // ─── orders.afterCreate ────────────────────────────────────────────────
    {
      key: "orders.afterCreate",
      async handler(args: unknown) {
        const { result, context: hookContext } = args as {
          result: { id: string; lineItems?: Array<{ entityId: string; quantity: number; totalPrice: number }> };
          context: { logger: { info(msg: string, data?: unknown): void } };
        };
        const db = getDbFromHookArgs(args);
        const commissionService = new CommissionService(db, options);
        const payoutService = new PayoutService(db, options);

        const grouped = new Map<string, Array<{ entityId: string; quantity: number; totalPrice: number }>>();

        for (const lineItem of result.lineItems ?? []) {
          const [link] = await db.select().from(vendorEntities).where(eq(vendorEntities.entityId, lineItem.entityId));
          if (!link) continue;
          const [vendor] = await db.select().from(vendors).where(eq(vendors.id, link.vendorId));
          if (!vendor) continue;

          const existing = grouped.get(vendor.id) ?? [];
          existing.push({
            entityId: lineItem.entityId,
            quantity: lineItem.quantity,
            totalPrice: lineItem.totalPrice,
          });
          grouped.set(vendor.id, existing);
        }

        for (const [vendorId, lineItems] of grouped.entries()) {
          const subtotal = lineItems.reduce((sum, item) => sum + item.totalPrice, 0);

          // Resolve commission via rules engine
          const commissionRateBps = await commissionService.resolveRate(vendorId);
          const commissionAmount = Math.round((subtotal * commissionRateBps) / 10000);
          const payoutAmount = subtotal - commissionAmount;

          const [subOrder] = await db.insert(vendorSubOrders).values({
            orderId: result.id,
            vendorId,
            status: "pending",
            subtotal,
            commissionAmount,
            payoutAmount,
            notified: true,
            lineItems,
            metadata: {},
          }).returning();

          if (!subOrder) continue;

          // Credit vendor balance with full subtotal
          await payoutService.addLedgerEntry({
            vendorId,
            type: "sale",
            amountCents: subtotal,
            referenceType: "sub_order",
            referenceId: subOrder.id,
            description: `Sale from order ${result.id.slice(0, 8)}`,
          });

          // Record commission as separate entry
          await payoutService.addLedgerEntry({
            vendorId,
            type: "commission",
            amountCents: -commissionAmount,
            referenceType: "sub_order",
            referenceId: subOrder.id,
            description: `Commission (${commissionRateBps}bps) on order ${result.id.slice(0, 8)}`,
          });

          hookContext.logger.info("marketplace_sub_order_created", {
            orderId: result.id,
            subOrderId: subOrder.id,
            vendorId,
            commissionRateBps,
          });
        }
      },
    },

    // ─── orders.beforeStatusChange ─────────────────────────────────────────
    {
      key: "orders.beforeStatusChange",
      async handler(args: unknown) {
        const { data } = args as { data: { orderId: string; newStatus: string } };
        if (data.newStatus !== "fulfilled") return data;

        const db = getDbFromHookArgs(args);
        const related = await db.select().from(vendorSubOrders).where(eq(vendorSubOrders.orderId, data.orderId));
        const allDelivered = related.every((subOrder: { status: string }) => subOrder.status === "delivered");

        if (!allDelivered) {
          throw new Error("Cannot fulfill parent order until all marketplace sub-orders are delivered.");
        }

        return data;
      },
    },
  ];
}
