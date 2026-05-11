export type { PluginDb as Db } from "@porulle/core";
import type { unitsOfMeasure, uomConversions, entityUom } from "./schema.js";
export type UnitOfMeasure = typeof unitsOfMeasure.$inferSelect;
export type UOMConversion = typeof uomConversions.$inferSelect;
export type EntityUOM = typeof entityUom.$inferSelect;
export type UOMCategory = "weight" | "volume" | "length" | "count" | "area" | "time";
