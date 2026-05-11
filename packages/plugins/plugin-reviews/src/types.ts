import type { customerReviews } from "./schema.js";

export type { PluginDb as Db } from "@porulle/core";
export type Review = typeof customerReviews.$inferSelect;
export type ReviewInsert = typeof customerReviews.$inferInsert;
