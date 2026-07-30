import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { Ok, type Actor, type Kernel } from "@porulle/core";
import { agentCatalogRoutes } from "../src/agent-routes.js";

const actor: Actor = {
  type: "api_key",
  userId: "storefront",
  email: null,
  name: "Storefront agent",
  vendorId: null,
  organizationId: "org_default",
  role: "storefront",
  permissions: ["catalog:read"],
};

function fakeKernel(): Kernel {
  const entity = {
    id: "product-1",
    organizationId: "org_default",
    type: "product",
    slug: "trail-pack",
    status: "active",
    metadata: { brand: "Field Notes", category: "bags" },
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    attributes: [{
      id: "attr-1",
      entityId: "product-1",
      locale: "en",
      title: "Trail Pack",
      description: "Weatherproof daypack",
      createdAt: new Date(),
      updatedAt: new Date(),
    }],
    media: [],
  };
  return {
    services: {
      catalog: {
        getById: async () => Ok(entity),
        list: async (params: { filter?: { status?: string } }) => {
          expect(params.filter?.status).toBe("active");
          return Ok({ items: [entity], pagination: { page: 1, limit: 1_000, total: 1, totalPages: 1 } });
        },
      },
      inventory: { getAvailable: async () => Ok(7) },
      pricing: {
        resolve: async () => Ok({
          baseAmount: 9900,
          finalAmount: 9900,
          currency: "USD",
          appliedModifiers: [],
          breakdown: [],
          basePriceId: "price-1",
        }),
      },
    },
  } as unknown as Kernel;
}

describe("agent catalog routes", () => {
  it("projects Porulle price and inventory truth into Samesake documents", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      (c as unknown as { set(name: string, value: unknown): void }).set("actor", actor);
      await next();
    });
    agentCatalogRoutes(app, fakeKernel());

    const product = await (await app.request("/agent/catalog/product-1")).json() as { data: Record<string, unknown> };
    expect(product.data).toMatchObject({ title: "Trail Pack", priceAmount: 9900, stock: 7, inStock: true });

    const exported = await (await app.request("/agent/catalog/export")).json() as {
      data: Array<{ id: string; data: Record<string, unknown> }>;
    };
    expect(exported.data[0]).toMatchObject({
      id: "product-1",
      data: { title: "Trail Pack", price: 9900, currency: "USD", available: true, stock: 7 },
    });
  });
});
