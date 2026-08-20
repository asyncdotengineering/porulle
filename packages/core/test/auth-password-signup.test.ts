/**
 * Fresh-install contract: pushSchema() then email/password sign-up must succeed.
 * Fails when Porulle's account table omits a column better-auth INSERTs (e.g. issuer).
 */

import { describe, it, expect, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { pushSchema } from "../src/kernel/database/migrate.js";
import { createAuth } from "../src/auth/setup.js";
import { createTestConfig } from "../src/test-utils/create-test-config.js";
import { account } from "../src/auth/auth-schema.js";
import type { DatabaseAdapter } from "../src/kernel/database/adapter.js";
import * as fullSchema from "../src/kernel/database/schema.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";

describe("password sign-up after pushSchema (better-auth account columns)", () => {
  let pg: PGlite;
  let cleanupPg: () => Promise<void>;

  afterAll(async () => {
    await cleanupPg?.();
  });

  it("creates a credential account when the pushed schema matches better-auth", async () => {
    pg = new PGlite();
    cleanupPg = () => pg.close();
    const db = drizzle(pg, { schema: fullSchema }) as DrizzleDatabase;

    await pushSchema(db);

    const adapter: DatabaseAdapter = {
      provider: "postgresql",
      db,
      transaction: async (fn) => fn(db),
    };

    const config = await createTestConfig({
      databaseAdapter: adapter,
      auth: {
        requireEmailVerification: false,
      },
    });
    const auth = createAuth(adapter, config);

    const email = `signup-${Date.now()}@test.local`;
    const result = await auth.api.signUpEmail({
      body: {
        email,
        password: "TestPassword123!",
        name: "Sign Up Test",
      },
    });

    expect(result.user?.email).toBe(email);

    const rows = await db
      .select({ issuer: account.issuer, accountId: account.accountId })
      .from(account)
      .where(eq(account.userId, result.user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.issuer).toBe("local:credential");
    expect(rows[0]?.accountId).toBe(result.user.id);
  });
});
