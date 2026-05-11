/**
 * ModifierService — CRUD and validation for item modifier groups and options.
 *
 * URY uses a flat "Item Add On" child table with no grouping, no required/optional
 * flags, no min/max constraints, and no price adjustments. This service implements
 * structured modifier groups with full constraint validation.
 *
 * Validation logic (used by cart.beforeAddItem hook):
 * - Required groups must have at least minSelect selections
 * - No group may exceed maxSelect selections
 * - Unavailable options are rejected
 * - Price adjustments are summed and returned for line item total calculation
 */

import { eq, and, desc } from "@porulle/core/drizzle";
import { Ok, Err } from "@porulle/core";
import type { PluginResult } from "@porulle/core";
import { posModifierGroups, posModifierOptions } from "../schema.js";
import type { Db, ModifierGroup, ModifierOption } from "../types.js";

export class ModifierService {
  constructor(private db: Db) {}

  // ─── Group CRUD ────────────────────────────────────────────────────

  async createGroup(orgId: string, input: {
    name: string;
    entityId?: string;
    itemGroup?: string;
    isRequired?: boolean;
    minSelect?: number;
    maxSelect?: number;
    sortOrder?: number;
  }): Promise<PluginResult<ModifierGroup>> {
    if (input.minSelect != null && input.maxSelect != null && input.minSelect > input.maxSelect) {
      return Err("minSelect cannot exceed maxSelect");
    }

    const rows = await this.db
      .insert(posModifierGroups)
      .values({
        organizationId: orgId,
        name: input.name,
        entityId: input.entityId,
        itemGroup: input.itemGroup,
        isRequired: input.isRequired ?? false,
        minSelect: input.minSelect ?? 0,
        maxSelect: input.maxSelect ?? 1,
        sortOrder: input.sortOrder ?? 0,
      })
      .returning();

    return Ok(rows[0]!);
  }

  async listGroups(orgId: string, entityId?: string): Promise<PluginResult<ModifierGroup[]>> {
    const conditions = [eq(posModifierGroups.organizationId, orgId)];
    if (entityId) conditions.push(eq(posModifierGroups.entityId, entityId));

    const rows = await this.db
      .select()
      .from(posModifierGroups)
      .where(and(...conditions))
      .orderBy(posModifierGroups.sortOrder);

    return Ok(rows);
  }

  async getGroupWithOptions(orgId: string, groupId: string): Promise<PluginResult<{
    group: ModifierGroup;
    options: ModifierOption[];
  }>> {
    const groups = await this.db
      .select()
      .from(posModifierGroups)
      .where(and(eq(posModifierGroups.id, groupId), eq(posModifierGroups.organizationId, orgId)));

    if (groups.length === 0) return Err("Modifier group not found");

    const options = await this.db
      .select()
      .from(posModifierOptions)
      .where(eq(posModifierOptions.groupId, groupId))
      .orderBy(posModifierOptions.sortOrder);

    return Ok({ group: groups[0]!, options });
  }

