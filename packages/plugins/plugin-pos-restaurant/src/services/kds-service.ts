/**
 * KDSService — Kitchen Display System station management, ticket generation,
 * and status tracking.
 *
 * Informed by URY's KOT system:
 * - URY Production Unit: item-group-based routing, per-station printers
 * - URY KOT: submittable ticket per production unit, type enum, order_status,
 *   production_time tracking, Socket.IO broadcasting
 * - URY KOT Items: course (Menu Course link), serve_priority, indicate_course,
 *   cancelled_qty
 * - kot_execute(): compares previous vs current items, generates New Order,
 *   Order Modified, Partially cancelled KOTs per production unit
 * - multi_print_kot(): production printer > room printer > POS printer cascade
 *
 * Improvements over URY:
 * - Item-level status persisted to DB (not browser localStorage)
 * - 4-state ticket status (pending -> preparing -> ready -> served)
 *   instead of URY's 2-state (Ready For Prepare -> Served)
 * - prep_duration_seconds calculated and stored for analytics
 * - Structured course priority on ticket items (not just display ordering)
 */

import { eq, and, desc, sql } from "@porulle/core/drizzle";
import {
  kdsStations,
  kdsStationItemGroups,
  kdsTickets,
  kdsTicketItems,
} from "../schema.js";
import type {
  Db,
  KDSStation,
  KDSStationItemGroup,
  KDSTicket,
  KDSTicketItem,
  TicketStatus,
  TicketItemStatus,
} from "../types.js";

import { Ok, Err } from "@porulle/core";
import type { PluginResult } from "@porulle/core";

export class KDSService {
  constructor(private db: Db) {}

  // ─── Station CRUD ──────────────────────────────────────────────────

  async createStation(orgId: string, input: {
    name: string;
    alertThresholdMinutes?: number;
    metadata?: Record<string, unknown>;
  }): Promise<PluginResult<KDSStation>> {
    const existing = await this.db
      .select()
      .from(kdsStations)
      .where(and(eq(kdsStations.organizationId, orgId), eq(kdsStations.name, input.name)));

    if (existing.length > 0) return Err(`Station '${input.name}' already exists`);

    const rows = await this.db
      .insert(kdsStations)
      .values({
        organizationId: orgId,
        name: input.name,
        alertThresholdMinutes: input.alertThresholdMinutes ?? 15,
        metadata: input.metadata ?? {},
      })
      .returning();

    return Ok(rows[0]!);
  }

  async listStations(orgId: string): Promise<PluginResult<KDSStation[]>> {
    const rows = await this.db
      .select()
      .from(kdsStations)
      .where(eq(kdsStations.organizationId, orgId));
    return Ok(rows);
  }

