import { defineCommercePlugin } from "@porulle/core";
import { unitsOfMeasure, uomConversions, entityUom } from "./schema.js";
import { UOMService } from "./services/uom-service.js";
import { buildUOMRoutes } from "./routes/uom.js";
import type { Db } from "./types.js";

export type { Db } from "./types.js";
export { UOMService } from "./services/uom-service.js";

export function uomPlugin() {
  return defineCommercePlugin({
    id: "uom",
    version: "1.0.0",
    permissions: [
      { scope: "uom:admin", description: "Create/edit units, conversions, entity UOM assignments." },
      { scope: "uom:read", description: "View units, conversions, convert quantities." },
    ],
    schema: () => ({ unitsOfMeasure, uomConversions, entityUom }),
    hooks: () => [],
    routes: (ctx) => {
      const db = ctx.database.db;
      if (!db) return [];
      return buildUOMRoutes(new UOMService(db), ctx);
    },
  });
}
