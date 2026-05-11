import { describe, it, expect } from "vitest";
import { defineConfig } from "../src/config/define-config.js";

describe("defineConfig type checks", () => {
  it("accepts a valid config", async () => {
    const config = await defineConfig({
      database: { provider: "postgresql" },
      entities: {
        product: {
          fields: [{ name: "weight", type: "number" }],
          variants: { enabled: true, optionTypes: ["size"] },
          fulfillment: "physical",
        },
      },
    });
    expect(config.entities?.product).toBeDefined();
  });

  it("rejects invalid field types at compile time", async () => {
    // This test verifies the @ts-expect-error works (invalid type is caught)
    const config = await defineConfig({
      database: { provider: "postgresql" },
      entities: {
        product: {
          // @ts-expect-error invalid field type
          fields: [{ name: "weight", type: "invalid" }],
          variants: { enabled: true, optionTypes: ["size"] },
          fulfillment: "physical",
        },
      },
    });
    expect(config).toBeDefined();
  });
});
