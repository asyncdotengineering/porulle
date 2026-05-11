import { eq, and, desc, sql } from "@porulle/core/drizzle";
import { Ok, Err } from "@porulle/core";
import type { PluginResult } from "@porulle/core";
import { posShifts, posCashEvents, posPayments, posTransactions } from "../schema.js";
import type { Db, Shift, CashEvent } from "../types.js";

export class ShiftService {
  constructor(
    private db: Db,
    private transaction: (fn: (tx: Db) => Promise<unknown>) => Promise<unknown>,
  ) {}

  async open(orgId: string, input: {
    terminalId: string;
    operatorId: string;
    openingFloat: number;
  }): Promise<PluginResult<Shift>> {
    if (input.openingFloat < 0) return Err("Opening float must be non-negative");

    // Check no open shift on this terminal
    const openShifts = await this.db
      .select()
      .from(posShifts)
      .where(and(
        eq(posShifts.terminalId, input.terminalId),
        eq(posShifts.status, "open"),
      ));

    if (openShifts.length > 0) {
      return Err("Terminal already has an open shift");
    }

    const rows = await this.db
      .insert(posShifts)
      .values({
        organizationId: orgId,
        terminalId: input.terminalId,
        operatorId: input.operatorId,
        openingFloat: input.openingFloat,
        status: "open",
      })
      .returning();

    const shift = rows[0]!;

    // Record the opening float as a cash event
    await this.db.insert(posCashEvents).values({
      shiftId: shift.id,
      type: "float",
      amount: input.openingFloat,
      performedBy: input.operatorId,
      performedAt: new Date(),
    });

    return Ok(shift);
  }

