import { describe, it, expect, beforeAll } from "vitest";
import type { PluginTestApp } from "@porulle/core/testing";
import { createPluginTestApp, jsonHeaders, testNoPermActor, whAdminActor, whStaffActor } from "./test-utils.js";
import { warehousePlugin } from "../src/index.js";

describe("Warehouse Plugin", () => {
  let app: PluginTestApp["app"];
  const whA = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
  const whB = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";
  const entityId = "c3d4e5f6-a7b8-4c9d-ae1f-2a3b4c5d6e7f";

  beforeAll(async () => {
    const result = await createPluginTestApp(warehousePlugin());
    app = result.app;
  }, 30_000);

  // Transfers
  it("creates stock transfer between warehouses -> 201", async () => {
    const res = await app.request("http://localhost/api/warehouse/transfers", {
      method: "POST", headers: jsonHeaders(whStaffActor),
      body: JSON.stringify({
        fromWarehouseId: whA, toWarehouseId: whB, type: "requisition",
        items: [{ entityId, itemName: "Flour 25kg", quantityRequested: 10 }],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.transferNumber).toBe("TRF-0001");
    expect(body.data.status).toBe("draft");
  });

  it("rejects transfer to same warehouse -> error", async () => {
    const res = await app.request("http://localhost/api/warehouse/transfers", {
      method: "POST", headers: jsonHeaders(whStaffActor),
      body: JSON.stringify({
        fromWarehouseId: whA, toWarehouseId: whA,
        items: [{ entityId, itemName: "X", quantityRequested: 1 }],
      }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("transfer lifecycle: draft -> approved -> in_transit -> received", async () => {
    const listRes = await app.request("http://localhost/api/warehouse/transfers", { headers: jsonHeaders(whStaffActor) });
    const transferId = (await listRes.json()).data[0].id;

    // Approve
    const approveRes = await app.request(`http://localhost/api/warehouse/transfers/${transferId}/approve`, {
      method: "POST", headers: jsonHeaders(whAdminActor),
    });
    expect(approveRes.status).toBe(201);
    expect((await approveRes.json()).data.status).toBe("approved");

    // Dispatch
    const dispatchRes = await app.request(`http://localhost/api/warehouse/transfers/${transferId}/dispatch`, {
      method: "POST", headers: jsonHeaders(whStaffActor),
    });
    expect(dispatchRes.status).toBe(201);
    expect((await dispatchRes.json()).data.status).toBe("in_transit");

    // Get items for receive
    const getRes = await app.request(`http://localhost/api/warehouse/transfers/${transferId}`, { headers: jsonHeaders(whStaffActor) });
    const items = (await getRes.json()).data.items;

    // Receive
    const receiveRes = await app.request(`http://localhost/api/warehouse/transfers/${transferId}/receive`, {
      method: "POST", headers: jsonHeaders(whStaffActor),
      body: JSON.stringify({ items: items.map((i: { id: string; quantityRequested: number }) => ({ itemId: i.id, quantityReceived: i.quantityRequested })) }),
    });
    expect(receiveRes.status).toBe(201);
    expect((await receiveRes.json()).data.status).toBe("received");
  });

  // Wastage
  it("creates wastage note with cost calculation -> 201", async () => {
    const res = await app.request("http://localhost/api/warehouse/wastage", {
      method: "POST", headers: jsonHeaders(whStaffActor),
      body: JSON.stringify({
        warehouseId: whA, type: "spoilage",
        items: [
          { entityId, itemName: "Lettuce", quantity: 5, unitCost: 200, reason: "Wilted" },
          { entityId, itemName: "Tomatoes", quantity: 3, unitCost: 150, reason: "Mold" },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.totalCost).toBe(1450); // 5*200 + 3*150
    expect(body.data.noteNumber).toBe("WST-0001");
  });

  it("approves wastage note -> 201", async () => {
    const listRes = await app.request("http://localhost/api/warehouse/wastage", { headers: jsonHeaders(whStaffActor) });
    const noteId = (await listRes.json()).data[0].id;
    const res = await app.request(`http://localhost/api/warehouse/wastage/${noteId}/approve`, {
      method: "POST", headers: jsonHeaders(whAdminActor),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).data.approvedBy).toBe("wh-admin");
  });

  // Reconciliation
  it("creates reconciliation with variance -> 201", async () => {
    const res = await app.request("http://localhost/api/warehouse/reconciliations", {
      method: "POST", headers: jsonHeaders(whStaffActor),
      body: JSON.stringify({
        warehouseId: whA,
        items: [
          { entityId, itemName: "Flour 25kg", systemQuantity: 100, physicalQuantity: 95, notes: "5 bags unaccounted" },
          { entityId: "d4e5f6a7-b8c9-4d0e-af2a-3b4c5d6e7f8a", itemName: "Sugar 10kg", systemQuantity: 50, physicalQuantity: 50 },
        ],
      }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).data.reconciliationNumber).toBe("REC-0001");
  });

  it("reconciliation lifecycle: draft -> submitted -> approved (adjustments marked)", async () => {
    const listRes = await app.request("http://localhost/api/warehouse/reconciliations", { headers: jsonHeaders(whStaffActor) });
    const recId = (await listRes.json()).data[0].id;

    // Submit
    const submitRes = await app.request(`http://localhost/api/warehouse/reconciliations/${recId}/submit`, {
      method: "POST", headers: jsonHeaders(whStaffActor),
    });
    expect(submitRes.status).toBe(201);
    expect((await submitRes.json()).data.status).toBe("submitted");

    // Approve
    const approveRes = await app.request(`http://localhost/api/warehouse/reconciliations/${recId}/approve`, {
      method: "POST", headers: jsonHeaders(whAdminActor),
    });
    expect(approveRes.status).toBe(201);
    expect((await approveRes.json()).data.status).toBe("approved");

    // Verify items: flour has variance, sugar does not
    const getRes = await app.request(`http://localhost/api/warehouse/reconciliations/${recId}`, { headers: jsonHeaders(whStaffActor) });
    const items = (await getRes.json()).data.items;
    const flour = items.find((i: { itemName: string }) => i.itemName === "Flour 25kg");
    const sugar = items.find((i: { itemName: string }) => i.itemName === "Sugar 10kg");
    expect(flour.variance).toBe(-5);
    expect(flour.adjustmentMade).toBe(true);
    expect(sugar.variance).toBe(0);
    expect(sugar.adjustmentMade).toBe(false);
  });

  // Auth
  it("no permission -> 403", async () => {
    const res = await app.request("http://localhost/api/warehouse/transfers", {
      method: "POST", headers: jsonHeaders(testNoPermActor),
      body: JSON.stringify({ fromWarehouseId: whA, toWarehouseId: whB, items: [{ entityId, itemName: "X", quantityRequested: 1 }] }),
    });
    expect(res.status).toBe(403);
  });

  // Org isolation
  it("org isolation: other org sees 0 transfers", async () => {
    const otherOrg: import("@porulle/core").Actor = {
      type: "user", userId: "other", email: "o@o.local", name: "Other",
      vendorId: null, organizationId: "org_other", role: "staff", permissions: ["warehouse:read"],
    };
    const res = await app.request("http://localhost/api/warehouse/transfers", { headers: jsonHeaders(otherOrg) });
    expect(res.status).toBe(200);
    expect((await res.json()).data.length).toBe(0);
  });
});
