import { eq, and, sql } from "@porulle/core/drizzle";
import { Ok, Err } from "@porulle/core";
import type { PluginResult } from "@porulle/core";
import { wastageNotes, wastageNoteItems } from "../schema.js";
import type { Db, WastageNote, WastageNoteItem } from "../types.js";

export class WastageService {
  constructor(private db: Db) {}

  async create(orgId: string, input: {
    warehouseId: string; type: "spoilage" | "damage" | "expiry" | "theft" | "prep_waste" | "other";
    recordedBy: string; notes?: string;
    items: Array<{ entityId: string; variantId?: string; itemName: string; quantity: number; unitCost: number; reason?: string; batchNumber?: string }>;
  }): Promise<PluginResult<WastageNote>> {
    let totalCost = 0;
    for (const item of input.items) totalCost += item.quantity * item.unitCost;

    const noteNumber = await this.generateNumber(orgId);
    const rows = await this.db.insert(wastageNotes).values({
      organizationId: orgId, noteNumber, warehouseId: input.warehouseId,
      type: input.type, recordedBy: input.recordedBy, totalCost, notes: input.notes,
    }).returning();
    const note = rows[0]!;

    for (const item of input.items) {
      await this.db.insert(wastageNoteItems).values({
        noteId: note.id, entityId: item.entityId, variantId: item.variantId,
        itemName: item.itemName, quantity: item.quantity, unitCost: item.unitCost,
        totalCost: item.quantity * item.unitCost, reason: item.reason, batchNumber: item.batchNumber,
      });
    }
    return Ok(note);
  }

  async list(orgId: string): Promise<PluginResult<WastageNote[]>> {
    return Ok(await this.db.select().from(wastageNotes).where(eq(wastageNotes.organizationId, orgId)));
  }

  async approve(orgId: string, id: string, approvedBy: string): Promise<PluginResult<WastageNote>> {
    const rows = await this.db.update(wastageNotes).set({ approvedBy })
      .where(and(eq(wastageNotes.id, id), eq(wastageNotes.organizationId, orgId))).returning();
    if (rows.length === 0) return Err("Wastage note not found");
    return Ok(rows[0]!);
  }

  private async generateNumber(orgId: string): Promise<string> {
    const countRows = await this.db.select({ count: sql<number>`COUNT(*)`.as("count") }).from(wastageNotes).where(eq(wastageNotes.organizationId, orgId));
    return `WST-${String(Number(countRows[0]?.count ?? 0) + 1).padStart(4, "0")}`;
  }
}
