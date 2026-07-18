import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createPGliteTestAdapter } from "../src/test-utils/create-pglite-adapter.js";
import { createScopedDb } from "../src/kernel/database/scoped-db.js";
import { customers } from "../src/modules/customers/schema.js";
import { OrganizationService } from "../src/modules/organization/service.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";

// Drizzle's builder types drop `.where` after the first call, so a chained
// `.where(a).where(b)` is only reachable by casting past the types — which is
// exactly the unsafe path the scoped-db guard must still defend. This type lets
// the regression tests express that chain.
type Rechainable<T> = PromiseLike<T> & { where(condition: unknown): Rechainable<T> };

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

  // Regression: Drizzle's second `.where()` REPLACES the first, so a chained
  // `.where(a).where(b)` must not drop the injected org predicate.
  it("chained .where(a).where(b) on UPDATE keeps the org scope", async () => {
    await seedPair("uchain");
    await (scopedA()
      .update(customers)
      .set({ lastName: "CHAINED" })
      .where(eq(customers.firstName, "nonexistent")) as unknown as Rechainable<unknown>)
      .where(eq(customers.firstName, "uchain"));
    const all = await db.select().from(customers).where(eq(customers.firstName, "uchain"));
    expect(all.find((r) => r.organizationId === ORG_A)!.lastName).toBe("CHAINED");
    expect(all.find((r) => r.organizationId === ORG_B)!.lastName).toBeNull(); // org-B untouched
  });

  it("chained .where(a).where(b) on SELECT stays org-scoped", async () => {
    await seedPair("schain");
    const rows = await (scopedA()
      .select()
      .from(customers)
      .where(eq(customers.firstName, "nonexistent")) as unknown as Rechainable<Array<{ organizationId: string }>>)
      .where(eq(customers.firstName, "schain"));
    expect(rows.length).toBe(1);
    expect(rows[0]!.organizationId).toBe(ORG_A);
  });
});
