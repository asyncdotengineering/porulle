import { eq, and, asc } from "drizzle-orm";
import type { TxContext } from "../../../kernel/database/tx-context.js";
import type {
  DrizzleDatabase,
  DbOrTx,
} from "../../../kernel/database/drizzle-db.js";
import { shippingZones, shippingRates } from "../schema.js";

export type ShippingZone = typeof shippingZones.$inferSelect;
export type ShippingZoneInsert = typeof shippingZones.$inferInsert;
export type ShippingRate = typeof shippingRates.$inferSelect;
export type ShippingRateInsert = typeof shippingRates.$inferInsert;

/**
 * Persistence for runtime shipping zones & rates (issue #45).
 */
export class ShippingConfigRepository {
  constructor(private readonly db: DrizzleDatabase) {}

  private getDb(ctx?: TxContext): DbOrTx {
    return (ctx?.tx as DbOrTx | undefined) ?? this.db;
  }

  // ── Zones ──────────────────────────────────────────────────────────────

  async findZoneById(orgId: string, id: string, ctx?: TxContext): Promise<ShippingZone | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(shippingZones)
      .where(and(eq(shippingZones.organizationId, orgId), eq(shippingZones.id, id)));
    return rows[0];
  }

  async findZones(orgId: string, ctx?: TxContext): Promise<ShippingZone[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(shippingZones)
      .where(eq(shippingZones.organizationId, orgId))
      .orderBy(asc(shippingZones.priority));
  }

  async findActiveZones(orgId: string, ctx?: TxContext): Promise<ShippingZone[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(shippingZones)
      .where(and(eq(shippingZones.organizationId, orgId), eq(shippingZones.isActive, true)))
      .orderBy(asc(shippingZones.priority));
  }

  async createZone(data: ShippingZoneInsert, ctx?: TxContext): Promise<ShippingZone> {
    const db = this.getDb(ctx);
    const rows = await db.insert(shippingZones).values(data).returning();
    return rows[0]!;
  }

  async updateZone(
    id: string,
    data: Partial<Omit<ShippingZoneInsert, "id" | "organizationId">>,
    ctx?: TxContext,
  ): Promise<ShippingZone | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .update(shippingZones)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(shippingZones.id, id))
      .returning();
    return rows[0];
  }

  async deleteZone(id: string, ctx?: TxContext): Promise<boolean> {
    const db = this.getDb(ctx);
    const rows = await db.delete(shippingZones).where(eq(shippingZones.id, id)).returning();
    return rows.length > 0;
  }

  // ── Rates ──────────────────────────────────────────────────────────────

  async findRateById(orgId: string, id: string, ctx?: TxContext): Promise<ShippingRate | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(shippingRates)
      .where(and(eq(shippingRates.organizationId, orgId), eq(shippingRates.id, id)));
    return rows[0];
  }

  async findRates(
    orgId: string,
    filter?: { zoneId?: string },
    ctx?: TxContext,
  ): Promise<ShippingRate[]> {
    const db = this.getDb(ctx);
    const conditions = [eq(shippingRates.organizationId, orgId)];
    if (filter?.zoneId) conditions.push(eq(shippingRates.zoneId, filter.zoneId));
    return db
      .select()
      .from(shippingRates)
      .where(and(...conditions))
      .orderBy(asc(shippingRates.amount));
  }

  async findActiveRatesByZoneId(zoneId: string, ctx?: TxContext): Promise<ShippingRate[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(shippingRates)
      .where(and(eq(shippingRates.zoneId, zoneId), eq(shippingRates.isActive, true)))
      .orderBy(asc(shippingRates.amount));
  }

  async createRate(data: ShippingRateInsert, ctx?: TxContext): Promise<ShippingRate> {
    const db = this.getDb(ctx);
    const rows = await db.insert(shippingRates).values(data).returning();
    return rows[0]!;
  }

  async updateRate(
    id: string,
    data: Partial<Omit<ShippingRateInsert, "id" | "organizationId">>,
    ctx?: TxContext,
  ): Promise<ShippingRate | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .update(shippingRates)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(shippingRates.id, id))
      .returning();
    return rows[0];
  }

  async deleteRate(id: string, ctx?: TxContext): Promise<boolean> {
    const db = this.getDb(ctx);
    const rows = await db.delete(shippingRates).where(eq(shippingRates.id, id)).returning();
    return rows.length > 0;
  }
}
