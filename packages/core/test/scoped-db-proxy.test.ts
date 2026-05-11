/**
 * Scoped DB Proxy Test
 *
 * Verifies that createScopedDb auto-injects organizationId on INSERT.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";
import { ensureDefaultOrg } from "../src/auth/org.js";
import { createScopedDb } from "../src/kernel/database/scoped-db.js";
import { organization } from "../src/auth/auth-schema.js";
import { sellableEntities } from "../src/modules/catalog/schema.js";
import type { Kernel } from "../src/runtime/kernel.js";

const ORG_A = "org_proxy_a";
const ORG_B = "org_proxy_b";

describe("Scoped DB Proxy", () => {
  let kernel: Kernel;
  let rawDb: any;

  beforeAll(async () => {
    const { config } = await createPGliteTestConfig();
    kernel = createKernel(config);
    rawDb = kernel.database.db;

    await ensureDefaultOrg(rawDb);
    await rawDb.insert(organization).values({ id: ORG_A, name: "Proxy A", slug: "proxy-a", createdAt: new Date() });
    await rawDb.insert(organization).values({ id: ORG_B, name: "Proxy B", slug: "proxy-b", createdAt: new Date() });
  }, 30_000);

  it("scoped INSERT auto-sets organizationId", async () => {
    const dbA = createScopedDb(rawDb, ORG_A);

    const [inserted] = await dbA
      .insert(sellableEntities)
      .values({
        type: "product",
        slug: "auto-stamped",
        status: "draft",
        isVisible: false,
        metadata: {},
      })
      .returning();

    expect(inserted.organizationId).toBe(ORG_A);
  });

  it("both orgs can insert same slug via scoped db", async () => {
    const dbA = createScopedDb(rawDb, ORG_A);
    const dbB = createScopedDb(rawDb, ORG_B);

    const [a] = await dbA
      .insert(sellableEntities)
      .values({ type: "product", slug: "proxy-shared", status: "draft", isVisible: false, metadata: {} })
      .returning();

    const [b] = await dbB
      .insert(sellableEntities)
      .values({ type: "product", slug: "proxy-shared", status: "draft", isVisible: false, metadata: {} })
      .returning();

    expect(a.organizationId).toBe(ORG_A);
    expect(b.organizationId).toBe(ORG_B);
    expect(a.id).not.toBe(b.id);
  });

  it("batch insert stamps all rows", async () => {
    const dbA = createScopedDb(rawDb, ORG_A);

    const rows = await dbA
      .insert(sellableEntities)
      .values([
        { type: "product", slug: "batch-1", status: "draft", isVisible: false, metadata: {} },
        { type: "product", slug: "batch-2", status: "draft", isVisible: false, metadata: {} },
      ])
      .returning();

    expect(rows).toHaveLength(2);
    expect(rows[0].organizationId).toBe(ORG_A);
    expect(rows[1].organizationId).toBe(ORG_A);
  });

  it("raw db (no proxy) requires explicit organizationId", async () => {
    // Without proxy, insert without organizationId should fail (NOT NULL constraint).
    // Drizzle query builders aren't native Promises, so we must explicitly await.
    let threw = false;
    try {
      await rawDb
        .insert(sellableEntities)
        .values({
          type: "product",
          slug: "should-fail",
          status: "draft",
          isVisible: false,
          metadata: {},
        })
        .returning();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
