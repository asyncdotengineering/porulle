import { defineCommercePlugin } from "@porulle/core";
import { MARKETPLACE_ANALYTICS_MODELS } from "./analytics-models.js";
import {
  vendors, vendorEntities, vendorSubOrders, vendorPayouts,
  vendorDocuments, commissionRules, vendorBalances,
  disputes, vendorReviews, returnRequests,
  rfqs, rfqResponses, contractPrices,
} from "./schema.js";
import { VendorService } from "./services/vendor.js";
import { SubOrderService } from "./services/sub-order.js";
import { CommissionService } from "./services/commission.js";
import { PayoutService } from "./services/payout.js";
import { DisputeService } from "./services/dispute.js";
import { ReturnService } from "./services/return.js";
import { ReviewService } from "./services/review.js";
import { RFQService } from "./services/rfq.js";
import { ContractPriceService } from "./services/contract-price.js";
import { buildHooks } from "./hooks.js";
import { buildVendorRoutes } from "./routes/vendors.js";
import { buildVendorPortalRoutes } from "./routes/vendor-portal.js";
import { buildSubOrderRoutes } from "./routes/sub-orders.js";
import { buildCommissionRoutes } from "./routes/commission.js";
import { buildPayoutRoutes } from "./routes/payouts.js";
import { buildDisputesReturnsReviewsRoutes } from "./routes/disputes-returns-reviews.js";
import { buildB2BRoutes } from "./routes/b2b.js";
import type { MarketplacePluginOptions, Db } from "./types.js";

export type { MarketplacePluginOptions } from "./types.js";

function createServices(db: Db, options: MarketplacePluginOptions, kernelServices?: Record<string, unknown>) {
  const vendor = new VendorService(db);
  const commission = new CommissionService(db, options);
  const payout = new PayoutService(db, options);
  const dispute = new DisputeService(db, options);
  const returnSvc = new ReturnService(db);
  const review = new ReviewService(db, options);
  const rfq = options.b2b?.rfq ? new RFQService(db) : undefined;
  const contractPrice = options.b2b?.contractPricing ? new ContractPriceService(db) : undefined;

  // Cancel callback: release inventory on parent order + reverse balance
  const subOrder = new SubOrderService(db, async (sub) => {
    // Release inventory for cancelled vendor's line items
    const inventory = kernelServices?.inventory as
      { release(input: Record<string, unknown>): Promise<unknown> } | undefined;
    if (inventory?.release && sub.lineItems) {
      for (const item of sub.lineItems as Array<{ entityId: string; quantity: number }>) {
        await inventory.release({
          entityId: item.entityId,
          quantity: item.quantity,
          orderId: sub.orderId,
          performedBy: "marketplace",
        });
      }
    }

    // Reverse balance: debit the sale credit
    if (sub.payoutAmount > 0) {
      await payout.addLedgerEntry({
        vendorId: sub.vendorId,
        type: "refund_deduction",
        amountCents: -sub.payoutAmount,
        referenceType: "sub_order",
        referenceId: sub.id,
        description: `Cancelled sub-order ${sub.id.slice(0, 8)}`,
      });
    }
  });

  return { vendor, subOrder, commission, payout, dispute, return: returnSvc, review, rfq, contractPrice };
}

export function marketplacePlugin(options: MarketplacePluginOptions = {}) {
  return defineCommercePlugin({
    id: "marketplace",
    version: "2.0.0",

    schema: () => ({
      vendors,
      vendorEntities,
      vendorSubOrders,
      vendorPayouts,
      vendorDocuments,
      commissionRules,
      vendorBalances,
      disputes,
      vendorReviews,
      returnRequests,
      rfqs,
      rfqResponses,
      contractPrices,
    }),

    hooks: () => buildHooks(options),

    routes: (ctx) => {
      const db = ctx.database.db;
      const services = db ? createServices(db, options, ctx.services) : null;

      if (!services) return [];

      return [
        ...buildVendorRoutes(services, options),
        ...buildVendorPortalRoutes(services),
        ...buildSubOrderRoutes(services),
        ...buildCommissionRoutes(services),
        ...buildPayoutRoutes(services),
        ...buildDisputesReturnsReviewsRoutes(services),
        ...(options.b2b?.rfq || options.b2b?.contractPricing
          ? buildB2BRoutes(services, options)
          : []),
      ];
    },

    analyticsModels: () => MARKETPLACE_ANALYTICS_MODELS,
  });
}
