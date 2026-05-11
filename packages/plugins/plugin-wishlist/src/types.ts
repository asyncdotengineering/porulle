import type { wishlistItems } from "./schema.js";
export type { PluginDb as Db } from "@porulle/core";
export type WishlistItem = typeof wishlistItems.$inferSelect;