  async close(orgId: string, shiftId: string, input: {
    closingCount: number;
  }): Promise<PluginResult<Shift>> {
    const result = await this.transaction(async (tx) => {
      const shifts = await tx
        .select()
        .from(posShifts)
        .where(and(eq(posShifts.id, shiftId), eq(posShifts.organizationId, orgId)))
        .for("update");

      if (shifts.length === 0) return Err("Shift not found");
      const shift = shifts[0]!;
      if (shift.status === "closed") return Err("Shift is already closed");

      // Calculate expected cash
      const expectedCash = await this.calculateExpectedCash(tx, shiftId, shift.openingFloat);
      const cashVariance = input.closingCount - expectedCash;

      const updated = await tx
        .update(posShifts)
        .set({
          status: "closed",
          closingCount: input.closingCount,
          expectedCash,
          cashVariance,
          closedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(posShifts.id, shiftId))
        .returning();

      return Ok(updated[0]!);
    });

    return result as PluginResult<Shift>;
  }

  async getCurrent(orgId: string, operatorId: string): Promise<PluginResult<Shift | null>> {
    const rows = await this.db
      .select()
      .from(posShifts)
      .where(and(
        eq(posShifts.organizationId, orgId),
        eq(posShifts.operatorId, operatorId),
        eq(posShifts.status, "open"),
      ));

    return Ok(rows[0] ?? null);
  }

  async getById(orgId: string, id: string): Promise<PluginResult<Shift>> {
    const rows = await this.db
      .select()
      .from(posShifts)
      .where(and(eq(posShifts.id, id), eq(posShifts.organizationId, orgId)));

    if (rows.length === 0) return Err("Shift not found");
    return Ok(rows[0]!);
  }

  // ─── Cash Events ───────────────────────────────────────────────────

  async addCashEvent(shiftId: string, input: {
    type: "drop" | "pickup" | "paid_in" | "paid_out";
    amount: number;
    reason?: string;
    performedBy: string;
  }): Promise<PluginResult<CashEvent>> {
    if (input.amount <= 0) return Err("Amount must be positive");

    // Verify shift is open
    const shifts = await this.db
      .select()
      .from(posShifts)
      .where(eq(posShifts.id, shiftId));

    if (shifts.length === 0) return Err("Shift not found");
    if (shifts[0]!.status !== "open") return Err("Shift is not open");

    const rows = await this.db
      .insert(posCashEvents)
      .values({
        shiftId,
        type: input.type,
        amount: input.amount,
        reason: input.reason,
        performedBy: input.performedBy,
        performedAt: new Date(),
      })
      .returning();

    return Ok(rows[0]!);
  }

  async listCashEvents(shiftId: string): Promise<PluginResult<CashEvent[]>> {
    const rows = await this.db
      .select()
      .from(posCashEvents)
      .where(eq(posCashEvents.shiftId, shiftId))
      .orderBy(desc(posCashEvents.performedAt));
    return Ok(rows);
  }

  // ─── Z-Report ──────────────────────────────────────────────────────

  async getReport(orgId: string, shiftId: string): Promise<PluginResult<{
    shift: Shift;
    cashEvents: CashEvent[];
    paymentMethodTotals: Array<{ method: string; total: number; count: number }>;
    transactionCount: number;
  }>> {
    const shiftResult = await this.getById(orgId, shiftId);
    if (!shiftResult.ok) return shiftResult;
    const shift = shiftResult.value;

    const cashEvents = await this.db
      .select()
      .from(posCashEvents)
      .where(eq(posCashEvents.shiftId, shiftId))
      .orderBy(desc(posCashEvents.performedAt));

    // Payment method totals
    const paymentRows = await this.db
      .select({
        method: posPayments.method,
        total: sql<number>`SUM(${posPayments.amount})`.as("total"),
        count: sql<number>`COUNT(*)`.as("count"),
      })
      .from(posPayments)
      .innerJoin(posTransactions, eq(posPayments.transactionId, posTransactions.id))
      .where(and(
        eq(posTransactions.shiftId, shiftId),
        eq(posTransactions.status, "completed"),
      ))
      .groupBy(posPayments.method);

    const transactionCountRows = await this.db
      .select({ count: sql<number>`COUNT(*)`.as("count") })
      .from(posTransactions)
      .where(and(
        eq(posTransactions.shiftId, shiftId),
        eq(posTransactions.status, "completed"),
      ));

    return Ok({
      shift,
      cashEvents,
      paymentMethodTotals: paymentRows.map((r) => ({
        method: r.method,
        total: Number(r.total),
        count: Number(r.count),
      })),
      transactionCount: Number(transactionCountRows[0]?.count ?? 0),
    });
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private async calculateExpectedCash(db: Db, shiftId: string, openingFloat: number): Promise<number> {
    // Cash payments collected during this shift
    const cashPaymentRows = await db
      .select({
        total: sql<number>`COALESCE(SUM(${posPayments.amount} - ${posPayments.changeGiven}), 0)`.as("total"),
      })
      .from(posPayments)
      .innerJoin(posTransactions, eq(posPayments.transactionId, posTransactions.id))
      .where(and(
        eq(posTransactions.shiftId, shiftId),
        eq(posPayments.method, "cash"),
        eq(posPayments.status, "collected"),
      ));

    const cashFromSales = Number(cashPaymentRows[0]?.total ?? 0);

    // Cash events: drops reduce, pickups add to drawer
    const cashEventRows = await db
      .select({
        type: posCashEvents.type,
        total: sql<number>`SUM(${posCashEvents.amount})`.as("total"),
      })
      .from(posCashEvents)
      .where(eq(posCashEvents.shiftId, shiftId))
      .groupBy(posCashEvents.type);

    let cashAdjustment = 0;
    for (const row of cashEventRows) {
      const amount = Number(row.total);
      switch (row.type) {
        case "drop":
        case "paid_out":
          cashAdjustment -= amount;
          break;
        case "pickup":
        case "paid_in":
          cashAdjustment += amount;
          break;
        // float is already accounted for in openingFloat
      }
    }

    return openingFloat + cashFromSales + cashAdjustment;
  }
}
