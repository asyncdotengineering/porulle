import { defineCommercePlugin } from "@porulle/core";
import { wishlistItems } from "./schema.js";
import { WishlistService } from "./services/wishlist-service.js";
import { buildWishlistRoutes } from "./routes/wishlist.js";
export type { Db } from "./types.js";
export { WishlistService } from "./services/wishlist-service.js";

export function wishlistPlugin() {
  return defineCommercePlugin({
    id: "wishlist",
    version: "1.0.0",
    permissions: [
      { scope: "wishlist:read", description: "View wishlist items." },
      { scope: "wishlist:write", description: "Add/remove own wishlist items." },
      { scope: "wishlist:admin", description: "Manage any user's wishlist." },
    ],
    schema: () => ({ wishlistItems }),
    hooks: () => [],
    routes: (ctx) => {
      const db = ctx.database.db;
      if (!db) return [];
      return buildWishlistRoutes(new WishlistService(db), ctx);
    },
  });
}
