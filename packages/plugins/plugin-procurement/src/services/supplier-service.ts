import { eq, and } from "@porulle/core/drizzle";
import { Ok, Err } from "@porulle/core";
import type { PluginResult, PluginResultErr } from "@porulle/core";
import { suppliers, supplierItems } from "../schema.js";
import type { Db, Supplier, SupplierItem } from "../types.js";

export class SupplierService {
  constructor(private db: Db) {}

  async create(orgId: string, input: {
    name: string; code: string; contactName?: string; contactEmail?: string;
    contactPhone?: string; paymentTermsDays?: number; currency?: string;
  }): Promise<PluginResult<Supplier>> {
    const existing = await this.db.select().from(suppliers)
      .where(and(eq(suppliers.organizationId, orgId), eq(suppliers.code, input.code)));
    if (existing.length > 0) return Err(`Supplier code '${input.code}' already exists`);
    const rows = await this.db.insert(suppliers).values({ organizationId: orgId, ...input }).returning();
    return Ok(rows[0]!);
  }

  async list(orgId: string): Promise<PluginResult<Supplier[]>> {
    const rows = await this.db.select().from(suppliers).where(eq(suppliers.organizationId, orgId));
    return Ok(rows);
  }

  async getById(orgId: string, id: string): Promise<PluginResult<{ supplier: Supplier; items: SupplierItem[] }>> {
    const rows = await this.db.select().from(suppliers).where(and(eq(suppliers.id, id), eq(suppliers.organizationId, orgId)));
    if (rows.length === 0) return Err("Supplier not found");
    const items = await this.db.select().from(supplierItems).where(eq(supplierItems.supplierId, id));
    return Ok({ supplier: rows[0]!, items });
  }

  async addItem(supplierId: string, input: {
    entityId: string; variantId?: string; supplierSku?: string; unitCost: number;
    minOrderQuantity?: number; leadTimeDays?: number; isPreferred?: boolean;
  }): Promise<PluginResult<SupplierItem>> {
    const rows = await this.db.insert(supplierItems).values({ supplierId, ...input }).returning();
    return Ok(rows[0]!);
  }
}
