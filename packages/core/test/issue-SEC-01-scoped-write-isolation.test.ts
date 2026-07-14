import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createPGliteTestAdapter } from "../src/test-utils/create-pglite-adapter.js";
import { createScopedDb } from "../src/kernel/database/scoped-db.js";
import { customers } from "../src/modules/customers/schema.js";
import { OrganizationService } from "../src/modules/organization/service.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";

/**
 * SEC-01 — the scoped-db proxy must constrain UPDATE and DELETE to the actor's
 * org, exactly as it already does for SELECT. Reproduces the live cross-tenant
 * write proven against Postgres: an org-A scoped write filtered by a business
 * key must never touch org-B's rows, and a write with NO where clause must be
 * org-scoped too (not a whole-table sweep).
 */
describe("SEC-01 — scoped-db scopes UPDATE and DELETE", () => {
  let db: DrizzleDatabase;
  const ORG_A = "org_sec01_a";
  const ORG_B = "org_sec01_b";
  const scopedA = () => createScopedDb(db, () => ORG_A);

  beforeAll(async () => {
    const h = await createPGliteTestAdapter();
    db = h.db;
    const orgs = new OrganizationService(db);
    await orgs.create({ id: ORG_A, name: "Org A", slug: "sec01-a" });
    await orgs.create({ id: ORG_B, name: "Org B", slug: "sec01-b" });
  });

  async function seedPair(tag: string) {
    await db.insert(customers).values([
      { organizationId: ORG_A, userId: `a_${tag}`, firstName: tag, metadata: {} },
      { organizationId: ORG_B, userId: `b_${tag}`, firstName: tag, metadata: {} },
    ]);
  }

  it("SELECT stays scoped (control)", async () => {
    await seedPair("sel");
    const rows = await scopedA().select().from(customers).where(eq(customers.firstName, "sel"));
    expect(rows.length).toBe(1);
    expect(rows[0]!.organizationId).toBe(ORG_A);
  });

  it("UPDATE by a business key does not cross tenants", async () => {
    await seedPair("upd");
    await scopedA().update(customers).set({ lastName: "PWNED" }).where(eq(customers.firstName, "upd"));
    const all = await db.select().from(customers).where(eq(customers.firstName, "upd"));
    const a = all.find((r) => r.organizationId === ORG_A)!;
    const b = all.find((r) => r.organizationId === ORG_B)!;
    expect(a.lastName).toBe("PWNED");
    expect(b.lastName).toBeNull(); // org-B untouched
  });

  it("DELETE by a business key does not cross tenants", async () => {
    await seedPair("del");
    await scopedA().delete(customers).where(eq(customers.firstName, "del"));
    const all = await db.select().from(customers).where(eq(customers.firstName, "del"));
    expect(all.some((r) => r.organizationId === ORG_A)).toBe(false); // A deleted
    expect(all.some((r) => r.organizationId === ORG_B)).toBe(true); // B survives
  });

  it("DELETE with NO where clause is still org-scoped (no whole-table sweep)", async () => {
    await seedPair("nowhere");
    await scopedA().delete(customers); // "delete everything" as org-A
    const remaining = await db.select().from(customers);
    expect(remaining.some((r) => r.organizationId === ORG_A)).toBe(false);
    expect(remaining.some((r) => r.organizationId === ORG_B)).toBe(true);
  });
});
