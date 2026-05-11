import { router } from "@porulle/core";
import type { PluginRouteRegistration } from "@porulle/core";
import type { PayoutService } from "../services/payout.js";
import { stripUndefined } from "./util.js";

export function buildPayoutRoutes(services: {
  payout: PayoutService;
}): PluginRouteRegistration[] {
  const r = router("Marketplace - Payouts", "/marketplace/payouts");

  // ─── List payouts ──────────────────────────────────────────────────────────
  r.get("/")
    .summary("List payouts")
    .permission("marketplace:admin")
    .handler(async ({ query }) => {
      return services.payout.listPayouts(stripUndefined({
        vendorId: query.vendorId as string | undefined,
        status: query.status as string | undefined,
      }));
    });

  // ─── Run payout cycle ──────────────────────────────────────────────────────
  r.post("/run")
    .summary("Run a payout cycle")
    .permission("marketplace:admin")
    .handler(async () => {
      return services.payout.runPayoutCycle();
    });

  // ─── Retry payout ──────────────────────────────────────────────────────────
  r.post("/{id}/retry")
    .summary("Retry a failed payout")
    .permission("marketplace:admin")
    .handler(async ({ params }) => {
      return services.payout.retryPayout(params.id!);
    });

  // ─── Get payout by id ──────────────────────────────────────────────────────
  r.get("/{id}")
    .summary("Get payout by ID")
    .permission("marketplace:admin")
    .handler(async ({ params }) => {
      const payout = await services.payout.getPayoutById(params.id!);
      if (!payout) throw new Error("Payout not found");
      return payout;
    });

  return r.routes();
}
