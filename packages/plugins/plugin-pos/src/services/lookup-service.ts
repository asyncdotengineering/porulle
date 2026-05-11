import { eq, and } from "@porulle/core/drizzle";
import { Ok, Err } from "@porulle/core";
import type { PluginResult } from "@porulle/core";
import { variants, sellableEntities } from "@porulle/core/schema";
import type { Db } from "../types.js";

export interface LookupResult {
  entityId: string;
  variantId: string;
  entityType: string;
  slug: string;
  barcode: string | null;
  sku: string | null;
  title?: string | undefined;
  price?: number | undefined;
}

/**
 * Item lookup service for POS.
 * Uses indexed queries on variants.barcode and variants.sku.
 *
 * Depends on core schema tables (variants, sellable_entities, entity_attributes)
 * accessed via the scoped DB proxy.
 */
export class LookupService {
  constructor(
    private db: Db,
    private services: Record<string, unknown>,
  ) {}

  /**
   * Find entity + variant by barcode. Single indexed query.
   */
  async byBarcode(orgId: string, barcode: string): Promise<PluginResult<LookupResult>> {

    const rows = await this.db
      .select({
        variantId: variants.id,
        entityId: variants.entityId,
        barcode: variants.barcode,
        sku: variants.sku,
        entityType: sellableEntities.type,
        slug: sellableEntities.slug,
        orgId: sellableEntities.organizationId,
      })
      .from(variants)
      .innerJoin(sellableEntities, eq(variants.entityId, sellableEntities.id))
      .where(and(
        eq(variants.barcode, barcode),
        eq(sellableEntities.organizationId, orgId),
      ))
      .limit(1);

    if (rows.length === 0) return Err("No item found for barcode");

    const row = rows[0]!;
    return Ok({
      entityId: row.entityId,
      variantId: row.variantId,
      entityType: row.entityType,
      slug: row.slug,
      barcode: row.barcode,
      sku: row.sku,
    });
  }

  /**
   * Find entity + variant by SKU. Single indexed query.
   */
  async bySku(orgId: string, sku: string): Promise<PluginResult<LookupResult>> {
    const rows = await this.db
      .select({
        variantId: variants.id,
        entityId: variants.entityId,
        barcode: variants.barcode,
        sku: variants.sku,
        entityType: sellableEntities.type,
        slug: sellableEntities.slug,
        orgId: sellableEntities.organizationId,
      })
      .from(variants)
      .innerJoin(sellableEntities, eq(variants.entityId, sellableEntities.id))
      .where(and(
        eq(variants.sku, sku),
        eq(sellableEntities.organizationId, orgId),
      ))
      .limit(1);

    if (rows.length === 0) return Err("No item found for SKU");

    const row = rows[0]!;
    return Ok({
      entityId: row.entityId,
      variantId: row.variantId,
      entityType: row.entityType,
      slug: row.slug,
      barcode: row.barcode,
      sku: row.sku,
    });
  }

  /**
   * Quick text search across entity attributes (name, title).
   * Delegates to the core search service.
   */
  async search(orgId: string, query: string): Promise<PluginResult<LookupResult[]>> {
    const searchService = this.services.search as {
      search: (params: { query: string; organizationId?: string; limit?: number }) => Promise<{
        ok: boolean;
        value?: { results: Array<{ entityId: string; type: string; slug: string; title?: string }> };
      }>;
    } | undefined;

    if (!searchService) {
      return Ok([]);
    }

    const result = await searchService.search({
      query,
      organizationId: orgId,
      limit: 20,
    });

    if (!result.ok || !result.value) return Ok([]);

    return Ok(result.value.results.map((r): LookupResult => ({
      entityId: r.entityId,
      variantId: "",
      entityType: r.type,
      slug: r.slug,
      barcode: null,
      sku: null,
      title: r.title ?? undefined,
    })));
  }
}
