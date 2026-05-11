import { describe, it, expect, beforeAll } from "vitest";
import type { PluginTestApp } from "@porulle/core/testing";
import { createPluginTestApp, jsonHeaders, testNoPermActor, procAdminActor, procStaffActor } from "./test-utils.js";
import { procurementPlugin } from "../src/index.js";

describe("Procurement Plugin", () => {
  let app: PluginTestApp["app"];
  let supplierId: string;
  let poId: string;
  let poItemId: string;

  beforeAll(async () => {
    const result = await createPluginTestApp(procurementPlugin());
    app = result.app;
  }, 30_000);

  // Suppliers
  it("creates supplier -> 201", async () => {
    const res = await app.request("http://localhost/api/procurement/suppliers", {
      method: "POST", headers: jsonHeaders(procAdminActor),
      body: JSON.stringify({ name: "Fresh Farms", code: "FF01", contactEmail: "info@freshfarms.local", paymentTermsDays: 30 }),
    });
    expect(res.status).toBe(201);
    supplierId = (await res.json()).data.id;
  });

  it("rejects duplicate supplier code -> error", async () => {
    const res = await app.request("http://localhost/api/procurement/suppliers", {
      method: "POST", headers: jsonHeaders(procAdminActor),
      body: JSON.stringify({ name: "Dup", code: "FF01" }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("links item to supplier with cost -> 201", async () => {
    const res = await app.request(`http://localhost/api/procurement/suppliers/${supplierId}/items`, {
      method: "POST", headers: jsonHeaders(procAdminActor),
      body: JSON.stringify({ entityId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", unitCost: 350, supplierSku: "FF-BEEF-200G", leadTimeDays: 2 }),
    });
    expect(res.status).toBe(201);
  });

  it("gets supplier with items -> 200", async () => {
    const res = await app.request(`http://localhost/api/procurement/suppliers/${supplierId}`, { headers: jsonHeaders(procAdminActor) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items.length).toBe(1);
  });

  // Purchase Orders
  it("creates PO with items -> 201", async () => {
    const res = await app.request("http://localhost/api/procurement/purchase-orders", {
      method: "POST", headers: jsonHeaders(procStaffActor),
      body: JSON.stringify({
        supplierId, warehouseId: "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
        items: [
          { entityId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", itemName: "Beef Patty 200g", quantityOrdered: 100, unitCost: 350 },
          { entityId: "c3d4e5f6-a7b8-4c9d-ae1f-2a3b4c5d6e7f", itemName: "Brioche Buns", quantityOrdered: 200, unitCost: 80 },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    poId = body.data.id;
    expect(body.data.poNumber).toBe("PO-0001");
    expect(body.data.subtotal).toBe(51000); // 100*350 + 200*80
    expect(body.data.status).toBe("draft");
  });

  it("PO status flow: draft -> pending_approval -> approved", async () => {
    // Submit
    const submitRes = await app.request(`http://localhost/api/procurement/purchase-orders/${poId}/submit`, {
      method: "POST", headers: jsonHeaders(procStaffActor),
    });
    expect(submitRes.status).toBe(201);
    expect((await submitRes.json()).data.status).toBe("pending_approval");

    // Approve (requires procurement:admin)
    const approveRes = await app.request(`http://localhost/api/procurement/purchase-orders/${poId}/approve`, {
      method: "POST", headers: jsonHeaders(procAdminActor),
    });
    expect(approveRes.status).toBe(201);
    const approved = (await approveRes.json()).data;
    expect(approved.status).toBe("approved");
    expect(approved.approvedBy).toBe("proc-admin");
  });

  it("staff cannot approve PO (lacks procurement:admin) -> 403", async () => {
    // Create another PO
    const createRes = await app.request("http://localhost/api/procurement/purchase-orders", {
      method: "POST", headers: jsonHeaders(procStaffActor),
      body: JSON.stringify({
        supplierId, warehouseId: "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
        items: [{ entityId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", itemName: "Test", quantityOrdered: 10, unitCost: 100 }],
      }),
    });
    const po2Id = (await createRes.json()).data.id;
    await app.request(`http://localhost/api/procurement/purchase-orders/${po2Id}/submit`, {
      method: "POST", headers: jsonHeaders(procStaffActor),
    });

    const approveRes = await app.request(`http://localhost/api/procurement/purchase-orders/${po2Id}/approve`, {
      method: "POST", headers: jsonHeaders(procStaffActor),
    });
    expect(approveRes.status).toBe(403);
  });

  // GRN
  it("creates GRN against PO -> 201", async () => {
    // Get PO items
    const poRes = await app.request(`http://localhost/api/procurement/purchase-orders/${poId}`, { headers: jsonHeaders(procAdminActor) });
    const poItems = (await poRes.json()).data.items;
    poItemId = poItems[0].id;

    const res = await app.request("http://localhost/api/procurement/grn", {
      method: "POST", headers: jsonHeaders(procStaffActor),
      body: JSON.stringify({
        poId, supplierId, warehouseId: "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
        items: [
          { poItemId: poItems[0].id, entityId: poItems[0].entityId, quantityOrdered: 100, quantityReceived: 95, quantityAccepted: 90, quantityRejected: 5, rejectionReason: "Damaged packaging", batchNumber: "BATCH-001", unitCost: 350 },
          { poItemId: poItems[1].id, entityId: poItems[1].entityId, quantityOrdered: 200, quantityReceived: 200, quantityAccepted: 200, unitCost: 80 },
        ],
      }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).data.grnNumber).toBe("GRN-0001");
  });

  it("GRN accept marks discrepancy status -> 201", async () => {
    const grnList = await app.request("http://localhost/api/procurement/grn", { headers: jsonHeaders(procAdminActor) });
    const grnId = (await grnList.json()).data[0].id;

    const res = await app.request(`http://localhost/api/procurement/grn/${grnId}/accept`, {
      method: "POST", headers: jsonHeaders(procAdminActor),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).data.status).toBe("accepted_with_discrepancy");
  });

  // Org isolation
  it("org isolation: other org sees 0 suppliers", async () => {
    const otherOrg: import("@porulle/core").Actor = {
      type: "user", userId: "other", email: "o@o.local", name: "Other",
      vendorId: null, organizationId: "org_other", role: "staff", permissions: ["procurement:read"],
    };
    const res = await app.request("http://localhost/api/procurement/suppliers", { headers: jsonHeaders(otherOrg) });
    expect(res.status).toBe(200);
    expect((await res.json()).data.length).toBe(0);
  });

  it("no permission -> 403", async () => {
    const res = await app.request("http://localhost/api/procurement/suppliers", {
      method: "POST", headers: jsonHeaders(testNoPermActor),
      body: JSON.stringify({ name: "X", code: "X" }),
    });
    expect(res.status).toBe(403);
  });
});