  async updateGroup(orgId: string, groupId: string, input: {
    name?: string;
    isRequired?: boolean;
    minSelect?: number;
    maxSelect?: number;
    sortOrder?: number;
  }): Promise<PluginResult<ModifierGroup>> {
    const rows = await this.db
      .update(posModifierGroups)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(posModifierGroups.id, groupId), eq(posModifierGroups.organizationId, orgId)))
      .returning();

    if (rows.length === 0) return Err("Modifier group not found");
    return Ok(rows[0]!);
  }

  async deleteGroup(orgId: string, groupId: string): Promise<PluginResult<{ deleted: boolean }>> {
    const rows = await this.db
      .delete(posModifierGroups)
      .where(and(eq(posModifierGroups.id, groupId), eq(posModifierGroups.organizationId, orgId)))
      .returning();

    if (rows.length === 0) return Err("Modifier group not found");
    return Ok({ deleted: true });
  }

  // ─── Option CRUD ───────────────────────────────────────────────────

  async addOption(groupId: string, input: {
    name: string;
    priceAdjustment?: number;
    isDefault?: boolean;
    sortOrder?: number;
  }): Promise<PluginResult<ModifierOption>> {
    const rows = await this.db
      .insert(posModifierOptions)
      .values({
        groupId,
        name: input.name,
        priceAdjustment: input.priceAdjustment ?? 0,
        isDefault: input.isDefault ?? false,
        sortOrder: input.sortOrder ?? 0,
      })
      .returning();

    return Ok(rows[0]!);
  }

  async updateOption(optionId: string, input: {
    name?: string;
    priceAdjustment?: number;
    isDefault?: boolean;
    isAvailable?: boolean;
    sortOrder?: number;
  }): Promise<PluginResult<ModifierOption>> {
    const rows = await this.db
      .update(posModifierOptions)
      .set(input)
      .where(eq(posModifierOptions.id, optionId))
      .returning();

    if (rows.length === 0) return Err("Modifier option not found");
    return Ok(rows[0]!);
  }

  async deleteOption(optionId: string): Promise<PluginResult<{ deleted: boolean }>> {
    const rows = await this.db
      .delete(posModifierOptions)
      .where(eq(posModifierOptions.id, optionId))
      .returning();

    if (rows.length === 0) return Err("Modifier option not found");
    return Ok({ deleted: true });
  }

  // ─── Validation ────────────────────────────────────────────────────
  // Called by cart.beforeAddItem hook to validate modifier selections.

  async validateModifiers(orgId: string, entityId: string, selections: Array<{
    groupId: string;
    optionIds: string[];
  }>): Promise<PluginResult<{ totalAdjustment: number; validatedModifiers: Array<{ name: string; priceAdjustment: number }> }>> {
    // Get all modifier groups for this entity
    const groups = await this.db
      .select()
      .from(posModifierGroups)
      .where(and(
        eq(posModifierGroups.organizationId, orgId),
        eq(posModifierGroups.entityId, entityId),
      ));

    const selectionMap = new Map(selections.map((s) => [s.groupId, s.optionIds]));
    let totalAdjustment = 0;
    const validatedModifiers: Array<{ name: string; priceAdjustment: number }> = [];

    for (const group of groups) {
      const selectedOptionIds = selectionMap.get(group.id) ?? [];

      // Validate required groups
      if (group.isRequired && selectedOptionIds.length < group.minSelect) {
        return Err(`Required: select at least ${group.minSelect} from '${group.name}'`);
      }

      // Validate max selections
      if (selectedOptionIds.length > group.maxSelect) {
        return Err(`Maximum ${group.maxSelect} selections allowed for '${group.name}'`);
      }

      // Validate each selected option exists and is available
      if (selectedOptionIds.length > 0) {
        const options = await this.db
          .select()
          .from(posModifierOptions)
          .where(eq(posModifierOptions.groupId, group.id));

        const optionMap = new Map(options.map((o) => [o.id, o]));

        for (const optionId of selectedOptionIds) {
          const option = optionMap.get(optionId);
          if (!option) return Err(`Modifier option '${optionId}' not found in group '${group.name}'`);
          if (!option.isAvailable) return Err(`Modifier '${option.name}' is currently unavailable`);

          totalAdjustment += option.priceAdjustment;
          validatedModifiers.push({ name: option.name, priceAdjustment: option.priceAdjustment });
        }
      }
    }

    return Ok({ totalAdjustment, validatedModifiers });
  }

  // ─── Get Modifiers for Entity ──────────────────────────────────────
  // Returns all modifier groups with their options for a given entity.
  // Used by the POS frontend to render modifier selection UI.

  async getModifiersForEntity(orgId: string, entityId: string): Promise<PluginResult<Array<{
    group: ModifierGroup;
    options: ModifierOption[];
  }>>> {
    const groups = await this.db
      .select()
      .from(posModifierGroups)
      .where(and(
        eq(posModifierGroups.organizationId, orgId),
        eq(posModifierGroups.entityId, entityId),
      ))
      .orderBy(posModifierGroups.sortOrder);

    const result = [];
    for (const group of groups) {
      const options = await this.db
        .select()
        .from(posModifierOptions)
        .where(eq(posModifierOptions.groupId, group.id))
        .orderBy(posModifierOptions.sortOrder);

      result.push({ group, options });
    }

    return Ok(result);
  }
}
