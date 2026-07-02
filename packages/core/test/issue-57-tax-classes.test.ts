import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  createTestServer,
  makeRequest,
  testActor,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";

// Issue #57 — runtime tax rates (#45) are region-based; retail also needs
// product tax classes (standard/reduced/zero-rated) so different lines in one
// cart tax differently. taxClass is a first-class column on entities and
// variants, classes CRUD lives at /api/tax/classes, and checkout computes
// per-line tax by class (cart-level discounts pro-rated before tax), storing
// per-line taxAmount on the order.
describe("Issue #57 — product tax classes", () => {
  let server: any;
  let kernel: any;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const result = await createTestServer();
    server = result.server;
    kernel = result.kernel;
    cleanup = result.cleanup;

    // Classes: standard 10% (default) + zero-rated
    for (const body of [
      { name: "standard", rateBps: 1000, isDefault: true },
      { name: "zero", rateBps: 0 },
    ]) {
      const res = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/tax/classes",
        body,
        actor: testActor,
      });
      expect(res.status).toBe(201);
    }

    await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" }, testActor);
  });

  afterAll(async () => {
    await cleanup();
  });

  async function createEntity(taxClass: string | undefined, basePrice: number): Promise<string> {
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/catalog/entities",
      body: {
        type: "product",
        slug: `e57-${taxClass ?? "none"}-${Date.now()}-${Math.round(performance.now() * 1000)}`,
        ...(taxClass ? { taxClass } : {}),
        metadata: { title: "P", basePrice },
      },
      actor: testActor,
    });
    expect(res.status).toBe(201);
    const entity = (await parseJsonResponse<{ data: any }>(res)).data;
    if (taxClass) expect(entity.taxClass).toBe(taxClass);
    await kernel.services.inventory.adjust(
      { entityId: entity.id, adjustment: 10, reason: "stock" },
      testActor,
    );
    return entity.id;
  }

  it("CRUDs tax classes over REST", async () => {
    const create = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/tax/classes",
      body: { name: "reduced", rateBps: 500 },
      actor: testActor,
    });
    expect(create.status).toBe(201);
    const cls = (await parseJsonResponse<{ data: any }>(create)).data;

    const list = await parseJsonResponse<{ data: any[] }>(
      await makeRequest(server, { method: "GET", url: "http://localhost/api/tax/classes", actor: testActor }),
    );
    expect(list.data.map((c) => c.name)).toContain("reduced");

    const patch = await makeRequest(server, {
      method: "PATCH",
      url: `http://localhost/api/tax/classes/${cls.id}`,
      body: { rateBps: 800 },
      actor: testActor,
    });
    expect(patch.status).toBe(200);
    expect((await parseJsonResponse<{ data: any }>(patch)).data.rateBps).toBe(800);

    const del = await makeRequest(server, {
      method: "DELETE",
      url: `http://localhost/api/tax/classes/${cls.id}`,
      actor: testActor,
    });
    expect(del.status).toBe(200);
  });

  it("checkout taxes standard and zero-rated lines differently, storing per-line taxAmount", async () => {
    const standardEntity = await createEntity("standard", 1000); // 10% → 100/unit
    const zeroEntity = await createEntity("zero", 2000);         // 0%

    const cartRes = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/carts",
      body: { currency: "USD" },
      actor: testActor,
    });
    const cartId = (await parseJsonResponse<{ data: { id: string } }>(cartRes)).data.id;
    for (const entityId of [standardEntity, zeroEntity]) {
      const add = await makeRequest(server, {
        method: "POST",
        url: `http://localhost/api/carts/${cartId}/items`,
        body: { entityId, quantity: 1 },
        actor: testActor,
      });
      expect(add.status).toBe(201);
    }

    const checkout = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/checkout",
      body: {
        cartId,
        paymentMethodId: "test-payments",
        currency: "USD",
        shippingAddress: { country: "US", postalCode: "90001", state: "CA", city: "LA", line1: "1 Test St" },
      },
      actor: testActor,
    });
    expect(checkout.status).toBe(201);
    const order = (await parseJsonResponse<{ data: any }>(checkout)).data;

    // standard: 10% of 1000 = 100; zero: 0 → order tax = 100
    expect(order.taxTotal).toBe(100);
    const standardLine = order.lineItems.find((l: any) => l.entityId === standardEntity);
    const zeroLine = order.lineItems.find((l: any) => l.entityId === zeroEntity);
    expect(standardLine.taxAmount).toBe(100);
    expect(zeroLine.taxAmount).toBe(0);
  });

  it("unclassed lines fall back to the default class; variant taxClass overrides the entity's", async () => {
    // Service-level: default-class fallback + variant override resolution
    const result = await kernel.services.tax.calculate(
      {
        currency: "USD",
        shippingAmount: 0,
        lineItems: [
          // Unclassed line → default class (standard, 10%): 10% of 500 = 50
          { id: "l1", entityId: "00000000-0000-4000-8000-000000000001", description: "x", quantity: 1, unitPrice: 500 },
        ],
      },
      "org_default",
    );
    expect(result.ok).toBe(true);
    expect(result.value.amountToCollect).toBe(50);
    expect(result.value.lines[0].taxClass).toBe("standard");

    // Pro-rated cart discount before tax: 10% of (1000 - 200) = 80
    const discounted = await kernel.services.tax.calculate(
      {
        currency: "USD",
        shippingAmount: 0,
        orderDiscount: 200,
        lineItems: [
          { id: "l1", entityId: "00000000-0000-4000-8000-000000000001", description: "x", quantity: 1, unitPrice: 1000 },
        ],
      },
      "org_default",
    );
    expect(discounted.ok).toBe(true);
    expect(discounted.value.amountToCollect).toBe(80);
  });
});
