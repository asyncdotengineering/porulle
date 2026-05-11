/**
 * ChecklistService — Pre-billing compliance checklists.
 *
 * URY: Pre-billing checklists enforce compliance (stock check, hygiene).
 * validate_invoice_print() blocks billing until checklist complete.
 *
 * Checklists can be of type:
 * - pre_billing: must complete before printing a bill
 * - shift_open: must complete when opening a shift
 * - shift_close: must complete when closing a shift
 */

import { eq, and } from "@porulle/core/drizzle";
import { Ok, Err } from "@porulle/core";
import type { PluginResult } from "@porulle/core";
import { posChecklists, posChecklistItems, posChecklistCompletions } from "../schema.js";
import type { Db } from "../types.js";

type ChecklistType = "pre_billing" | "shift_open" | "shift_close";

export class ChecklistService {
  constructor(private db: Db) {}

  async createChecklist(orgId: string, input: {
    name: string;
    type: ChecklistType;
    items: Array<{ label: string; isRequired?: boolean }>;
  }): Promise<PluginResult<{ id: string; name: string; type: string; items: Array<{ id: string; label: string }> }>> {
    const rows = await this.db
      .insert(posChecklists)
      .values({ organizationId: orgId, name: input.name, type: input.type })
      .returning();
    const checklist = rows[0]!;

    const itemRows = [];
    for (let i = 0; i < input.items.length; i++) {
      const item = input.items[i]!;
      const inserted = await this.db
        .insert(posChecklistItems)
        .values({
          checklistId: checklist.id,
          label: item.label,
          isRequired: item.isRequired ?? true,
          sortOrder: i,
        })
        .returning();
      itemRows.push(inserted[0]!);
    }

    return Ok({
      id: checklist.id,
      name: checklist.name,
      type: checklist.type,
      items: itemRows.map((r) => ({ id: r.id, label: r.label })),
    });
  }

  async listChecklists(orgId: string, type?: ChecklistType): Promise<PluginResult<Array<{ id: string; name: string; type: string; isActive: boolean }>>> {
    const conditions = [eq(posChecklists.organizationId, orgId)];
    if (type) conditions.push(eq(posChecklists.type, type));

    const rows = await this.db
      .select()
      .from(posChecklists)
      .where(and(...conditions))
      .orderBy(posChecklists.sortOrder);

    return Ok(rows.map((r) => ({ id: r.id, name: r.name, type: r.type, isActive: r.isActive })));
  }

  async getChecklistWithItems(checklistId: string, orgId?: string): Promise<PluginResult<{
    id: string;
    name: string;
    type: string;
    items: Array<{ id: string; label: string; isRequired: boolean }>;
  }>> {
    const conditions = [eq(posChecklists.id, checklistId)];
    if (orgId) conditions.push(eq(posChecklists.organizationId, orgId));
    const checklists = await this.db.select().from(posChecklists).where(and(...conditions));
    if (checklists.length === 0) return Err("Checklist not found");

    const items = await this.db
      .select()
      .from(posChecklistItems)
      .where(eq(posChecklistItems.checklistId, checklistId))
      .orderBy(posChecklistItems.sortOrder);

    return Ok({
      id: checklists[0]!.id,
      name: checklists[0]!.name,
      type: checklists[0]!.type,
      items: items.map((i) => ({ id: i.id, label: i.label, isRequired: i.isRequired })),
    });
  }

  async completeChecklist(input: {
    checklistId: string;
    referenceType: "transaction" | "shift";
    referenceId: string;
    operatorId: string;
    completedItems: Array<{ itemId: string; checked: boolean; note?: string }>;
  }): Promise<PluginResult<{ completed: boolean }>> {
    // Validate all required items are checked
    const items = await this.db
      .select()
      .from(posChecklistItems)
      .where(eq(posChecklistItems.checklistId, input.checklistId));

    const requiredItems = items.filter((i) => i.isRequired);
    for (const required of requiredItems) {
      const completion = input.completedItems.find((c) => c.itemId === required.id);
      if (!completion || !completion.checked) {
        return Err(`Required checklist item '${required.label}' is not checked`);
      }
    }

    await this.db.insert(posChecklistCompletions).values({
      checklistId: input.checklistId,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      operatorId: input.operatorId,
      completedItems: input.completedItems,
    });

    return Ok({ completed: true });
  }

  async isChecklistCompleted(checklistId: string, referenceType: string, referenceId: string): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(posChecklistCompletions)
      .where(and(
        eq(posChecklistCompletions.checklistId, checklistId),
        eq(posChecklistCompletions.referenceType, referenceType as "transaction" | "shift"),
        eq(posChecklistCompletions.referenceId, referenceId),
      ));
    return rows.length > 0;
  }
}
