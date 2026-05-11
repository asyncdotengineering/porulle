/**
 * TableService — Table CRUD, status management, assignment, and transfer.
 *
 * Informed by URY's table management patterns:
 * - URY Table: room-based (restaurant_room), binary occupied flag, floor plan layout,
 *   shape (Circle/Square/Rectangle), is_take_away
 * - table_transfer(): validates same room, target not occupied, updates KOT links
 * - captain_transfer(): reassigns waiter, validates room access in multi-cashier mode
 * - restrict_existing_order(): prevents double-booking (no 2 draft invoices on 1 table)
 *
 * Improvements over URY:
 * - 4-state status machine (available -> occupied -> bill_requested -> cleaning)
 *   instead of binary occupied flag
 * - Multi-table assignments (large party across 2+ tables) via pos_table_assignments
 * - Server section assignment (assignedOperatorId) as first-class field
 * - Zone-based grouping instead of room doctype FK
 */

import { eq, and, sql } from "@porulle/core/drizzle";
import { Ok, Err } from "@porulle/core";
import type { PluginResult } from "@porulle/core";
import { posTables, posTableAssignments } from "../schema.js";
import type { Db, Table, TableAssignment, TableStatus } from "../types.js";

const VALID_TRANSITIONS: Record<TableStatus, TableStatus[]> = {
  available: ["occupied"],
  occupied: ["bill_requested", "available"],
  bill_requested: ["cleaning", "available"],
  cleaning: ["available"],
};

export class TableService {
  constructor(private db: Db) {}

  // ─── CRUD ──────────────────────────────────────────────────────────

  async create(orgId: string, input: {
    number: string;
    zone: string;
    capacity?: number;
    minimumSeats?: number;
    shape?: "rectangle" | "square" | "circle";
    isTakeaway?: boolean;
    layoutX?: number;
    layoutY?: number;
  }): Promise<PluginResult<Table>> {
    // Check for duplicate number in org
    const existing = await this.db
      .select()
      .from(posTables)
      .where(and(eq(posTables.organizationId, orgId), eq(posTables.number, input.number)));

    if (existing.length > 0) return Err(`Table '${input.number}' already exists`);

    const rows = await this.db
      .insert(posTables)
      .values({
        organizationId: orgId,
        number: input.number,
        zone: input.zone,
        capacity: input.capacity ?? 4,
        minimumSeats: input.minimumSeats ?? 1,
        shape: input.shape ?? "rectangle",
        isTakeaway: input.isTakeaway ?? false,
        layoutX: input.layoutX ?? 0,
        layoutY: input.layoutY ?? 0,
      })
      .returning();

    return Ok(rows[0]!);
  }

  async list(orgId: string, zone?: string): Promise<PluginResult<Table[]>> {
    const conditions = [eq(posTables.organizationId, orgId)];
    if (zone) conditions.push(eq(posTables.zone, zone));

    const rows = await this.db
      .select()
      .from(posTables)
      .where(and(...conditions))
      .orderBy(posTables.number);

    return Ok(rows);
  }

  async getById(orgId: string, id: string): Promise<PluginResult<Table>> {
    const rows = await this.db
      .select()
      .from(posTables)
      .where(and(eq(posTables.id, id), eq(posTables.organizationId, orgId)));

    if (rows.length === 0) return Err("Table not found");
    return Ok(rows[0]!);
  }

  async update(orgId: string, id: string, input: {
    number?: string;
    zone?: string;
    capacity?: number;
    shape?: "rectangle" | "square" | "circle";
    assignedOperatorId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<PluginResult<Table>> {
    const rows = await this.db
      .update(posTables)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(posTables.id, id), eq(posTables.organizationId, orgId)))
      .returning();

    if (rows.length === 0) return Err("Table not found");
    return Ok(rows[0]!);
  }

  // ─── Status Management ─────────────────────────────────────────────

  async setStatus(orgId: string, id: string, newStatus: TableStatus): Promise<PluginResult<Table>> {
    const table = await this.getById(orgId, id);
    if (!table.ok) return table;

    const current = table.value.status as TableStatus;
    const allowed = VALID_TRANSITIONS[current];
    if (!allowed?.includes(newStatus)) {
      return Err(`Cannot transition table from '${current}' to '${newStatus}'`);
    }

    const rows = await this.db
      .update(posTables)
      .set({ status: newStatus, updatedAt: new Date() })
      .where(eq(posTables.id, id))
      .returning();

    return Ok(rows[0]!);
  }

  // ─── Assignment ────────────────────────────────────────────────────
  // Links a table to a POS transaction. Sets table status to "occupied".
  // URY equivalent: sync_order() setting occupied=1 + latest_invoice_time.

