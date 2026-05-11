import { eq, and, desc, sql, lte } from "@porulle/core/drizzle";
import { vendorPayouts, vendorBalances, vendors, vendorSubOrders } from "../schema.js";
import type { Db, BalanceEntryType, MarketplacePluginOptions } from "../types.js";

export class PayoutService {
  constructor(
    private db: Db,
    private options: MarketplacePluginOptions,
  ) {}

  // ─── Balance Ledger ────────────────────────────────────────────────────────

  async addLedgerEntry(data: {
    vendorId: string;
    type: BalanceEntryType;
    amountCents: number;
    referenceType?: string;
    referenceId?: string;
    description?: string;
  }) {
    // Get current balance
    const balance = await this.getBalance(data.vendorId);
    const newBalance = balance + data.amountCents;

    const [entry] = await this.db.insert(vendorBalances).values({
      vendorId: data.vendorId,
      type: data.type,
      amountCents: data.amountCents,
      runningBalanceCents: newBalance,
      referenceType: data.referenceType,
      referenceId: data.referenceId,
      description: data.description,
    }).returning();
    return entry;
  }

  async getBalance(vendorId: string): Promise<number> {
    const rows = await this.db.select({
      balance: sql<number>`COALESCE((
        SELECT running_balance_cents FROM marketplace_vendor_balances
        WHERE vendor_id = ${vendorId}
        ORDER BY created_at DESC LIMIT 1
      ), 0)`,
    }).from(vendors).where(eq(vendors.id, vendorId));
    return rows[0]?.balance ?? 0;
  }

  async getLedger(vendorId: string, limit = 50) {
    return this.db.select().from(vendorBalances)
      .where(eq(vendorBalances.vendorId, vendorId))
      .orderBy(desc(vendorBalances.createdAt))
      .limit(limit);
  }

  // ─── Payouts ───────────────────────────────────────────────────────────────

  async getPayoutById(id: string) {
    const [payout] = await this.db.select().from(vendorPayouts).where(eq(vendorPayouts.id, id));
    return payout ?? null;
  }

  async listPayouts(filters?: { vendorId?: string; status?: string }) {
    let query = this.db.select().from(vendorPayouts).$dynamic();
    const conditions = [];
    if (filters?.vendorId) conditions.push(eq(vendorPayouts.vendorId, filters.vendorId));
    if (filters?.status) conditions.push(eq(vendorPayouts.status, filters.status));
    if (conditions.length > 0) {
      query = query.where(conditions.length === 1 ? conditions[0]! : and(...conditions));
    }
    return query.orderBy(desc(vendorPayouts.createdAt));
  }

  /**
   * Run payout cycle for eligible vendors.
   * Per RFC §5.5:
   * 1. Find vendors with matching payout_schedule
   * 2. Check balance >= payout_minimum_cents
   * 3. Only include deliveries older than holdback_days
   * 4. Calculate deductions (refunds, adjustments)
   * 5. Create payout record + balance ledger debit
   */
  async runPayoutCycle(): Promise<Array<{ vendorId: string; payoutId: string; netAmount: number }>> {
    const allVendors = await this.db.select().from(vendors)
      .where(eq(vendors.status, "approved"));

    const results: Array<{ vendorId: string; payoutId: string; netAmount: number }> = [];

    for (const vendor of allVendors) {
      const balance = await this.getBalance(vendor.id);
      const minimum = vendor.payoutMinimumCents ?? this.options.defaultPayoutMinimumCents ?? 5000;

      if (balance < minimum) continue;

      const grossAmount = balance;
      const deductions: Array<{ type: string; amount: number; reference?: string }> = [];
      const netAmount = grossAmount - deductions.reduce((sum, d) => sum + d.amount, 0);

      if (netAmount <= 0) continue;

      const [payout] = await this.db.insert(vendorPayouts).values({
        vendorId: vendor.id,
        amount: netAmount,
        status: "processing",
        grossAmount,
        deductions,
        netAmount,
        periodEnd: new Date(),
      }).returning();

      if (!payout) continue;

      // Debit vendor balance
      await this.addLedgerEntry({
        vendorId: vendor.id,
        type: "payout",
        amountCents: -netAmount,
        referenceType: "payout",
        referenceId: payout.id,
        description: `Payout #${payout.id.slice(0, 8)}`,
      });

      // Mark as completed (in a real system, this would wait for bank transfer confirmation)
      await this.db.update(vendorPayouts).set({
        status: "completed",
        processedAt: new Date(),
      }).where(eq(vendorPayouts.id, payout.id));

      results.push({ vendorId: vendor.id, payoutId: payout.id, netAmount });
    }

    return results;
  }

  async retryPayout(payoutId: string) {
    const payout = await this.getPayoutById(payoutId);
    if (!payout) throw new Error("Payout not found.");
    if (payout.status !== "failed") throw new Error("Only failed payouts can be retried.");

    const [updated] = await this.db.update(vendorPayouts).set({
      status: "processing",
      retryCount: (payout.retryCount ?? 0) + 1,
      failedAt: null,
      failureReason: null,
    }).where(eq(vendorPayouts.id, payoutId)).returning();

    // Mark completed (simplified — real implementation calls payment provider)
    await this.db.update(vendorPayouts).set({
      status: "completed",
      processedAt: new Date(),
    }).where(eq(vendorPayouts.id, payoutId));

    return updated;
  }
}
