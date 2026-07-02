import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  createTestServer,
  makeRequest,
  testActor,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";

// Issue #47 — porulle had no document generation: no receipt/invoice
// rendering and no fiscal invoice numbering. The documents module renders
// HTML receipts and PDF invoices from an order (serverless-safe, no Node-only
// APIs) with per-org sequential invoice numbers allocated atomically and
// idempotently per order.
describe("Issue #47 — order documents: invoice PDF/HTML + fiscal numbering", () => {
  let server: any;
  let kernel: any;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const result = await createTestServer();
    server = result.server;
    kernel = result.kernel;
    cleanup = result.cleanup;

    // Store branding consumed by document rendering (issue #49 settings)
    await makeRequest(server, {
      method: "PATCH",
      url: "http://localhost/api/settings/branding",
      body: {
        storeName: "Ordereka Boutique",
        receiptHeader: "Ordereka — Colombo 03",
        receiptFooter: "No returns after 14 days",
        taxId: "VAT-104566789",
      },
      actor: testActor,
    });
  });

  afterAll(async () => {
    await cleanup();
  });

  async function createEntity(): Promise<string> {
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/catalog/entities",
      body: { type: "product", slug: `e47-${Date.now()}-${Math.round(performance.now() * 1000)}`, metadata: { title: "E" } },
      actor: testActor,
    });
    return (await parseJsonResponse<{ data: { id: string } }>(res)).data.id;
  }

  async function createOrder(): Promise<string> {
    const entityId = await createEntity();
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/orders",
      body: {
        currency: "LKR",
        subtotal: 2000,
        taxTotal: 200,
        shippingTotal: 0,
        grandTotal: 2200,
        lineItems: [
          { entityId, entityType: "product", title: "Silk Saree", quantity: 2, unitPrice: 1000, totalPrice: 2000, taxAmount: 200 },
        ],
      },
      actor: testActor,
    });
    expect(res.status).toBe(201);
    return (await parseJsonResponse<{ data: { id: string } }>(res)).data.id;
  }

  it("returns a rendered PDF invoice with a sequential fiscal number", async () => {
    const orderA = await createOrder();
    const orderB = await createOrder();

    const pdfRes = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/orders/${orderA}/invoice.pdf`,
      actor: testActor,
    });
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers.get("content-type")).toContain("application/pdf");
    const bytes = new Uint8Array(await pdfRes.arrayBuffer());
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text.startsWith("%PDF-")).toBe(true);
    // Uncompressed content stream — the invoice number is visible in the bytes
    expect(text).toContain("INV-000001");
    expect(text).toContain("Ordereka Boutique");

    // Re-requesting the same order returns the SAME number (idempotent issue)
    const again = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/orders/${orderA}/invoice.pdf`,
      actor: testActor,
    });
    const againText = new TextDecoder("latin1").decode(new Uint8Array(await again.arrayBuffer()));
    expect(againText).toContain("INV-000001");

    // The next order gets the next sequential number
    const pdfB = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/orders/${orderB}/invoice.pdf`,
      actor: testActor,
    });
    const textB = new TextDecoder("latin1").decode(new Uint8Array(await pdfB.arrayBuffer()));
    expect(textB).toContain("INV-000002");
  });

  it("renders an HTML invoice and receipt with store branding", async () => {
    const orderId = await createOrder();

    const htmlRes = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/orders/${orderId}/invoice.html`,
      actor: testActor,
    });
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get("content-type")).toContain("text/html");
    const html = await htmlRes.text();
    expect(html).toContain("Ordereka Boutique");
    expect(html).toContain("VAT-104566789");
    expect(html).toContain("Silk Saree");

    const receiptRes = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/orders/${orderId}/receipt.html`,
      actor: testActor,
    });
    expect(receiptRes.status).toBe(200);
    const receipt = await receiptRes.text();
    expect(receipt).toContain("Ordereka — Colombo 03");
    expect(receipt).toContain("No returns after 14 days");
    expect(receipt).toContain("Silk Saree");
  });

  it("404s for a missing order and escapes HTML in order data", async () => {
    const missing = await makeRequest(server, {
      method: "GET",
      url: "http://localhost/api/orders/11111111-1111-4111-8111-111111111111/invoice.pdf",
      actor: testActor,
    });
    expect(missing.status).toBe(404);

    const entityId = await createEntity();
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/orders",
      body: {
        currency: "LKR",
        subtotal: 100,
        taxTotal: 0,
        shippingTotal: 0,
        grandTotal: 100,
        lineItems: [
          { entityId, entityType: "product", title: "<script>alert(1)</script>", quantity: 1, unitPrice: 100, totalPrice: 100 },
        ],
      },
      actor: testActor,
    });
    const orderId = (await parseJsonResponse<{ data: { id: string } }>(res)).data.id;
    const html = await (
      await makeRequest(server, {
        method: "GET",
        url: `http://localhost/api/orders/${orderId}/receipt.html`,
        actor: testActor,
      })
    ).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("emails the invoice through the configured email adapter", async () => {
    const orderId = await createOrder();
    const res = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/orders/${orderId}/invoice/email`,
      body: { to: "customer@example.com" },
      actor: testActor,
    });
    expect(res.status).toBe(200);
    const json = await parseJsonResponse<{ data: any }>(res);
    expect(json.data.sent).toBe(true);
    expect(json.data.invoiceNumber).toMatch(/^INV-\d{6}$/);
  });
});