  async assignToTransaction(orgId: string, tableId: string, transactionId: string): Promise<PluginResult<TableAssignment>> {
    // Lock the table row to prevent concurrent double-seating
    const locked = await this.db
      .select()
      .from(posTables)
      .where(and(eq(posTables.id, tableId), eq(posTables.organizationId, orgId)))
      .for("update");

    if (locked.length === 0) return Err("Table not found");
    const table = locked[0]!;
    if (table.status !== "available") {
      return Err(`Table '${table.number}' is not available (current: ${table.status})`);
    }

    // Set table to occupied (under lock — no race condition)
    await this.db
      .update(posTables)
      .set({ status: "occupied", updatedAt: new Date() })
      .where(eq(posTables.id, tableId));

    // Create assignment
    const rows = await this.db
      .insert(posTableAssignments)
      .values({ tableId, transactionId, seatedAt: new Date() })
      .returning();

    return Ok(rows[0]!);
  }

  // ─── Clear ─────────────────────────────────────────────────────────
  // Clears a table: removes assignments and sets status to "available".

  async clear(orgId: string, tableId: string): Promise<PluginResult<Table>> {
    // Delete assignments
    await this.db
      .delete(posTableAssignments)
      .where(eq(posTableAssignments.tableId, tableId));

    // Set available
    const rows = await this.db
      .update(posTables)
      .set({ status: "available", updatedAt: new Date() })
      .where(and(eq(posTables.id, tableId), eq(posTables.organizationId, orgId)))
      .returning();

    if (rows.length === 0) return Err("Table not found");
    return Ok(rows[0]!);
  }

  // ─── Transfer ──────────────────────────────────────────────────────
  // Moves a transaction from one table to another.
  // URY equivalent: table_transfer() — validates same room, target not occupied.
  // We validate same zone (our equivalent of URY's room).

  async transfer(orgId: string, fromTableId: string, toTableId: string): Promise<PluginResult<{ from: Table; to: Table }>> {
    const fromTable = await this.getById(orgId, fromTableId);
    if (!fromTable.ok) return fromTable;

    const toTable = await this.getById(orgId, toTableId);
    if (!toTable.ok) return toTable;

    // Same zone required (URY: same room)
    if (fromTable.value.zone !== toTable.value.zone) {
      return Err(`Cannot transfer between different zones ('${fromTable.value.zone}' -> '${toTable.value.zone}')`);
    }

    // Target must be available
    if (toTable.value.status !== "available") {
      return Err(`Target table '${toTable.value.number}' is not available`);
    }

    // Move assignments
    await this.db
      .update(posTableAssignments)
      .set({ tableId: toTableId })
      .where(eq(posTableAssignments.tableId, fromTableId));

    // Update statuses
    await this.db.update(posTables).set({ status: "available", updatedAt: new Date() }).where(eq(posTables.id, fromTableId));
    await this.db.update(posTables).set({ status: "occupied", updatedAt: new Date() }).where(eq(posTables.id, toTableId));

    const updatedFrom = (await this.getById(orgId, fromTableId)).ok ? (await this.getById(orgId, fromTableId)) : fromTable;
    const updatedTo = (await this.getById(orgId, toTableId)).ok ? (await this.getById(orgId, toTableId)) : toTable;

    if (!updatedFrom.ok || !updatedTo.ok) return Err("Transfer failed");
    return Ok({ from: updatedFrom.value, to: updatedTo.value });
  }

  // ─── Layout ────────────────────────────────────────────────────────
  // Updates floor plan position. URY equivalent: updateTableLayout() in table-api.ts.

  async updateLayout(orgId: string, id: string, layout: {
    layoutX?: number;
    layoutY?: number;
    layoutWidth?: number;
    layoutHeight?: number;
  }): Promise<PluginResult<Table>> {
    const rows = await this.db
      .update(posTables)
      .set({ ...layout, updatedAt: new Date() })
      .where(and(eq(posTables.id, id), eq(posTables.organizationId, orgId)))
      .returning();

    if (rows.length === 0) return Err("Table not found");
    return Ok(rows[0]!);
  }

  // ─── Zones ─────────────────────────────────────────────────────────

  async listZones(orgId: string): Promise<PluginResult<Array<{ zone: string; count: number }>>> {
    const rows = await this.db
      .select({
        zone: posTables.zone,
        count: sql<number>`COUNT(*)`.as("count"),
      })
      .from(posTables)
      .where(eq(posTables.organizationId, orgId))
      .groupBy(posTables.zone);

    return Ok(rows.map((r) => ({ zone: r.zone, count: Number(r.count) })));
  }
}
