/**
 * AlertService — Operational red flags and real-time alerts.
 *
 * URY: Operational Red Flags & Alerts system:
 * - Delayed orders and preparation time breaches
 * - KOT not started after order placement
 * - Unclosed bills and prolonged table occupancy
 * - Excessive KOT cancellations and modifications
 * - Real-time alerts for operational exceptions
 *
 * URY implementation: ury_kot_notification.py polls KOTs and creates
 * system notifications when warning time exceeded. KDS displays timer
 * in red when threshold breached. kotValidationThread runs every minute.
 *
 * Our implementation: AlertService creates persistent alert records,
 * queryable via API. Alert detection runs on demand (called by scheduler
 * or via route). Each alert type has configurable thresholds.
 */

import { eq, and, sql, desc } from "@porulle/core/drizzle";
import { Ok, Err } from "@porulle/core";
import type { PluginResult } from "@porulle/core";
import { posRestaurantAlerts, posAlertConfig, kdsTickets, posTables } from "../schema.js";
import type { Db } from "../types.js";

type AlertType =
  | "delayed_order"
  | "kot_not_started"
  | "unclosed_bill"
  | "prolonged_occupancy"
  | "excessive_cancellations"
  | "excessive_modifications";

export class AlertService {
  constructor(private db: Db) {}

  // ─── Alert Configuration ───────────────────────────────────────────

  async setThreshold(orgId: string, alertType: string, thresholdMinutes: number, notifyRoles?: string[]): Promise<PluginResult<{ alertType: string; thresholdMinutes: number }>> {
    // Upsert: try update, then insert
    const existing = await this.db
      .select()
      .from(posAlertConfig)
      .where(and(eq(posAlertConfig.organizationId, orgId), eq(posAlertConfig.alertType, alertType)));

    if (existing.length > 0) {
      await this.db
        .update(posAlertConfig)
        .set({ thresholdMinutes, ...(notifyRoles ? { notifyRoles } : {}), updatedAt: new Date() })
        .where(eq(posAlertConfig.id, existing[0]!.id));
    } else {
      await this.db.insert(posAlertConfig).values({
        organizationId: orgId,
        alertType,
        thresholdMinutes,
        notifyRoles: notifyRoles ?? [],
      });
    }

    return Ok({ alertType, thresholdMinutes });
  }

  async getConfig(orgId: string): Promise<PluginResult<Array<{ alertType: string; thresholdMinutes: number; isEnabled: boolean }>>> {
    const rows = await this.db
      .select()
      .from(posAlertConfig)
      .where(eq(posAlertConfig.organizationId, orgId));
    return Ok(rows.map((r) => ({ alertType: r.alertType, thresholdMinutes: r.thresholdMinutes, isEnabled: r.isEnabled })));
  }

  // ─── Alert Detection ──────────────────────────────────────────────
  // Scans for conditions that trigger alerts. Called on demand or by scheduler.

  async detectDelayedOrders(orgId: string): Promise<number> {
    const config = await this.getThreshold(orgId, "delayed_order");
    if (!config) return 0;

    const threshold = new Date(Date.now() - config.thresholdMinutes * 60 * 1000);

    // Find pending tickets older than threshold
    const delayed = await this.db
      .select({ id: kdsTickets.id, transactionId: kdsTickets.transactionId, stationId: kdsTickets.stationId })
      .from(kdsTickets)
      .where(and(
        eq(kdsTickets.organizationId, orgId),
        eq(kdsTickets.status, "pending"),
        sql`${kdsTickets.createdAt} < ${threshold}`,
      ));

    let count = 0;
    for (const ticket of delayed) {
      const exists = await this.alertExists(orgId, "delayed_order", ticket.id);
      if (!exists) {
        await this.createAlert(orgId, "delayed_order", "kds_ticket", ticket.id,
          `KDS ticket for transaction ${ticket.transactionId} has been pending for over ${config.thresholdMinutes} minutes`);
        count++;
      }
    }
    return count;
  }

