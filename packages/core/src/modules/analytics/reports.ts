import { sql, type SQL } from "drizzle-orm";
import type { DrizzleDatabase } from "../../kernel/database/drizzle-db.js";
import { CommerceValidationError } from "../../kernel/errors.js";
import { Err, Ok, type Result } from "../../kernel/result.js";

/**
 * Canned retail reports (issue #48).
 *
 * Parameterized SQL over core tables, org-scoped, with all calendar math done
 * by Postgres in the store's timezone (settings.general.timezone, default
 * UTC). Range reports include a prior period of equal length with deltas.
 */

export interface ReportParams {
  /** Local calendar date (YYYY-MM-DD) for single-day reports. Default: today in store tz. */
  date?: string;
  /** Local range start (YYYY-MM-DD, inclusive). Default: first of current month in store tz. */
  from?: string;
  /** Local range end (YYYY-MM-DD, inclusive). Default: today in store tz. */
  to?: string;
}

export const RETAIL_REPORTS = [
  { name: "daily-journal", description: "Per-day sales journal: order rows + summary with prior-day deltas." },
  { name: "tax-summary", description: "Tax collected over a range, bucketed per local day, with prior-period deltas." },
  { name: "inventory-aging", description: "On-hand stock bucketed by days since last restock (0-30/31-60/61-90/90+)." },
  { name: "sell-through", description: "Units sold in the range vs current on-hand, per entity." },
  { name: "reorder-needed", description: "Inventory rows at or below their reorder threshold." },
  { name: "staff-sales", description: "Orders and revenue grouped by orders.metadata.staffId." },
] as const;

export type RetailReportName = (typeof RETAIL_REPORTS)[number]["name"];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Orders excluded from financial reports.
const EXCLUDED_STATUSES = ["cancelled", "voided"];

type SettingsReader = (orgId: string, group: string) => Promise<Record<string, unknown>>;

interface JournalSummary {
  orderCount: number;
  grossSales: number;
  subtotal: number;
  discounts: number;
  tax: number;
  shipping: number;
}

export class RetailReportsEngine {
  constructor(
    private readonly db: DrizzleDatabase,
    private readonly readSettings: SettingsReader,
  ) {}

  async run(
    name: string,
    params: ReportParams,
    orgId: string,
  ): Promise<Result<Record<string, unknown>>> {
    for (const value of [params.date, params.from, params.to]) {
      if (value !== undefined && !DATE_RE.test(value)) {
        return Err(new CommerceValidationError("Dates must be YYYY-MM-DD."));
      }
    }
    const tz = await this.timezoneFor(orgId);

    switch (name) {
      case "daily-journal":
        return Ok(await this.dailyJournal(orgId, tz, params.date ?? localToday(tz)));
      case "tax-summary": {
        const [from, to] = this.rangeOrDefault(params, tz);
        return Ok(await this.taxSummary(orgId, tz, from, to));
      }
      case "inventory-aging":
        return Ok(await this.inventoryAging(orgId));
      case "sell-through": {
        const [from, to] = this.rangeOrDefault(params, tz);
        return Ok(await this.sellThrough(orgId, tz, from, to));
      }
      case "reorder-needed":
        return Ok(await this.reorderNeeded(orgId));
      case "staff-sales": {
        const [from, to] = this.rangeOrDefault(params, tz);
        return Ok(await this.staffSales(orgId, tz, from, to));
      }
      default:
        return Err(
          new CommerceValidationError(
            `Unknown report "${name}". Available: ${RETAIL_REPORTS.map((r) => r.name).join(", ")}.`,
          ),
        );
    }
  }

  private async timezoneFor(orgId: string): Promise<string> {
    const general = await this.readSettings(orgId, "general");
    return typeof general.timezone === "string" ? general.timezone : "UTC";
  }

  private rangeOrDefault(params: ReportParams, tz: string): [string, string] {
    const today = localToday(tz);
    return [params.from ?? `${today.slice(0, 8)}01`, params.to ?? today];
  }

