/**
 * PromotionType public export + OpenAPI enum (#23)
 *
 * Consumers (admin UIs) need a typed, importable enum of valid promotion
 * `type` values, and the OpenAPI spec must carry those values so generated
 * SDK types and API explorers surface them. These tests pin both.
 */

import { describe, it, expect } from "vitest";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
// Import from the PUBLIC entry — the contract under test.
import { promotionTypeEnum, type PromotionType } from "../src/index.js";
import { CreatePromotionBodySchema } from "../src/modules/promotions/schemas.js";

const EXPECTED = [
  "percentage_off_order",
  "fixed_off_order",
  "percentage_off_item",
  "fixed_off_item",
  "free_shipping",
  "buy_x_get_y",
] as const;

describe("PromotionType export + OpenAPI enum (#23)", () => {
  it("exports promotionTypeEnum from the package entry with all values", () => {
    expect(promotionTypeEnum.options).toEqual([...EXPECTED]);
  });

  it("PromotionType is the single source derived from the enum", () => {
    // Compile-time: every expected literal is assignable to PromotionType.
    const sample: PromotionType[] = [...EXPECTED];
    expect(sample).toHaveLength(EXPECTED.length);
  });

  it("OpenAPI document carries the promotion type enum values", () => {
    const app = new OpenAPIHono();
    app.openapi(
      createRoute({
        method: "post",
        path: "/promotions",
        request: {
          body: { content: { "application/json": { schema: CreatePromotionBodySchema } } },
        },
        responses: {
          200: { description: "ok", content: { "application/json": { schema: z.object({}) } } },
        },
      }),
      (c) => c.json({}),
    );

    const doc = app.getOpenAPIDocument({
      openapi: "3.0.0",
      info: { title: "test", version: "1" },
    });

    const enums: string[][] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const obj = node as Record<string, unknown>;
      if (Array.isArray(obj.enum) && obj.enum.includes("percentage_off_order")) {
        enums.push(obj.enum as string[]);
      }
      for (const v of Object.values(obj)) walk(v);
    };
    walk(doc);

    expect(enums.length).toBeGreaterThan(0);
    expect(enums.some((e) => EXPECTED.every((v) => e.includes(v)))).toBe(true);
  });
});