  async detectKotNotStarted(orgId: string): Promise<number> {
    const config = await this.getThreshold(orgId, "kot_not_started");
    if (!config) return 0;

    const threshold = new Date(Date.now() - config.thresholdMinutes * 60 * 1000);

    const notStarted = await this.db
      .select({ id: kdsTickets.id, transactionId: kdsTickets.transactionId })
      .from(kdsTickets)
      .where(and(
        eq(kdsTickets.organizationId, orgId),
        eq(kdsTickets.status, "pending"),
        sql`${kdsTickets.firedAt} IS NULL`,
        sql`${kdsTickets.createdAt} < ${threshold}`,
      ));

    let count = 0;
    for (const ticket of notStarted) {
      const exists = await this.alertExists(orgId, "kot_not_started", ticket.id);
      if (!exists) {
        await this.createAlert(orgId, "kot_not_started", "kds_ticket", ticket.id,
          `KOT for transaction ${ticket.transactionId} not started after ${config.thresholdMinutes} minutes`);
        count++;
      }
    }
    return count;
  }

  async detectProlongedOccupancy(orgId: string): Promise<number> {
    const config = await this.getThreshold(orgId, "prolonged_occupancy");
    if (!config) return 0;

    const threshold = new Date(Date.now() - config.thresholdMinutes * 60 * 1000);

    const prolonged = await this.db
      .select({ id: posTables.id, number: posTables.number })
      .from(posTables)
      .where(and(
        eq(posTables.organizationId, orgId),
        eq(posTables.status, "occupied"),
        sql`${posTables.updatedAt} < ${threshold}`,
      ));

    let count = 0;
    for (const table of prolonged) {
      const exists = await this.alertExists(orgId, "prolonged_occupancy", table.id);
      if (!exists) {
        await this.createAlert(orgId, "prolonged_occupancy", "pos_table", table.id,
          `Table '${table.number}' has been occupied for over ${config.thresholdMinutes} minutes`,
          "warning");
        count++;
      }
    }
    return count;
  }

  // ─── Alert Queries ─────────────────────────────────────────────────

  async listAlerts(orgId: string, options?: {
    type?: AlertType;
    unresolvedOnly?: boolean;
    limit?: number;
  }): Promise<PluginResult<Array<typeof posRestaurantAlerts.$inferSelect>>> {
    const conditions = [eq(posRestaurantAlerts.organizationId, orgId)];
    if (options?.type) conditions.push(eq(posRestaurantAlerts.type, options.type));
    if (options?.unresolvedOnly) conditions.push(eq(posRestaurantAlerts.isResolved, false));

    const rows = await this.db
      .select()
      .from(posRestaurantAlerts)
      .where(and(...conditions))
      .orderBy(desc(posRestaurantAlerts.createdAt))
      .limit(options?.limit ?? 100);

    return Ok(rows);
  }

  async resolveAlert(alertId: string, resolvedBy: string): Promise<PluginResult<{ resolved: boolean }>> {
    const rows = await this.db
      .update(posRestaurantAlerts)
      .set({ isResolved: true, resolvedBy, resolvedAt: new Date() })
      .where(eq(posRestaurantAlerts.id, alertId))
      .returning();

    if (rows.length === 0) return Err("Alert not found");
    return Ok({ resolved: true });
  }

  async runAllDetections(orgId: string): Promise<PluginResult<{ delayed: number; notStarted: number; occupancy: number }>> {
    const delayed = await this.detectDelayedOrders(orgId);
    const notStarted = await this.detectKotNotStarted(orgId);
    const occupancy = await this.detectProlongedOccupancy(orgId);
    return Ok({ delayed, notStarted, occupancy });
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private async getThreshold(orgId: string, alertType: string): Promise<{ thresholdMinutes: number } | null> {
    const rows = await this.db
      .select()
      .from(posAlertConfig)
      .where(and(
        eq(posAlertConfig.organizationId, orgId),
        eq(posAlertConfig.alertType, alertType),
        eq(posAlertConfig.isEnabled, true),
      ));
    return rows[0] ?? null;
  }

  private async alertExists(orgId: string, type: AlertType, referenceId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: posRestaurantAlerts.id })
      .from(posRestaurantAlerts)
      .where(and(
        eq(posRestaurantAlerts.organizationId, orgId),
        eq(posRestaurantAlerts.type, type),
        eq(posRestaurantAlerts.referenceId, referenceId),
        eq(posRestaurantAlerts.isResolved, false),
      ));
    return rows.length > 0;
  }

  private async createAlert(orgId: string, type: AlertType, refType: string, refId: string, message: string, severity: "warning" | "critical" = "warning"): Promise<void> {
    await this.db.insert(posRestaurantAlerts).values({
      organizationId: orgId,
      type,
      severity,
      referenceType: refType,
      referenceId: refId,
      message,
    });
  }
}
