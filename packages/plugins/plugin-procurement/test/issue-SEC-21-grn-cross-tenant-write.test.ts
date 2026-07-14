import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@porulle/core/testing";
import { jsonHeaders, TEST_ORG_ID } from "@porulle/core/testing";
import { procurementPlugin } from "../src/index.js";
import { createPluginTestApp } from "./test-utils.js";
import type { PluginTestApp } from "@porulle/core/testing";

/**
 * SEC-21 — GRN create must reject poId/poItemId not owned by the actor's org.
 */
const ORG_A = TEST_ORG_ID;
const ORG_B = "org_sec21_b";
const WAREHOUSE_ID = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";
const ENTITY_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

const orgBActor: Actor = {
  type: "user",
  userId: "sec21-b-admin",
  email: "b@sec21.test",
  name: "Org B Admin",
  vendorId: null,
  organizationId: ORG_B,
  role: "staff",
  permissions: ["procurement:admin", "procurement:create", "procurement:read"],
};

const orgAActor: Actor = {
  type: "user",
  userId: "sec21-a-staff",
  email: "a@sec21.test",
  name: "Org A Staff",
  vendorId: null,
  organizationId: ORG_A,
  role: "staff",
  permissions: ["procurement:create", "procurement:read"],
};

describe("SEC-21 — GRN cross-tenant write blocked", () => {
  let harness: PluginTestApp;
  let supplierId: string;
  let poId: string;
  let poItemId: string;

  beforeAll(async () => {
    harness = await createPluginTestApp(procurementPlugin());
    await harness.kernel.services.organization.create({
      id: ORG_B,
      name: "SEC-21 Org B",
      slug: "sec21-b",
    });

    const supplierRes = await harness.app.request("http://localhost/api/procurement/suppliers", {
      method: "POST",
      headers: jsonHeaders(orgBActor),
      body: JSON.stringify({
        name: "Org B Supplier",
        code: "SEC21B",
        contactEmail: "supplier@sec21-b.test",
      }),
    });
    expect(supplierRes.status).toBe(201);
    supplierId = (await supplierRes.json()).data.id;

    const poRes = await harness.app.request("http://localhost/api/procurement/purchase-orders", {
      method: "POST",
      headers: jsonHeaders(orgBActor),
      body: JSON.stringify({
        supplierId,
        warehouseId: WAREHOUSE_ID,
        items: [
          {
            entityId: ENTITY_ID,
            itemName: "Cross-tenant probe",
            quantityOrdered: 50,
            unitCost: 100,
          },
        ],
      }),
    });
    expect(poRes.status).toBe(201);
    poId = (await poRes.json()).data.id;

    await harness.app.request(`http://localhost/api/procurement/purchase-orders/${poId}/submit`, {
      method: "POST",
      headers: jsonHeaders(orgBActor),
    });
    await harness.app.request(`http://localhost/api/procurement/purchase-orders/${poId}/approve`, {
      method: "POST",
      headers: jsonHeaders(orgBActor),
    });

    const poDetail = await harness.app.request(
      `http://localhost/api/procurement/purchase-orders/${poId}`,
      { headers: jsonHeaders(orgBActor) },
    );
    poItemId = (await poDetail.json()).data.items[0].id;
  }, 30_000);

  it("rejects a GRN citing another org's PO and leaves quantity_received unchanged", async () => {
    const beforePo = await harness.app.request(
      `http://localhost/api/procurement/purchase-orders/${poId}`,
      { headers: jsonHeaders(orgBActor) },
    );
    expect((await beforePo.json()).data.items[0].quantityReceived).toBe(0);

    const attack = await harness.app.request("http://localhost/api/procurement/grn", {
      method: "POST",
      headers: jsonHeaders(orgAActor),
      body: JSON.stringify({
        poId,
        supplierId,
        warehouseId: WAREHOUSE_ID,
        items: [
          {
            poItemId,
            entityId: ENTITY_ID,
            quantityOrdered: 50,
            quantityReceived: 25,
            quantityAccepted: 25,
            unitCost: 100,
          },
        ],
      }),
    });
    expect(attack.status).toBeGreaterThanOrEqual(400);

    const afterPo = await harness.app.request(
      `http://localhost/api/procurement/purchase-orders/${poId}`,
      { headers: jsonHeaders(orgBActor) },
    );
    expect((await afterPo.json()).data.items[0].quantityReceived).toBe(0);
  });
});