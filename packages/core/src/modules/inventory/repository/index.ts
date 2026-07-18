import { eq, and, inArray, isNull, sql } from "drizzle-orm";
import { CommerceValidationError, INVENTORY_RECORD_NOT_FOUND_MESSAGE } from "../../../kernel/errors.js";
import type { TxContext } from "../../../kernel/database/tx-context.js";
import type {
  DrizzleDatabase,
  DbOrTx,
} from "../../../kernel/database/drizzle-db.js";
import { warehouses, inventoryLevels, inventoryMovements } from "../schema.js";

// Infer types from Drizzle schema
export type Warehouse = typeof warehouses.$inferSelect;
export type WarehouseInsert = typeof warehouses.$inferInsert;
export type InventoryLevel = typeof inventoryLevels.$inferSelect;
export type InventoryLevelInsert = typeof inventoryLevels.$inferInsert;
export type InventoryMovement = typeof inventoryMovements.$inferSelect;
export type InventoryMovementInsert = typeof inventoryMovements.$inferInsert;

/**
 * InventoryRepository provides type-safe database operations for inventory entities.
 *
 * This repository manages warehouses, inventory levels, and inventory movements.
 * All methods support an optional TxContext parameter for transaction participation.
 */
export class InventoryRepository {
  constructor(private readonly db: DrizzleDatabase) {}

  private getDb(ctx?: TxContext): DbOrTx {
    return (ctx?.tx as DbOrTx | undefined) ?? this.db;
  }

  private assertLevelOrg(level: InventoryLevel, organizationId: string): void {
    if (level.organizationId !== organizationId) {
      throw new CommerceValidationError("Inventory level organization mismatch.");
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Warehouses
  // ─────────────────────────────────────────────────────────────────────────────

  async findWarehouseById(
    organizationId: string,
    id: string,
    ctx?: TxContext,
  ): Promise<Warehouse | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(warehouses)
      .where(
        and(eq(warehouses.id, id), eq(warehouses.organizationId, organizationId)),
      );
    return rows[0];
  }

  async findWarehouseByCode(
    orgId: string,
    code: string,
    ctx?: TxContext,
  ): Promise<Warehouse | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(warehouses)
      .where(
        and(
          eq(warehouses.organizationId, orgId),
          eq(warehouses.code, code),
        ),
      );
    return rows[0];
  }

  async findAllWarehouses(
    orgId: string,
    ctx?: TxContext,
  ): Promise<Warehouse[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(warehouses)
      .where(eq(warehouses.organizationId, orgId));
  }

  async findActiveWarehouses(
    orgId: string,
    ctx?: TxContext,
  ): Promise<Warehouse[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(warehouses)
      .where(
        and(
          eq(warehouses.organizationId, orgId),
          eq(warehouses.isActive, true),
        ),
      );
  }

  async createWarehouse(
    data: WarehouseInsert,
    ctx?: TxContext,
  ): Promise<Warehouse> {
    const db = this.getDb(ctx);
    const rows = await db.insert(warehouses).values(data).returning();
    return rows[0]!;
  }

