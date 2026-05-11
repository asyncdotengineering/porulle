import { eq, and } from "@porulle/core/drizzle";
import { Ok, Err } from "@porulle/core";
import type { PluginResult } from "@porulle/core";
import { wishlistItems } from "../schema.js";
import type { Db, WishlistItem } from "../types.js";

export class WishlistService {
  constructor(private db: Db) {}

  async list(orgId: string, userId: string): Promise<PluginResult<WishlistItem[]>> {
    const rows = await this.db.select().from(wishlistItems)
      .where(and(eq(wishlistItems.organizationId, orgId), eq(wishlistItems.userId, userId)));
    return Ok(rows);
  }

  async add(orgId: string, userId: string, input: {
    entityId: string; note?: string;
  }): Promise<PluginResult<WishlistItem>> {
    // Check duplicate
    const existing = await this.db.select().from(wishlistItems)
      .where(and(
        eq(wishlistItems.organizationId, orgId),
        eq(wishlistItems.userId, userId),
        eq(wishlistItems.entityId, input.entityId),
      ));
    if (existing.length > 0) return Err("Item already in wishlist");

    const rows = await this.db.insert(wishlistItems).values({
      organizationId: orgId, userId, entityId: input.entityId, note: input.note,
    }).returning();
    return Ok(rows[0]!);
  }

  async remove(orgId: string, userId: string, itemId: string): Promise<PluginResult<{ deleted: boolean }>> {
    const rows = await this.db.delete(wishlistItems)
      .where(and(
        eq(wishlistItems.id, itemId),
        eq(wishlistItems.organizationId, orgId),
        eq(wishlistItems.userId, userId),
      )).returning();
    if (rows.length === 0) return Err("Item not found");
    return Ok({ deleted: true });
  }

  async removeByEntity(orgId: string, userId: string, entityId: string): Promise<PluginResult<{ deleted: boolean }>> {
    const rows = await this.db.delete(wishlistItems)
      .where(and(
        eq(wishlistItems.organizationId, orgId),
        eq(wishlistItems.userId, userId),
        eq(wishlistItems.entityId, entityId),
      )).returning();
    if (rows.length === 0) return Err("Item not found");
    return Ok({ deleted: true });
  }
}
