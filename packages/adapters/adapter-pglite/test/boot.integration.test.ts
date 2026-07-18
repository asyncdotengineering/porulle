import { describe, expect, it } from "vitest";
import { createServer, defineConfig } from "@porulle/core";
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
