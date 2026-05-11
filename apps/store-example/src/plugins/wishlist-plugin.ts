/**
 * Wishlist Plugin — demonstrates router() with auth + permissions.
 *
 * - .auth() enforces login — handler gets guaranteed non-null actor
 * - .permission("wishlist:admin") enforces specific scope
 * - Plugin declares its permissions in the manifest
 */

import { defineCommercePlugin, router } from "@porulle/core";
import type { PluginContext } from "@porulle/core";
import { z } from "@hono/zod-openapi";
import { eq, and } from "@porulle/core/drizzle";
import { wishlistItems } from "./wishlist-schema.js";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const AddItemSchema = z.object({
  entityId: z.uuid(),
  note: z.string().max(500).optional(),
}).openapi("AddWishlistItem");

type AddItemInput = z.infer<typeof AddItemSchema>;

// ─── Routes ──────────────────────────────────────────────────────────────────

function buildRoutes(ctx: PluginContext) {
  const { db } = ctx.database;
  const wishlist = router("Wishlist", "/wishlist");

  // .auth() — requires login, returns 401 if not authenticated
  wishlist.get("/")
    .summary("List my wishlist items")
    .auth()
    .handler(async ({ actor }) => {
      // actor is guaranteed non-null by .auth()
      return db.select().from(wishlistItems).where(eq(wishlistItems.customerId, actor!.userId));
    });

  // .auth() + .input() — login required + body validated
  wishlist.post("/")
    .summary("Add item to wishlist")
    .auth()
    .input(AddItemSchema)
    .handler(async ({ input, actor }) => {
      const body = input as AddItemInput;
      const [item] = await db.insert(wishlistItems).values({
        customerId: actor!.userId,
        entityId: body.entityId,
        note: body.note ?? null,
      }).returning();
      return item;
    });

  // .permission("wishlist:admin") — requires login + specific permission
  wishlist.delete("/{id}")
    .summary("Remove a wishlist item (admin)")
    .permission("wishlist:admin")
    .handler(async ({ params }) => {
      const id = params.id;
      if (!id) throw new Error("Missing id");
      await db.delete(wishlistItems).where(eq(wishlistItems.id, id));
      return { deleted: true };
    });

  return wishlist.routes();
}

// ─── Plugin Export ───────────────────────────────────────────────────────────

export function wishlistPlugin() {
  return defineCommercePlugin({
    id: "wishlist",
    version: "1.0.0",

    // Declare the permissions this plugin introduces
    permissions: [
      { scope: "wishlist:read", description: "View wishlist items" },
      { scope: "wishlist:write", description: "Add/remove own wishlist items" },
      { scope: "wishlist:admin", description: "Manage any user's wishlist" },
    ],

    schema: () => ({ wishlistItems }),
    routes: (ctx) => buildRoutes(ctx),
  });
}
