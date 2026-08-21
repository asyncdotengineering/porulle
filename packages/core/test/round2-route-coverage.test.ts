import { describe, expect, it } from "vitest";
import { createServer } from "../src/runtime/server.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";

describe("round 2 production route coverage", () => {
  it("rejects an unguarded adopter route during server construction", async () => {
    const { config, cleanup } = await createPGliteTestConfig({
      exposeOpenApiSpec: false,
      routes: (app) => {
        app.get("/api/round2-unguarded", (c) => c.text("unguarded"));
      },
    });
    try {
      await expect(createServer(config)).rejects.toThrow("GET /api/round2-unguarded");
    } finally {
      await cleanup();
    }
  });
});
