import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  createTestServer,
  makeRequest,
  testActor,
  noPermActor,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";
import { inventoryLevels } from "../src/modules/inventory/schema.js";

// Issue #48 — the analytics module had a query engine but no canned
// operational reports; every store rebuilt ~1,000 LOC of raw SQL. The retail
// reports pack ships daily journal, tax summary, inventory aging,
// sell-through, reorder-needed and staff sales as REST reports, calendar-
// bucketed in the store's timezone (settings.general.timezone) with
// prior-period deltas.
describe("Issue #48 — canned retail reports + store timezone", () => {
  let server: any;
  let kernel: any;
  let cleanup: () => Promise<void>;
  let entityId: string;

  beforeAll(async () => {
    const result = await createTestServer();
    server = result.server;
    kernel = result.kernel;
    cleanup = result.cleanup;

    // Store timezone (issue #49 settings module)
    await makeRequest(server, {
      method: "PATCH",
      url: "http://localhost/api/settings/general",
      body: { timezone: "Asia/Colombo", currency: "LKR" },
      actor: testActor,
    });

    // One product entity used across reports
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/catalog/entities",
      body: { type: "product", slug: `e48-${Date.now()}`, metadata: { title: "Saree" } },
      actor: testActor,
    });
    entityId = (await parseJsonResponse<{ data: { id: string } }>(res)).data.id;

    // Two orders today (one attributed to a staff member), each 2200 gross / 200 tax
    for (const staffId of ["staff-jane", null]) {
      const orderRes = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/orders",
        body: {
          currency: "LKR",
          subtotal: 2000,
          taxTotal: 200,
          shippingTotal: 0,
          grandTotal: 2200,
          ...(staffId ? { metadata: { staffId } } : {}),
          lineItems: [
            { entityId, entityType: "product", title: "Silk Saree", quantity: 2, unitPrice: 1000, totalPrice: 2000, taxAmount: 200 },
          ],
        },
        actor: testActor,
      });
      expect(orderRes.status).toBe(201);
    }

    // Inventory row: needs reorder AND aged (no restock in 100 days)
    const whRes = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/inventory/warehouses",
      body: { code: "MAIN", name: "Main store" },
      actor: testActor,
    });
    const warehouseId = (await parseJsonResponse<{ data: { id: string } }>(whRes)).data.id;
    const db = kernel.database.db;
    await db.insert(inventoryLevels).values([
      {
        organizationId: "org_default",
        entityId,
        warehouseId,
        quantityOnHand: 2,
        quantityReserved: 0,
        reorderThreshold: 5,
        reorderQuantity: 20,
        lastRestockedAt: new Date(Date.now() - 100 * 24 * 3600 * 1000),
      },
    ]);
  });

  afterAll(async () => {
    await cleanup();
  });

  async function fetchReport(name: string, query = ""): Promise<any> {
    const res = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/analytics/reports/${name}${query}`,
      actor: testActor,
    });
    expect(res.status).toBe(200);
    return (await parseJsonResponse<{ data: any }>(res)).data;
  }

  it("lists the available reports", async () => {
    const res = await makeRequest(server, {
      method: "GET",
      url: "http://localhost/api/analytics/reports",
      actor: testActor,
    });
    expect(res.status).toBe(200);
    const names = (await parseJsonResponse<{ data: Array<{ name: string }> }>(res)).data.map((r) => r.name);
    for (const expected of ["daily-journal", "tax-summary", "inventory-aging", "sell-through", "reorder-needed", "staff-sales"]) {
      expect(names).toContain(expected);
    }
  });

  it("daily journal for 'today' in the store timezone, with prior-period deltas", async () => {
    const report = await fetchReport("daily-journal");
    expect(report.timezone).toBe("Asia/Colombo");
    expect(report.summary.orderCount).toBeGreaterThanOrEqual(2);
    expect(report.summary.grossSales).toBeGreaterThanOrEqual(4400);
    expect(report.summary.tax).toBeGreaterThanOrEqual(400);
    // prior-period block always present (zeroes for an empty yesterday)
    expect(report.previous).toBeDefined();
    expect(report.delta.grossSales).toBe(report.summary.grossSales - report.previous.grossSales);
    // per-order journal rows
    expect(report.orders.length).toBeGreaterThanOrEqual(2);
    expect(report.orders[0]).toHaveProperty("orderNumber");
  });

  it("tax summary over a range with per-day buckets in store timezone", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Colombo" }).format(new Date());
    const report = await fetchReport("tax-summary", `?from=${today}&to=${today}`);
    expect(report.totals.tax).toBeGreaterThanOrEqual(400);
    expect(report.days.length).toBe(1);
    expect(report.days[0].day).toBe(today);
    expect(report.previous).toBeDefined();
  });

  it("inventory aging buckets stock by days since restock", async () => {
    const report = await fetchReport("inventory-aging");
    const bucket = report.buckets.find((b: any) => b.bucket === "90+");
    expect(bucket.quantityOnHand).toBeGreaterThanOrEqual(2);
    const row = report.rows.find((r: any) => r.entityId === entityId);
    expect(row.ageDays).toBeGreaterThanOrEqual(99);
  });

  it("sell-through compares units sold against on-hand stock", async () => {
    const report = await fetchReport("sell-through");
    const row = report.rows.find((r: any) => r.entityId === entityId);
    expect(row.unitsSold).toBeGreaterThanOrEqual(4);
    expect(row.onHand).toBe(2);
    expect(row.sellThroughRate).toBeCloseTo(row.unitsSold / (row.unitsSold + 2), 5);
  });

  it("reorder-needed lists rows at or under their threshold", async () => {
    const report = await fetchReport("reorder-needed");
    const row = report.rows.find((r: any) => r.entityId === entityId);
    expect(row).toBeDefined();
    expect(row.available).toBe(2);
    expect(row.reorderThreshold).toBe(5);
    expect(row.reorderQuantity).toBe(20);
  });

  it("staff sales groups orders by metadata.staffId", async () => {
    const report = await fetchReport("staff-sales");
    const jane = report.rows.find((r: any) => r.staffId === "staff-jane");
    expect(jane.orderCount).toBeGreaterThanOrEqual(1);
    expect(jane.revenue).toBeGreaterThanOrEqual(2200);
  });

  it("rejects unknown reports and unauthorized actors", async () => {
    const unknown = await makeRequest(server, {
      method: "GET",
      url: "http://localhost/api/analytics/reports/nope",
      actor: testActor,
    });
    expect(unknown.status).toBe(422);

    const forbidden = await makeRequest(server, {
      method: "GET",
      url: "http://localhost/api/analytics/reports/daily-journal",
      actor: noPermActor,
    });
    expect(forbidden.status).toBe(403);
  });
});