  private async rows(query: SQL): Promise<Record<string, unknown>[]> {
    const result = await this.db.execute(query);
    const raw: Record<string, unknown>[] = Array.isArray(result)
      ? result
      : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);
    return raw.map((row) => {
      const mapped: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        mapped[key] = typeof value === "bigint" ? Number(value) : value;
      }
      return mapped;
    });
  }

  private async journalSummary(
    orgId: string,
    tz: string,
    from: string,
    to: string,
  ): Promise<JournalSummary> {
    const rows = await this.rows(sql`
      SELECT count(*)::int AS "orderCount",
             COALESCE(sum(grand_total), 0)::int AS "grossSales",
             COALESCE(sum(subtotal), 0)::int AS "subtotal",
             COALESCE(sum(discount_total), 0)::int AS "discounts",
             COALESCE(sum(tax_total), 0)::int AS "tax",
             COALESCE(sum(shipping_total), 0)::int AS "shipping"
      FROM orders
      WHERE organization_id = ${orgId}
        AND status NOT IN (${sql.join(EXCLUDED_STATUSES.map((s) => sql`${s}`), sql`, `)})
        AND (placed_at AT TIME ZONE ${tz})::date BETWEEN ${from}::date AND ${to}::date
    `);
    return rows[0] as unknown as JournalSummary;
  }

  private async dailyJournal(orgId: string, tz: string, date: string) {
    const summary = await this.journalSummary(orgId, tz, date, date);
    const previousDate = shiftDate(date, -1);
    const previous = await this.journalSummary(orgId, tz, previousDate, previousDate);
    const orders = await this.rows(sql`
      SELECT order_number AS "orderNumber", status, currency,
             grand_total AS "grandTotal", tax_total AS "tax",
             discount_total AS "discounts", placed_at AS "placedAt"
      FROM orders
      WHERE organization_id = ${orgId}
        AND status NOT IN (${sql.join(EXCLUDED_STATUSES.map((s) => sql`${s}`), sql`, `)})
        AND (placed_at AT TIME ZONE ${tz})::date = ${date}::date
      ORDER BY placed_at ASC
    `);
    return {
      report: "daily-journal",
      timezone: tz,
      date,
      summary,
      previous,
      delta: deltas(summary, previous),
      orders,
    };
  }

  private async taxSummary(orgId: string, tz: string, from: string, to: string) {
    const days = await this.rows(sql`
      SELECT to_char((placed_at AT TIME ZONE ${tz})::date, 'YYYY-MM-DD') AS "day",
             count(*)::int AS "orderCount",
             COALESCE(sum(tax_total), 0)::int AS "tax",
             COALESCE(sum(grand_total), 0)::int AS "gross"
      FROM orders
      WHERE organization_id = ${orgId}
        AND status NOT IN (${sql.join(EXCLUDED_STATUSES.map((s) => sql`${s}`), sql`, `)})
        AND (placed_at AT TIME ZONE ${tz})::date BETWEEN ${from}::date AND ${to}::date
      GROUP BY 1
      ORDER BY 1
    `);
    const totals = await this.journalSummary(orgId, tz, from, to);
    const lengthDays = daysBetween(from, to) + 1;
    const prevFrom = shiftDate(from, -lengthDays);
    const prevTo = shiftDate(to, -lengthDays);
    const previous = await this.journalSummary(orgId, tz, prevFrom, prevTo);
    return {
      report: "tax-summary",
      timezone: tz,
      from,
      to,
      totals,
      previous: { from: prevFrom, to: prevTo, ...previous },
      delta: deltas(totals, previous),
      days,
    };
  }

  private async inventoryAging(orgId: string) {
    const rows = await this.rows(sql`
      SELECT il.entity_id AS "entityId", il.variant_id AS "variantId",
             e.slug AS "slug",
             il.quantity_on_hand AS "quantityOnHand",
             il.quantity_reserved AS "quantityReserved",
             GREATEST(0, EXTRACT(day FROM now() - COALESCE(il.last_restocked_at, il.updated_at)))::int AS "ageDays"
      FROM inventory_levels il
      LEFT JOIN sellable_entities e ON e.id = il.entity_id
      WHERE il.organization_id = ${orgId} AND il.quantity_on_hand > 0
      ORDER BY "ageDays" DESC
    `);
    const buckets = [
      { bucket: "0-30", min: 0, max: 30 },
      { bucket: "31-60", min: 31, max: 60 },
      { bucket: "61-90", min: 61, max: 90 },
      { bucket: "90+", min: 91, max: Infinity },
    ].map(({ bucket, min, max }) => {
      const inBucket = rows.filter((r) => (r.ageDays as number) >= min && (r.ageDays as number) <= max);
      return {
        bucket,
        skuCount: inBucket.length,
        quantityOnHand: inBucket.reduce((sum, r) => sum + (r.quantityOnHand as number), 0),
      };
    });
    return { report: "inventory-aging", buckets, rows };
  }

  private async sellThrough(orgId: string, tz: string, from: string, to: string) {
    const rows = await this.rows(sql`
      SELECT li.entity_id AS "entityId",
             min(li.title) AS "title",
             sum(li.quantity)::int AS "unitsSold",
             COALESCE((SELECT sum(quantity_on_hand)::int FROM inventory_levels il
                       WHERE il.entity_id = li.entity_id AND il.organization_id = ${orgId}), 0) AS "onHand"
      FROM order_line_items li
      JOIN orders o ON o.id = li.order_id
      WHERE o.organization_id = ${orgId}
        AND o.status NOT IN (${sql.join(EXCLUDED_STATUSES.map((s) => sql`${s}`), sql`, `)})
        AND (o.placed_at AT TIME ZONE ${tz})::date BETWEEN ${from}::date AND ${to}::date
      GROUP BY li.entity_id
      ORDER BY "unitsSold" DESC
    `);
    return {
      report: "sell-through",
      timezone: tz,
      from,
      to,
      rows: rows.map((r) => {
        const sold = r.unitsSold as number;
        const onHand = r.onHand as number;
        return { ...r, sellThroughRate: sold + onHand > 0 ? sold / (sold + onHand) : 0 };
      }),
    };
  }

  private async reorderNeeded(orgId: string) {
    const rows = await this.rows(sql`
      SELECT il.entity_id AS "entityId", il.variant_id AS "variantId",
             il.warehouse_id AS "warehouseId", e.slug AS "slug",
             il.quantity_on_hand AS "quantityOnHand",
             il.quantity_reserved AS "quantityReserved",
             (il.quantity_on_hand - il.quantity_reserved) AS "available",
             il.reorder_threshold AS "reorderThreshold",
             il.reorder_quantity AS "reorderQuantity"
      FROM inventory_levels il
      LEFT JOIN sellable_entities e ON e.id = il.entity_id
      WHERE il.organization_id = ${orgId}
        AND il.reorder_threshold IS NOT NULL
        AND (il.quantity_on_hand - il.quantity_reserved) <= il.reorder_threshold
      ORDER BY "available" ASC
    `);
    return { report: "reorder-needed", rows };
  }

  private async staffSales(orgId: string, tz: string, from: string, to: string) {
    const rows = await this.rows(sql`
      SELECT COALESCE(metadata->>'staffId', 'unattributed') AS "staffId",
             count(*)::int AS "orderCount",
             COALESCE(sum(grand_total), 0)::int AS "revenue",
             COALESCE(sum(discount_total), 0)::int AS "discounts"
      FROM orders
      WHERE organization_id = ${orgId}
        AND status NOT IN (${sql.join(EXCLUDED_STATUSES.map((s) => sql`${s}`), sql`, `)})
        AND (placed_at AT TIME ZONE ${tz})::date BETWEEN ${from}::date AND ${to}::date
      GROUP BY 1
      ORDER BY "revenue" DESC
    `);
    return { report: "staff-sales", timezone: tz, from, to, rows };
  }
}

// ── Pure date helpers (calendar dates, no time component) ──────────────────

/** Today's local calendar date (YYYY-MM-DD) in an IANA timezone. */
export function localToday(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const ms = new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime();
  return Math.round(ms / 86_400_000);
}

function deltas(current: JournalSummary, previous: JournalSummary): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(current) as Array<keyof JournalSummary>) {
    out[key] = (current[key] ?? 0) - (previous[key] ?? 0);
  }
  return out;
}
