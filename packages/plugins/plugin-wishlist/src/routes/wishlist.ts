import { router } from "@porulle/core";
import { z } from "@hono/zod-openapi";
import type { WishlistService } from "../services/wishlist-service.js";
import type { PluginRouteRegistration } from "@porulle/core";

export function buildWishlistRoutes(
  service: WishlistService,
  ctx: { services?: Record<string, unknown>; database?: { db: unknown } },
): PluginRouteRegistration[] {
  const r = router("Wishlist", "/wishlist", ctx);

  r.get("/").summary("List my wishlist").auth()
    .handler(async ({ actor, orgId }) => {
      const result = await service.list(orgId, actor!.userId);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/").summary("Add to wishlist").auth()
    .input(z.object({ entityId: z.string().uuid(), note: z.string().max(500).optional() }))
    .handler(async ({ input, actor, orgId }) => {
      const body = input as { entityId: string; note?: string };
      const result = await service.add(orgId, actor!.userId, body);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.delete("/{id}").summary("Remove from wishlist").auth()
    .handler(async ({ params, actor, orgId }) => {
      const result = await service.remove(orgId, actor!.userId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/admin").summary("List all wishlists (admin)").permission("wishlist:admin")
    .handler(async ({ orgId, db }) => {
      // Admin can see all wishlists in their org — use db directly
      const { wishlistItems } = await import("../schema.js");
      const { eq } = await import("@porulle/core/drizzle");
      const rows = await (db as import("../types.js").Db).select().from(wishlistItems)
        .where(eq(wishlistItems.organizationId, orgId));
      return rows;
    });

  return r.routes();
}
