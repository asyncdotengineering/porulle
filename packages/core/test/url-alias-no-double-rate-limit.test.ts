import { describe, expect, it } from "vitest";
import { createServer } from "../src/runtime/server.js";
import { createTestConfig } from "../src/test-utils/create-test-config.js";

describe("URL alias — single middleware pass (rate limit)", () => {
  it("does not double-count alias paths against /api/* rate limit", async () => {
    const config = await createTestConfig({
      rateLimits: { api: 5 },
      entities: {
        product: {
          fields: [{ name: "title", type: "text" }],
          variants: { enabled: false, optionTypes: [] },
          fulfillment: "physical",
          alias: "products",
        },
      },
    });
    const { app } = await createServer(config);

    const url = "http://localhost/api/products";

    for (let i = 0; i < 5; i++) {
      const res = await app.request(url, { method: "GET" });
      expect(res.status).not.toBe(429);
    }

    const sixth = await app.request(url, { method: "GET" });
    expect(sixth.status).toBe(429);
  });
});
