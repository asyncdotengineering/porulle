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
 *   import { getSchemaFiles } from "@porulle/core";
 *   import { defineConfig } from "drizzle-kit";
 *
 *   export default defineConfig({
 *     dialect: "postgresql",
 *     schema: getSchemaFiles(),
 *     dbCredentials: { url: process.env.DATABASE_URL! },
 *   });
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { CommerceConfig } from "../../config/types.js";
import { unwrapDb } from "./adapter.js";
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

/**
 * Returns the absolute filesystem path(s) of the combined schema module for
 * use as drizzle-kit's `schema` option in a consumer's `drizzle.config.ts`.
 *
 * npm consumers don't have the raw `.ts` sources, so a relative path into
 * `node_modules` is brittle. This resolves the installed schema module
 * (compiled `schema.js` for published consumers, `schema.ts` under Bun) so
 * `drizzle-kit push` / `generate` discover every core table.
 */
export function getSchemaFiles(): string[] {
  // Resolve the sibling schema module that actually exists: `.ts` when running
  // from source (Bun export condition), `.js` for published/compiled consumers.
  const ext = fileURLToPath(import.meta.url).endsWith(".ts") ? ".ts" : ".js";
  return [fileURLToPath(new URL(`./schema${ext}`, import.meta.url))];
}

/**
 * Programmatically creates the core tables in the target database
 * (creates tables if they don't exist), without migration files.
 *
 * Uses `drizzle-kit/api` — drizzle-kit introspects the live database and
 * generates the minimal DDL to converge it on the core schema. Pass a
 * Drizzle instance bound to your database. `drizzle-kit` must be available
 * (it is the standard schema tool); a clear error is thrown if it is not.
 */
export async function pushSchema(drizzleInstance: unknown): Promise<void> {
  const require = createRequire(import.meta.url);
  let drizzleKit: {
    pushSchema(
      imports: Record<string, unknown>,
      db: unknown,
    ): Promise<{ apply: () => Promise<void> }>;
  };
  try {
    drizzleKit = require("drizzle-kit/api");
  } catch {
    throw new Error(
      "pushSchema() requires `drizzle-kit` to be installed. Add it to your project: bun add -d drizzle-kit",
    );
  }
  // drizzle-kit needs the native driver result shape; unwrap a normalized db.
  const { apply } = await drizzleKit.pushSchema(getSchema(), unwrapDb(drizzleInstance));
  await apply();
}
