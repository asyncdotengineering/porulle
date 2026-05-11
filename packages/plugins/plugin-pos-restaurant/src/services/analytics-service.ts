/**
 * RestaurantAnalyticsService — Daily P&L, performance reports, and sales analytics.
 *
 * URY: 14 report types + Daily P&L doctype with COGS, direct/indirect expenses,
 * employee costs, gross/net profit calculation.
 *
 * URY reports: Today's Sales, Daywise Sales, Daywise Invoices, Month Wise Sales,
 * Average Bill Value, Cancelled Invoices, Item Wise Sales, Customer Data,
 * Repeated Customers, Daywise Customer Details, Employee Sales,
 * Employee Item Wise Sales, Service Wise Sales, Time Wise Sales.
 *
 * Our implementation: P&L CRUD + SQL-based report queries against core order tables.
 */

import { eq, and, sql, desc } from "@porulle/core/drizzle";
import { Ok, Err } from "@porulle/core";
import type { PluginResult } from "@porulle/core";
import { posDailyPnl, posPnlExpenses, kdsTickets, kdsTicketItems } from "../schema.js";
import type { Db } from "../types.js";

export class RestaurantAnalyticsService {
  constructor(private db: Db) {}

  // ─── Daily P&L ─────────────────────────────────────────────────────

  async createDailyPnl(orgId: string, input: {
    date: Date;
    grossSales: number;
    netSales: number;
    costOfGoods: number;
    directExpenses: number;
    indirectExpenses: number;
    employeeCosts: number;
    transactionCount: number;
    expenses?: Array<{ category: "cogs" | "direct" | "indirect" | "employee"; name: string; amount: number; percentage?: number }>;
  }): Promise<PluginResult<typeof posDailyPnl.$inferSelect>> {
    // Validate P&L inputs
    if (input.grossSales < 0) return Err("grossSales cannot be negative");
    if (input.netSales < 0) return Err("netSales cannot be negative");
    if (input.costOfGoods < 0) return Err("costOfGoods cannot be negative");
    if (input.directExpenses < 0) return Err("directExpenses cannot be negative");
    if (input.indirectExpenses < 0) return Err("indirectExpenses cannot be negative");
    if (input.employeeCosts < 0) return Err("employeeCosts cannot be negative");
    if (input.transactionCount < 0) return Err("transactionCount cannot be negative");
    if (input.netSales > input.grossSales) return Err("netSales cannot exceed grossSales");

    const grossProfit = input.netSales - input.costOfGoods - input.directExpenses;
    const netProfit = grossProfit - input.indirectExpenses - input.employeeCosts;
    const averageBillValue = input.transactionCount > 0
      ? Math.round(input.grossSales / input.transactionCount)
      : 0;

    const rows = await this.db
      .insert(posDailyPnl)
      .values({
        organizationId: orgId,
        date: input.date,
        grossSales: input.grossSales,
        netSales: input.netSales,
        costOfGoods: input.costOfGoods,
        directExpenses: input.directExpenses,
        indirectExpenses: input.indirectExpenses,
        employeeCosts: input.employeeCosts,
        grossProfit,
        netProfit,
        transactionCount: input.transactionCount,
        averageBillValue,
      })
      .returning();

    const pnl = rows[0]!;

    // Insert expense line items
    if (input.expenses) {
      for (const exp of input.expenses) {
        await this.db.insert(posPnlExpenses).values({
          pnlId: pnl.id,
          category: exp.category,
          name: exp.name,
          amount: exp.amount,
          percentage: exp.percentage,
        });
      }
    }

    return Ok(pnl);
  }

  async getDailyPnl(orgId: string, date: Date): Promise<PluginResult<{
    pnl: typeof posDailyPnl.$inferSelect;
    expenses: Array<typeof posPnlExpenses.$inferSelect>;
  }>> {
    const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

    const pnls = await this.db
      .select()
      .from(posDailyPnl)
      .where(and(
        eq(posDailyPnl.organizationId, orgId),
        sql`${posDailyPnl.date} >= ${startOfDay}`,
        sql`${posDailyPnl.date} < ${endOfDay}`,
      ));

    if (pnls.length === 0) return Err("No P&L record for this date");
    const pnl = pnls[0]!;

    const expenses = await this.db
      .select()
      .from(posPnlExpenses)
      .where(eq(posPnlExpenses.pnlId, pnl.id));

    return Ok({ pnl, expenses });
  }

  async listDailyPnl(orgId: string, limit?: number): Promise<PluginResult<Array<typeof posDailyPnl.$inferSelect>>> {
    const rows = await this.db
      .select()
      .from(posDailyPnl)
      .where(eq(posDailyPnl.organizationId, orgId))
      .orderBy(desc(posDailyPnl.date))
      .limit(limit ?? 30);

    return Ok(rows);
  }

