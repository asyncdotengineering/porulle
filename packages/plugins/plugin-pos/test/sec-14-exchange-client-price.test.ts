import { describe, it, expect, beforeAll } from "vitest";
import type { PluginTestApp } from "@porulle/core/testing";
import type { Actor } from "@porulle/core/testing";
import {
  createPluginTestApp,
  jsonHeaders,
  posAdminActor,
} from "./test-utils.js";
import { posPlugin } from "../src/index.js";

const CATALOG_UNIT_PRICE = 5000;
const ATTACK_UNIT_PRICE = 1;

describe("SEC-14 — exchange replacement unitPrice is server-resolved", () => {
  let app: PluginTestApp["app"];
  let kernel: PluginTestApp["kernel"];
  let terminalId: string;
  let shiftId: string;
  let entityId: string;

  const exchangeActor: Actor = {
    ...posAdminActor,
    permissions: [
      ...posAdminActor.permissions,
      "orders:create",
      "orders:read",
      "orders:update",
      "orders:manage",
      "catalog:create",
      "pricing:manage",
      "inventory:adjust",
    ],
  };

  beforeAll(async () => {
    const built = await createPluginTestApp(posPlugin());
    app = built.app;
    kernel = built.kernel;

    const entity = await (kernel.services as any).catalog.create(
      { type: "product", slug: `sec14-${Date.now()}`, metadata: { title: "Designer Saree" } },
      exchangeActor,
    );
    expect(entity.ok).toBe(true);
    entityId = entity.value.id;

    const price = await (kernel.services as any).pricing.setBasePrice(
      { entityId, currency: "USD", amount: CATALOG_UNIT_PRICE },
      exchangeActor,
    );
    expect(price.ok).toBe(true);

    const warehouse = await (kernel.services as any).inventory.createWarehouse(
      { name: "SEC-14 Warehouse", code: `SEC14-${Date.now()}` },
      exchangeActor,
    );
    expect(warehouse.ok).toBe(true);
    const stock = await (kernel.services as any).inventory.adjust(
      {
        entityId,
        warehouseId: warehouse.value.id,
        adjustment: 20,
        reason: "SEC-14 exchange stock",
      },
      exchangeActor,
    );
    expect(stock.ok).toBe(true);

    const t = await app.request("http://localhost/api/pos/terminals", {
      method: "POST",
      headers: jsonHeaders(posAdminActor),
      body: JSON.stringify({ name: "SEC-14 Register", code: "SEC14" }),
    });
    terminalId = (await t.json()).data.id;

    const s = await app.request("http://localhost/api/pos/shifts/open", {
      method: "POST",
      headers: jsonHeaders(exchangeActor),
      body: JSON.stringify({ terminalId, openingFloat: 10000 }),
    });
    shiftId = (await s.json()).data.id;
  }, 30_000);

  it("ignores a client unitPrice below catalog and prices the replacement from the catalog", async () => {
    const order = await (kernel.services as any).orders.create(
      {
        currency: "USD",
        subtotal: 2000,
        taxTotal: 0,
        shippingTotal: 0,
        grandTotal: 2000,
        lineItems: [
          {
            entityId,
            entityType: "product",
            title: "Designer Saree",
            quantity: 1,
            unitPrice: 2000,
            totalPrice: 2000,
            taxAmount: 0,
          },
        ],
      },
      exchangeActor,
    );
    expect(order.ok).toBe(true);
    const orderId = order.value.id;
    const lineItemId = order.value.lineItems[0].id;

    const res = await app.request("http://localhost/api/pos/exchanges", {
      method: "POST",
      headers: jsonHeaders(exchangeActor),
      body: JSON.stringify({
        shiftId,
        terminalId,
        originalOrderId: orderId,
        currency: "USD",
        returnItems: [
          { originalLineItemId: lineItemId, quantity: 1, reason: "wrong_item" },
        ],
        replacementItems: [
          {
            entityId,
            title: "Designer Saree Replacement",
            quantity: 1,
            unitPrice: ATTACK_UNIT_PRICE,
          },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()).data;

    expect(data.replacementTotal).toBe(CATALOG_UNIT_PRICE);
    expect(data.replacementTotal).not.toBe(ATTACK_UNIT_PRICE);

    const replacement = await (kernel.services as any).orders.getById(
      data.replacementOrderId,
      exchangeActor,
    );
    expect(replacement.ok).toBe(true);
    expect(replacement.value.lineItems[0].unitPrice).toBe(CATALOG_UNIT_PRICE);
    expect(replacement.value.grandTotal).toBe(CATALOG_UNIT_PRICE);
  });
});