  async updateWarehouse(
    organizationId: string,
    id: string,
    data: Partial<Omit<WarehouseInsert, "id">>,
    ctx?: TxContext,
  ): Promise<Warehouse | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .update(warehouses)
      .set(data)
      .where(
        and(eq(warehouses.id, id), eq(warehouses.organizationId, organizationId)),
      )
      .returning();
    return rows[0];
  }

  async deleteWarehouse(
    organizationId: string,
    id: string,
    ctx?: TxContext,
  ): Promise<boolean> {
    const db = this.getDb(ctx);
    const result = await db
      .delete(warehouses)
      .where(
        and(eq(warehouses.id, id), eq(warehouses.organizationId, organizationId)),
      )
      .returning();
    return result.length > 0;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Inventory Levels
  // ─────────────────────────────────────────────────────────────────────────────

  async findAllLevels(
    organizationId: string,
    ctx?: TxContext,
  ): Promise<InventoryLevel[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(inventoryLevels)
      .where(eq(inventoryLevels.organizationId, organizationId));
  }

  async findLevelById(
    organizationId: string,
    id: string,
    ctx?: TxContext,
  ): Promise<InventoryLevel | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(inventoryLevels)
      .where(
        and(
          eq(inventoryLevels.id, id),
          eq(inventoryLevels.organizationId, organizationId),
        ),
      );
    return rows[0];
  }

  async findLevelByKey(
    organizationId: string,
    entityId: string,
    warehouseId: string,
    variantId?: string | null,
    ctx?: TxContext,
  ): Promise<InventoryLevel | undefined> {
    const db = this.getDb(ctx);
    const conditions = [
      eq(inventoryLevels.organizationId, organizationId),
      eq(inventoryLevels.entityId, entityId),
      eq(inventoryLevels.warehouseId, warehouseId),
    ];

    // Only add variantId condition when it's a real string value — never pass null to eq()
    if (variantId != null) {
      conditions.push(eq(inventoryLevels.variantId, variantId));
    }

    const rows = await db
      .select()
      .from(inventoryLevels)
      .where(and(...conditions));

    // Post-filter for exact variantId match (handles SQL NULL correctly)
    const level = rows.find((r) => r.variantId === (variantId ?? null));
    if (level) this.assertLevelOrg(level, organizationId);
    return level;
  }

  async findLevelsByEntityId(
    organizationId: string,
    entityId: string,
    ctx?: TxContext,
  ): Promise<InventoryLevel[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(inventoryLevels)
      .where(
        and(
          eq(inventoryLevels.entityId, entityId),
          eq(inventoryLevels.organizationId, organizationId),
        ),
      );
  }

  async findLevelsByEntityAndVariant(
    organizationId: string,
    entityId: string,
    variantId?: string | null,
    ctx?: TxContext,
  ): Promise<InventoryLevel[]> {
    const db = this.getDb(ctx);
    const conditions = [
      eq(inventoryLevels.organizationId, organizationId),
      eq(inventoryLevels.entityId, entityId),
    ];

    // Only add variantId condition when it's a real string value — never pass null to eq()
    if (variantId != null) {
      conditions.push(eq(inventoryLevels.variantId, variantId));
    }

    const rows = await db
      .select()
      .from(inventoryLevels)
      .where(and(...conditions));

    // Post-filter for exact variantId match (handles SQL NULL correctly in JS)
    return rows.filter((r) =>
      variantId == null ? r.variantId === null : r.variantId === variantId,
    );
  }

  async findLevelsByWarehouseId(
    organizationId: string,
    warehouseId: string,
    ctx?: TxContext,
  ): Promise<InventoryLevel[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(inventoryLevels)
      .where(
        and(
          eq(inventoryLevels.warehouseId, warehouseId),
          eq(inventoryLevels.organizationId, organizationId),
        ),
      );
  }

  async createLevel(
    data: InventoryLevelInsert,
    ctx?: TxContext,
  ): Promise<InventoryLevel> {
    const db = this.getDb(ctx);
    const rows = await db.insert(inventoryLevels).values(data).returning();
    return rows[0]!;
  }

  async updateLevel(
    organizationId: string,
    id: string,
    data: Partial<Omit<InventoryLevelInsert, "id">>,
    ctx?: TxContext,
  ): Promise<InventoryLevel | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .update(inventoryLevels)
      .set({
        ...data,
        updatedAt: new Date(),
        version: sql`${inventoryLevels.version} + 1`,
      })
      .where(
        and(
          eq(inventoryLevels.id, id),
          eq(inventoryLevels.organizationId, organizationId),
        ),
      )
      .returning();
    return rows[0];
  }

  async upsertLevel(
    organizationId: string,
    entityId: string,
    warehouseId: string,
    variantId: string | undefined,
    data: Omit<
      InventoryLevelInsert,
      "id" | "entityId" | "warehouseId" | "variantId" | "organizationId"
    >,
    ctx?: TxContext,
  ): Promise<InventoryLevel> {
    const existing = await this.findLevelByKey(
      organizationId,
      entityId,
      warehouseId,
      variantId,
      ctx,
    );
    if (existing) {
      const updated = await this.updateLevel(
        organizationId,
        existing.id,
        data,
        ctx,
      );
      return updated!;
    }
    return this.createLevel(
      {
        ...data,
        organizationId,
        entityId,
        warehouseId,
        ...(variantId !== undefined ? { variantId } : {}),
      },
      ctx,
    );
  }

  async deleteLevel(
    organizationId: string,
    id: string,
    ctx?: TxContext,
  ): Promise<boolean> {
    const db = this.getDb(ctx);
    const result = await db
      .delete(inventoryLevels)
      .where(
        and(
          eq(inventoryLevels.id, id),
          eq(inventoryLevels.organizationId, organizationId),
        ),
      )
      .returning();
    return result.length > 0;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Inventory Movements
  // ─────────────────────────────────────────────────────────────────────────────

  async findMovementById(
    organizationId: string,
    id: string,
    ctx?: TxContext,
  ): Promise<InventoryMovement | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.id, id),
          eq(inventoryMovements.organizationId, organizationId),
        ),
      );
    return rows[0];
  }

  async findMovementsByEntityId(
    organizationId: string,
    entityId: string,
    ctx?: TxContext,
  ): Promise<InventoryMovement[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.entityId, entityId),
          eq(inventoryMovements.organizationId, organizationId),
        ),
      );
  }

  async findMovementsByReference(
    organizationId: string,
    referenceType: string,
    referenceId: string,
    ctx?: TxContext,
  ): Promise<InventoryMovement[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.organizationId, organizationId),
          eq(inventoryMovements.referenceType, referenceType),
          eq(inventoryMovements.referenceId, referenceId),
        ),
      );
  }

  async createMovement(
    data: InventoryMovementInsert,
    ctx?: TxContext,
  ): Promise<InventoryMovement> {
    const db = this.getDb(ctx);
    const rows = await db.insert(inventoryMovements).values(data).returning();
    return rows[0]!;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Concurrency-Safe Operations (SELECT FOR UPDATE)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Issues SELECT ... FOR UPDATE on the inventory_levels row matching
   * the given entity, variant, and warehouse within the provided transaction.
   *
   * MUST be called inside an active transaction (ctx.tx must be set).
   * Calling outside a transaction provides no locking guarantee.
   *
   * Uses isNull() for null variantId instead of eq() to generate correct
   * SQL (IS NULL instead of = NULL).
   */
  async findLevelForUpdate(
    organizationId: string,
    entityId: string,
    variantId: string | null,
    warehouseId: string,
    ctx: TxContext,
  ): Promise<InventoryLevel | undefined> {
    const db = this.getDb(ctx);

    const conditions = [
      eq(inventoryLevels.organizationId, organizationId),
      eq(inventoryLevels.entityId, entityId),
      eq(inventoryLevels.warehouseId, warehouseId),
      variantId != null
        ? eq(inventoryLevels.variantId, variantId)
        : isNull(inventoryLevels.variantId),
    ];

    // Use raw SQL for FOR UPDATE since Drizzle's .for() may not be available
    // on all query builder paths. This is the most portable approach.
    const rows = await db
      .select()
      .from(inventoryLevels)
      .where(and(...conditions))
      .for("update");

    const level = rows[0];
    if (level) this.assertLevelOrg(level, organizationId);
    return level;
  }

  /**
   * Performs a read-modify-write under a row-level lock.
   * This is the ONLY correct method for modifying quantityReserved
   * in a concurrent environment. Must be called inside a transaction.
   *
   * The lock is held for the duration of the enclosing transaction,
   * which is typically just the checkout reservation — microsecond-level.
   */
  async reserveWithLock(
    organizationId: string,
    entityId: string,
    variantId: string | null,
    warehouseId: string,
    quantity: number,
    ctx: TxContext,
  ): Promise<
    { ok: true; level: InventoryLevel } | { ok: false; reason: string }
  > {
    const level = await this.findLevelForUpdate(
      organizationId,
      entityId,
      variantId,
      warehouseId,
      ctx,
    );

    if (!level) {
      return {
        ok: false,
        reason: INVENTORY_RECORD_NOT_FOUND_MESSAGE,
      };
    }

    const available = level.quantityOnHand - level.quantityReserved;
    if (available < quantity) {
      return {
        ok: false,
        reason: `Insufficient stock. Available: ${available}, requested: ${quantity}.`,
      };
    }

    const updated = await this.getDb(ctx)
      .update(inventoryLevels)
      .set({
        quantityReserved: level.quantityReserved + quantity,
        updatedAt: new Date(),
        version: level.version + 1,
      })
      .where(
        and(
          eq(inventoryLevels.id, level.id),
          eq(inventoryLevels.organizationId, organizationId),
        ),
      )
      .returning();

    return { ok: true, level: updated[0]! };
  }

  /**
   * Performs a release under a row-level lock, mirroring reserveWithLock.
   * Used by compensation chains to undo a reservation.
   */
  async releaseWithLock(
    organizationId: string,
    entityId: string,
    variantId: string | null,
    warehouseId: string,
    quantity: number,
    ctx: TxContext,
  ): Promise<
    { ok: true; level: InventoryLevel } | { ok: false; reason: string }
  > {
    const level = await this.findLevelForUpdate(
      organizationId,
      entityId,
      variantId,
      warehouseId,
      ctx,
    );

    if (!level) {
      return {
        ok: false,
        reason: INVENTORY_RECORD_NOT_FOUND_MESSAGE,
      };
    }

    const updated = await this.getDb(ctx)
      .update(inventoryLevels)
      .set({
        quantityReserved: Math.max(0, level.quantityReserved - quantity),
        updatedAt: new Date(),
        version: level.version + 1,
      })
      .where(
        and(
          eq(inventoryLevels.id, level.id),
          eq(inventoryLevels.organizationId, organizationId),
        ),
      )
      .returning();

    return { ok: true, level: updated[0]! };
  }

  /**
   * Performs an atomic quantity adjust under a row-level lock.
   * Uses SQL expressions for the increment so it is atomic even
   * when multiple operations share a single database connection
   * (e.g., PGlite test environments where SELECT FOR UPDATE
   * cannot block across "transactions" on the same connection).
   */
  async adjustWithLock(
    organizationId: string,
    entityId: string,
    variantId: string | null,
    warehouseId: string,
    adjustment: number,
    ctx: TxContext,
  ): Promise<
    { ok: true; level: InventoryLevel } | { ok: false; reason: string }
  > {
    const level = await this.findLevelForUpdate(
      organizationId,
      entityId,
      variantId,
      warehouseId,
      ctx,
    );

    if (!level) {
      return {
        ok: false,
        reason: INVENTORY_RECORD_NOT_FOUND_MESSAGE,
      };
    }

    const updated = await this.getDb(ctx)
      .update(inventoryLevels)
      .set({
        quantityOnHand: sql`GREATEST(0, ${inventoryLevels.quantityOnHand} + ${adjustment})`,
        updatedAt: new Date(),
        version: sql`${inventoryLevels.version} + 1`,
      })
      .where(
        and(
          eq(inventoryLevels.id, level.id),
          eq(inventoryLevels.organizationId, organizationId),
        ),
      )
      .returning();

    return { ok: true, level: updated[0]! };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Aggregate Queries
  // ─────────────────────────────────────────────────────────────────────────────

  async getAvailableQuantity(
    organizationId: string,
    entityId: string,
    variantId?: string | null,
    ctx?: TxContext,
  ): Promise<number> {
    const levels = await this.findLevelsByEntityAndVariant(
      organizationId,
      entityId,
      variantId,
      ctx,
    );
    return levels.reduce(
      (sum, level) => sum + (level.quantityOnHand - level.quantityReserved),
      0,
    );
  }

  async getAvailableQuantities(
    organizationId: string,
    entityIds: string[],
    ctx?: TxContext,
  ): Promise<Record<string, number>> {
    if (entityIds.length === 0) return {};

    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(inventoryLevels)
      .where(
        and(
          eq(inventoryLevels.organizationId, organizationId),
          inArray(inventoryLevels.entityId, entityIds),
        ),
      );

    const result: Record<string, number> = {};
    for (const id of entityIds) {
      result[id] = 0;
    }

    for (const row of rows) {
      const available = row.quantityOnHand - row.quantityReserved;
      result[row.entityId] = (result[row.entityId] ?? 0) + available;
    }

    return result;
  }
}
