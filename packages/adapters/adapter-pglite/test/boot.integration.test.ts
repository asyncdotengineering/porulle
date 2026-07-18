import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import {
  createCommerce,
  createServer,
  defineCommercePlugin,
  defineConfig,
} from "@porulle/core";
import { pgliteAdapter } from "../src/index.js";

// Proves the scaffold's exact composition: a minimal defineConfig using
// pgliteAdapter, booted through createServer, actually serves the REST API.
describe("pgliteAdapter boots a Porulle server end to end", () => {
  it("createServer + pgliteAdapter answers GET /api/health with 200", async () => {
    const config = await defineConfig({
      storeName: "Smoke Store",
      database: { provider: "postgresql" },
      databaseAdapter: await pgliteAdapter(),
      auth: {
        defaultOrganizationId: "org_default",
        requireEmailVerification: false,
        apiKeys: { enabled: true },
        trustedOrigins: ["http://localhost:4000"],
      },
      entities: {
        product: { fields: [], variants: { enabled: false }, fulfillment: "physical" },
      },
      payments: [],
    });

    const { app } = await createServer(config);
    const res = await app.fetch(new Request("http://localhost:4000/api/health"));
    expect(res.status).toBe(200);
  }, 30_000);
});

// A zero-migration adapter (PGlite) pushes core schema at construction, but a
// plugin's own tables live in `config.customSchemas`, which only exist after
// plugins run in defineConfig — i.e. after the adapter was constructed. The
// runtime must create those tables at boot, or every plugin is dead on a
// zero-infra boot (its routes 500 with "relation ... does not exist").
describe("pgliteAdapter creates plugin-declared tables at boot", () => {
  const probeWidgets = pgTable("probe_widgets", {
    id: text("id").primaryKey(),
  });

  it("creates a plugin's schema tables on a zero-migration boot", async () => {
    const adapter = await pgliteAdapter();
    const config = await defineConfig({
      storeName: "Plugin Store",
      database: { provider: "postgresql" },
      databaseAdapter: adapter,
      auth: {
        defaultOrganizationId: "org_default",
        requireEmailVerification: false,
        apiKeys: { enabled: true },
        trustedOrigins: ["http://localhost:4000"],
      },
      entities: {
        product: { fields: [], variants: { enabled: false }, fulfillment: "physical" },
      },
      payments: [],
      plugins: [
        defineCommercePlugin({
          id: "probe",
          version: "1.0.0",
          schema: () => ({ probeWidgets }),
        }),
      ],
    });

    await createCommerce(config);
    const db = adapter.db as {
      execute(q: unknown): Promise<{ rows: Array<Record<string, unknown>> }>;
    };

    const table = await db.execute(
      sql`SELECT to_regclass('public.probe_widgets') AS t`,
    );
    expect(table.rows[0]?.t).toBeTruthy();
  }, 30_000);
});