  async updateStation(orgId: string, id: string, input: {
    name?: string;
    isActive?: boolean;
    alertThresholdMinutes?: number;
  }): Promise<PluginResult<KDSStation>> {
    const rows = await this.db
      .update(kdsStations)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(kdsStations.id, id), eq(kdsStations.organizationId, orgId)))
      .returning();

    if (rows.length === 0) return Err("Station not found");
    return Ok(rows[0]!);
  }

  // ─── Station Item Groups ──────────────────────────────────────────
  // URY equivalent: URY Production Item Groups child table.

  async addItemGroup(stationId: string, itemGroup: string): Promise<PluginResult<KDSStationItemGroup>> {
    const rows = await this.db
      .insert(kdsStationItemGroups)
      .values({ stationId, itemGroup })
      .returning();
    return Ok(rows[0]!);
  }

  async removeItemGroup(stationId: string, itemGroup: string): Promise<PluginResult<{ removed: boolean }>> {
    const rows = await this.db
      .delete(kdsStationItemGroups)
      .where(and(
        eq(kdsStationItemGroups.stationId, stationId),
        eq(kdsStationItemGroups.itemGroup, itemGroup),
      ))
      .returning();

    if (rows.length === 0) return Err("Item group not found on station");
    return Ok({ removed: true });
  }

  async getStationItemGroups(stationId: string): Promise<string[]> {
    const rows = await this.db
      .select({ itemGroup: kdsStationItemGroups.itemGroup })
      .from(kdsStationItemGroups)
      .where(eq(kdsStationItemGroups.stationId, stationId));
    return rows.map((r) => r.itemGroup);
  }

  // ─── Ticket Generation ─────────────────────────────────────────────
  // URY equivalent: kot_execute() + process_items_for_kot() + create_kot_doc().
  //
  // For each station, filter items matching station's item groups.
  // If matching items exist, create a ticket for that station.
  // If a ticket already exists for this transaction+station, set type="modified".

  async generateTickets(orgId: string, input: {
    transactionId: string;
    items: Array<{
      entityId: string;
      variantId?: string;
      itemName: string;
      quantity: number;
      itemGroup: string;
      courseName?: string;
      coursePriority?: number;
      showCourseLabel?: boolean;
      modifiers?: Array<{ name: string; priceAdjustment: number }>;
      notes?: string;
    }>;
    tableNumber?: string;
    orderType?: "dine_in" | "takeaway" | "delivery";
    operatorName?: string;
    comments?: string;
  }): Promise<PluginResult<KDSTicket[]>> {
    // Get all active stations with their item groups
    const stations = await this.db
      .select()
      .from(kdsStations)
      .where(and(eq(kdsStations.organizationId, orgId), eq(kdsStations.isActive, true)));

    const tickets: KDSTicket[] = [];

    for (const station of stations) {
      const stationGroups = await this.getStationItemGroups(station.id);
      const matchingItems = input.items.filter((item) => stationGroups.includes(item.itemGroup));

      if (matchingItems.length === 0) continue;

      // Check if ticket already exists for this transaction+station
      const existingTickets = await this.db
        .select()
        .from(kdsTickets)
        .where(and(
          eq(kdsTickets.transactionId, input.transactionId),
          eq(kdsTickets.stationId, station.id),
        ));

      const ticketType = existingTickets.length > 0 ? "modified" : "new_order";
      const ticketNumber = await this.generateTicketNumber(station.id);

      const ticketRows = await this.db
        .insert(kdsTickets)
        .values({
          organizationId: orgId,
          transactionId: input.transactionId,
          stationId: station.id,
          type: ticketType,
          status: "pending",
          tableNumber: input.tableNumber,
          orderType: input.orderType ?? "dine_in",
          operatorName: input.operatorName,
          ticketNumber,
          comments: input.comments,
        })
        .returning();

      const ticket = ticketRows[0]!;

      // Add items to ticket
      for (const item of matchingItems) {
        await this.db.insert(kdsTicketItems).values({
          ticketId: ticket.id,
          entityId: item.entityId,
          variantId: item.variantId,
          itemName: item.itemName,
          quantity: item.quantity,
          courseName: item.courseName,
          coursePriority: item.coursePriority ?? 0,
          showCourseLabel: item.showCourseLabel ?? false,
          modifiers: item.modifiers ?? [],
          notes: item.notes,
        });
      }

      tickets.push(ticket);
    }

    return Ok(tickets);
  }

  // ─── Ticket Status Updates ─────────────────────────────────────────
  // URY equivalent: serve_kot() — sets order_status="Served", production_time.
  // We add intermediate states (preparing, ready) for finer-grained tracking.

  async startTicket(id: string): Promise<PluginResult<KDSTicket>> {
    return this.updateTicketStatus(id, "preparing", { firedAt: new Date() });
  }

  async readyTicket(id: string): Promise<PluginResult<KDSTicket>> {
    const ticket = await this.getTicketById(id);
    if (!ticket.ok) return ticket;

    const prepDuration = ticket.value.firedAt
      ? Math.round((Date.now() - ticket.value.firedAt.getTime()) / 1000)
      : undefined;

    return this.updateTicketStatus(id, "ready", {
      readyAt: new Date(),
      ...(prepDuration != null ? { prepDurationSeconds: prepDuration } : {}),
    });
  }

  async serveTicket(id: string): Promise<PluginResult<KDSTicket>> {
    return this.updateTicketStatus(id, "served", { servedAt: new Date() });
  }

  private static readonly VALID_TRANSITIONS: Record<string, string[]> = {
    pending: ["preparing"],
    preparing: ["ready"],
    ready: ["served"],
    served: [], // terminal state
  };

  private async updateTicketStatus(id: string, newStatus: TicketStatus, extra: Record<string, unknown> = {}): Promise<PluginResult<KDSTicket>> {
    // Validate state transition
    const existing = await this.db.select().from(kdsTickets).where(eq(kdsTickets.id, id));
    if (existing.length === 0) return Err("Ticket not found");
    const current = existing[0]!;

    const allowed = KDSService.VALID_TRANSITIONS[current.status] ?? [];
    if (!allowed.includes(newStatus)) {
      return Err(`Cannot transition ticket from '${current.status}' to '${newStatus}'`);
    }

    const rows = await this.db
      .update(kdsTickets)
      .set({ status: newStatus, ...extra, updatedAt: new Date() })
      .where(eq(kdsTickets.id, id))
      .returning();

    if (rows.length === 0) return Err("Ticket not found");
    return Ok(rows[0]!);
  }

  // ─── Item Status Updates ───────────────────────────────────────────
  // URY stored item strikethrough in browser localStorage only.
  // We persist item status to the database.

  async markItemDone(ticketId: string, itemId: string): Promise<PluginResult<KDSTicketItem>> {
    const rows = await this.db
      .update(kdsTicketItems)
      .set({ status: "done" })
      .where(and(eq(kdsTicketItems.id, itemId), eq(kdsTicketItems.ticketId, ticketId)))
      .returning();

    if (rows.length === 0) return Err("Ticket item not found");
    return Ok(rows[0]!);
  }

  // ─── Queries ───────────────────────────────────────────────────────

  async getTicketById(id: string): Promise<PluginResult<KDSTicket>> {
    const rows = await this.db.select().from(kdsTickets).where(eq(kdsTickets.id, id));
    if (rows.length === 0) return Err("Ticket not found");
    return Ok(rows[0]!);
  }

  async listPendingTickets(orgId: string, stationId: string): Promise<PluginResult<Array<KDSTicket & { items: KDSTicketItem[] }>>> {
    const tickets = await this.db
      .select()
      .from(kdsTickets)
      .where(and(
        eq(kdsTickets.organizationId, orgId),
        eq(kdsTickets.stationId, stationId),
        sql`${kdsTickets.status} != 'served'`,
      ))
      .orderBy(kdsTickets.createdAt);

    const result = [];
    for (const ticket of tickets) {
      const items = await this.db
        .select()
        .from(kdsTicketItems)
        .where(eq(kdsTicketItems.ticketId, ticket.id))
        .orderBy(kdsTicketItems.coursePriority);

      result.push({ ...ticket, items });
    }

    return Ok(result);
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private async generateTicketNumber(stationId: string): Promise<string> {
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const startOfDayISO = startOfDay.toISOString();

    const countRows = await this.db
      .select({ count: sql<number>`COUNT(*)`.as("count") })
      .from(kdsTickets)
      .where(and(
        eq(kdsTickets.stationId, stationId),
        sql`${kdsTickets.createdAt} >= ${startOfDayISO}::timestamptz`,
      ));

    const seq = Number(countRows[0]?.count ?? 0) + 1;
    return `KDS-${String(seq).padStart(4, "0")}`;
  }
}