  // ─── KDS Performance Metrics ──────────────────────────────────────
  // Course-wise and station-wise performance from KDS tickets.

  async getStationPerformance(orgId: string, stationId: string, dateFrom: Date, dateTo: Date): Promise<PluginResult<{
    totalTickets: number;
    averagePrepSeconds: number;
    ticketsByStatus: Array<{ status: string; count: number }>;
  }>> {
    const tickets = await this.db
      .select()
      .from(kdsTickets)
      .where(and(
        eq(kdsTickets.organizationId, orgId),
        eq(kdsTickets.stationId, stationId),
        sql`${kdsTickets.createdAt} >= ${dateFrom}`,
        sql`${kdsTickets.createdAt} < ${dateTo}`,
      ));

    const totalTickets = tickets.length;
    const servedTickets = tickets.filter((t) => t.prepDurationSeconds != null);
    const averagePrepSeconds = servedTickets.length > 0
      ? Math.round(servedTickets.reduce((sum, t) => sum + (t.prepDurationSeconds ?? 0), 0) / servedTickets.length)
      : 0;

    const statusCounts = new Map<string, number>();
    for (const t of tickets) {
      statusCounts.set(t.status, (statusCounts.get(t.status) ?? 0) + 1);
    }

    return Ok({
      totalTickets,
      averagePrepSeconds,
      ticketsByStatus: [...statusCounts.entries()].map(([status, count]) => ({ status, count })),
    });
  }

  async getCoursePerformance(orgId: string, dateFrom: Date, dateTo: Date): Promise<PluginResult<Array<{
    courseName: string;
    totalItems: number;
    averagePrepSeconds: number;
  }>>> {
    // Get all ticket items with their parent ticket's prep time
    const tickets = await this.db
      .select()
      .from(kdsTickets)
      .where(and(
        eq(kdsTickets.organizationId, orgId),
        sql`${kdsTickets.createdAt} >= ${dateFrom}`,
        sql`${kdsTickets.createdAt} < ${dateTo}`,
        eq(kdsTickets.status, "served"),
      ));

    const courseStats = new Map<string, { totalItems: number; totalPrepSeconds: number; count: number }>();

    for (const ticket of tickets) {
      const items = await this.db
        .select()
        .from(kdsTicketItems)
        .where(eq(kdsTicketItems.ticketId, ticket.id));

      for (const item of items) {
        const course = item.courseName ?? "Uncategorized";
        const existing = courseStats.get(course) ?? { totalItems: 0, totalPrepSeconds: 0, count: 0 };
        existing.totalItems += item.quantity;
        if (ticket.prepDurationSeconds != null) {
          existing.totalPrepSeconds += ticket.prepDurationSeconds;
          existing.count++;
        }
        courseStats.set(course, existing);
      }
    }

    return Ok([...courseStats.entries()].map(([courseName, stats]) => ({
      courseName,
      totalItems: stats.totalItems,
      averagePrepSeconds: stats.count > 0 ? Math.round(stats.totalPrepSeconds / stats.count) : 0,
    })));
  }

  // ─── Operator/Staff Performance ───────────────────────────────────
  // URY: Captain and staff performance tracking.

  async getOperatorPerformance(orgId: string, dateFrom: Date, dateTo: Date): Promise<PluginResult<Array<{
    operatorName: string;
    totalTickets: number;
    averagePrepSeconds: number;
  }>>> {
    const tickets = await this.db
      .select()
      .from(kdsTickets)
      .where(and(
        eq(kdsTickets.organizationId, orgId),
        sql`${kdsTickets.createdAt} >= ${dateFrom}`,
        sql`${kdsTickets.createdAt} < ${dateTo}`,
      ));

    const operatorStats = new Map<string, { totalTickets: number; totalPrepSeconds: number; servedCount: number }>();

    for (const ticket of tickets) {
      const operator = ticket.operatorName ?? "Unknown";
      const existing = operatorStats.get(operator) ?? { totalTickets: 0, totalPrepSeconds: 0, servedCount: 0 };
      existing.totalTickets++;
      if (ticket.prepDurationSeconds != null) {
        existing.totalPrepSeconds += ticket.prepDurationSeconds;
        existing.servedCount++;
      }
      operatorStats.set(operator, existing);
    }

    return Ok([...operatorStats.entries()].map(([operatorName, stats]) => ({
      operatorName,
      totalTickets: stats.totalTickets,
      averagePrepSeconds: stats.servedCount > 0 ? Math.round(stats.totalPrepSeconds / stats.servedCount) : 0,
    })));
  }
}
