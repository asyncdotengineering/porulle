/**
 * Schema barrel public exports (#20)
 *
 * Downstream consumers build custom queries (catalog image projection,
 * presigned uploads, audit feeds) against the media and audit tables and
 * must not have to re-declare them locally. This pins that `@porulle/core`'s
 * schema barrel re-exports the media tables (`mediaAssets`, `entityMedia`)
 * and the audit log table (`auditLog` → `commerce_audit_log`) so they can't
 * silently drop from the public surface again.
 */

import { describe, it, expect } from "vitest";
import * as schema from "../src/kernel/database/schema.js";

function tableName(t: unknown): string | undefined {
  // Drizzle stores the SQL table name on a Symbol-keyed property.
  const sym = Object.getOwnPropertySymbols(t as object).find(
    (s) => s.description === "drizzle:Name",
  );
  return sym ? (t as Record<symbol, string>)[sym] : undefined;
}

describe("schema barrel public exports (#20)", () => {
  it("re-exports the media tables", () => {
    expect(schema).toHaveProperty("mediaAssets");
    expect(schema).toHaveProperty("entityMedia");
    expect(tableName((schema as Record<string, unknown>).mediaAssets)).toBe("media_assets");
    expect(tableName((schema as Record<string, unknown>).entityMedia)).toBe("entity_media");
  });

  it("re-exports the audit log table", () => {
    expect(schema).toHaveProperty("auditLog");
    expect(tableName((schema as Record<string, unknown>).auditLog)).toBe("commerce_audit_log");
  });
});
