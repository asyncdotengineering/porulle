/**
 * Programmatic database schema management.
 *
 * For npm consumers who don't have access to the raw .ts schema files,
 * this module provides:
 *
 * 1. `getSchemaFiles()` — returns schema module paths for use in drizzle.config.ts
 * 2. `getSchema()` — returns the combined Drizzle schema object
 * 3. `pushSchema()` — programmatic push (creates tables if not exist)
 *
 * Usage in consumer's drizzle.config.ts:
 *
 *   import { getSchema } from "@porulle/core";
 *   import { defineConfig } from "drizzle-kit";
 *
 *   export default defineConfig({
 *     dialect: "postgresql",
 *     schema: getSchema(),
 *     dbCredentials: { url: process.env.DATABASE_URL! },
 *   });
 */

import type { CommerceConfig } from "../../config/types.js";
import * as schema from "./schema.js";

/**
 * Returns the combined Drizzle schema object with all table definitions.
 * Use this in your own drizzle.config.ts or for programmatic schema inspection.
 */
export function getSchema() {
  return schema;
}

/**
 * Returns core schema merged with all plugin schemas from `config.customSchemas[]`.
 * Throws if a plugin table name collides with a core table name.
 */
export function buildSchema(config?: CommerceConfig): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...schema };

  if (!config?.customSchemas?.length) return merged;

  const coreKeys = new Set(Object.keys(schema));

  for (const pluginSchema of config.customSchemas) {
    for (const [key, value] of Object.entries(pluginSchema)) {
      if (coreKeys.has(key)) {
        throw new Error(
          `Plugin schema name collision: "${key}" already exists in core schema`,
        );
      }
      if (key in merged) {
        throw new Error(
          `Plugin schema name collision: "${key}" is defined by multiple plugins`,
        );
      }
      merged[key] = value;
    }
  }

  return merged;
}

/**
 * Returns a list of all schema table names defined by the commerce engine.
 */
export function getTableNames(): string[] {
  return Object.entries(schema)
    .filter(
      ([_, value]) =>
        value != null &&
        typeof value === "object" &&
        "getSQL" in (value as object),
    )
    .map(([key]) => key);
}
