import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createPGliteTestAdapter } from "../src/test-utils/create-pglite-adapter.js";
import { createScopedDb } from "../src/kernel/database/scoped-db.js";
import { customers } from "../src/modules/customers/schema.js";
import { organization } from "../src/auth/auth-schema.js";
import { OrganizationService } from "../src/modules/organization/service.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";

// Drizzle's builder types forbid `.where()` after `.orderBy()` / `.limit()`, but the runtime
// allows it and `where()` REPLACES `config.where`. The chain is reachable by casting past the
// types, which is exactly the path a scoped handle must still defend.
type Rechainable<T> = PromiseLike<T> & { where(condition: unknown): Rechainable<T> };

/**
 * Every fluent method other than `.where()` — `innerJoin`, `leftJoin`, `orderBy`, `limit`, … —
 * returns the UNDERLYING builder, not the proxy that pre-applied the organization predicate, and
 * Drizzle's `where()` replaces rather than merges. So a join-then-where chain on a scoped handle
 * ran with only the caller's condition. Measured on 0.20.0 from a consumer: an organization-A
 * scoped read through a join returned an organization-B row.
 */
describe("scoped-db keeps the organization predicate across the whole chain", () => {
  let db: DrizzleDatabase;
  const ORG_A = "org_join_a";
  const ORG_B = "org_join_b";
  const scopedA = () => createScopedDb(db, () => ORG_A);

  beforeAll(async () => {
    const h = await createPGliteTestAdapter();
    db = h.db;
    const orgs = new OrganizationService(db);
    await orgs.create({ id: ORG_A, name: "Org A", slug: "join-a" });
    await orgs.create({ id: ORG_B, name: "Org B", slug: "join-b" });
    await db.insert(customers).values([
      { organizationId: ORG_A, userId: "a_join", firstName: "join", metadata: {} },
      { organizationId: ORG_B, userId: "b_join", firstName: "join", metadata: {} },
    ]);
  });

  it("CONTROL: a plain where() stays scoped", async () => {
    const rows = await scopedA().select().from(customers).where(eq(customers.firstName, "join"));
    expect(rows.map((r) => r.organizationId)).toEqual([ORG_A]);
  });

  it("innerJoin() then where() keeps the organization predicate", async () => {
    const rows = await scopedA()
      .select({ organizationId: customers.organizationId })
      .from(customers)
      .innerJoin(organization, eq(organization.id, customers.organizationId))
      .where(eq(customers.firstName, "join"));
    expect(rows.map((r) => r.organizationId)).toEqual([ORG_A]);
  });

  it("orderBy() then where() keeps the organization predicate", async () => {
    const chain = scopedA()
      .select({ organizationId: customers.organizationId })
      .from(customers)
      .orderBy(customers.userId) as unknown as Rechainable<Array<{ organizationId: string }>>;
    const rows = await chain.where(eq(customers.firstName, "join"));
    expect(rows.map((r) => r.organizationId)).toEqual([ORG_A]);
  });

  it("CONTROL: update().set().where() stays scoped", async () => {
    await scopedA().update(customers).set({ lastName: "JOINED" }).where(eq(customers.firstName, "join"));
    const all = await db.select().from(customers).where(eq(customers.firstName, "join"));
    expect(all.find((r) => r.organizationId === ORG_A)!.lastName).toBe("JOINED");
    expect(all.find((r) => r.organizationId === ORG_B)!.lastName).toBeNull();
  });
});
