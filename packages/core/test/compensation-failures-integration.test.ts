import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { CommerceValidationError } from "../src/kernel/errors.js";
import { Ok } from "../src/kernel/result.js";
import type { PaymentAdapter } from "../src/modules/payments/adapter.js";
import type { InventoryService } from "../src/modules/inventory/service.js";
import {
  createTestServer,
  makeRequest,
  parseJsonResponse,
  testActor,
} from "../src/test-utils/rest-api-test-utils.js";

type TestServerBundle = Awaited<ReturnType<typeof createTestServer>>;

const succeedingPayments: PaymentAdapter = {
  providerId: "test-payments",
  async createPaymentIntent(params) {
    return Ok({
      id: "pi_comp_test",
      status: "requires_capture",
      amount: params.amount,
      currency: params.currency,
      clientSecret: "secret_test",
    });
  },
  async capturePayment(_paymentIntentId, amount) {
    return Ok({
      id: "pi_comp_test",
      status: "succeeded",
      amountCaptured: amount ?? 1000,
    });
  },
  async refundPayment() {
    return Ok({ id: "re_test", status: "succeeded", amountRefunded: 0 });
  },
  async cancelPaymentIntent() {
    return Ok(undefined);
  },
  async verifyWebhook() {
    return Ok({ id: "evt", type: "test", data: {} });
  },
};

const failingDefaultCapture: PaymentAdapter = {
  providerId: "default-capture-fails",
  async createPaymentIntent(params) {
    return Ok({
      id: "pi_unused",
      status: "requires_capture",
      amount: params.amount,
      currency: params.currency,
    });
  },
  async capturePayment() {
    return {
      ok: false,
      error: new CommerceValidationError("Simulated capture failure for compensation test."),
    };
  },
  async refundPayment() {
    return Ok({ id: "re", status: "succeeded", amountRefunded: 0 });
  },
  async cancelPaymentIntent() {
    return Ok(undefined);
  },
  async verifyWebhook() {
    return Ok({ id: "evt", type: "test", data: {} });
  },
};

describe("compensation failures — persistence + admin API (PGlite)", () => {
  let server: TestServerBundle["server"];
  let kernel: TestServerBundle["kernel"];
  let cleanup: () => Promise<void>;
  let entityId: string;
  let originalRelease: InventoryService["release"];

  beforeAll(async () => {
    const result = await createTestServer({
      payments: [failingDefaultCapture, succeedingPayments],
    });
    server = result.server;
    kernel = result.kernel;
    cleanup = result.cleanup;
    originalRelease = kernel.services.inventory.release.bind(kernel.services.inventory);
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    const inv = kernel.services.inventory as InventoryService;
    inv.release = (async () => {
      throw new Error("forced inventory release failure during compensation");
    }) as InventoryService["release"];

    const createResponse = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/catalog/entities",
      body: {
        type: "product",
        slug: `cf-int-${Date.now()}`,
        attributes: { title: "Compensation Test Product" },
        metadata: { basePrice: 1000 },
      },
      actor: testActor,
    });
    const created = await parseJsonResponse<{ data: { id: string } }>(createResponse);
    entityId = created.data.id;

    await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" });
    await kernel.services.inventory.adjust(
      { entityId, adjustment: 50, reason: "stock" },
      testActor,
    );
  });

  afterEach(() => {
    kernel.services.inventory.release = originalRelease;
  });

  it("records compensation failure, lists via admin GET, resolves, second resolve is 409", async () => {
    const cartRes = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/carts",
      body: { currency: "USD" },
      actor: testActor,
    });
    const cart = await parseJsonResponse<{ data: { id: string } }>(cartRes);

    await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/carts/${cart.data.id}/items`,
      body: { entityId, quantity: 1 },
      actor: testActor,
    });

    const checkoutRes = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/checkout",
      body: {
        cartId: cart.data.id,
        paymentMethodId: "test-payments",
        currency: "USD",
        shippingAddress: {
          country: "US",
          postalCode: "90001",
          state: "CA",
          city: "Los Angeles",
          line1: "123 Test St",
        },
      },
      actor: testActor,
    });

    expect(checkoutRes.status).toBe(201);
    const checkoutJson = await parseJsonResponse<{
      data: { id: string };
      meta?: { hookErrors: Array<{ hookName: string; message: string }> };
    }>(checkoutRes);
    expect(checkoutJson.meta?.hookErrors?.length).toBeGreaterThan(0);
    const checkoutErr = checkoutJson.meta!.hookErrors!.find(
      (e) => e.hookName === "completeCheckout",
    );
    expect(checkoutErr?.message).toContain("Payment capture failed");

    const listRes = await makeRequest(server, {
      method: "GET",
      url: "http://localhost/api/admin/compensation-failures?resolved=false&limit=20",
      actor: testActor,
    });
    expect(listRes.status).toBe(200);
    const listJson = await parseJsonResponse<{
      items: Array<{
        id: string;
        chainName: string;
        stepName: string;
        correlationId: string;
        compensationError: { message: string };
      }>;
      total: number;
    }>(listRes);

    expect(listJson.total).toBeGreaterThanOrEqual(1);
    const row = listJson.items.find((i) => i.chainName === "checkout");
    expect(row).toBeDefined();
    expect(row!.stepName).toBe("reserve-inventory");
    expect(row!.compensationError.message).toContain("forced inventory release");
    expect(row!.correlationId).toBeTruthy();

    expect(row!.correlationId).toBe(checkoutJson.data.id);
    const orderLookup = await kernel.services.orders.getById(row!.correlationId, testActor);
    expect(orderLookup.ok).toBe(true);

    const resolve1 = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/admin/compensation-failures/${row!.id}/resolve`,
      body: { notes: "verified inventory" },
      actor: testActor,
    });
    expect(resolve1.status).toBe(200);
    const resolvedJson = await parseJsonResponse<{
      failure: { resolvedAt: string | null };
    }>(resolve1);
    expect(resolvedJson.failure.resolvedAt).not.toBeNull();

    const resolve2 = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/admin/compensation-failures/${row!.id}/resolve`,
      body: {},
      actor: testActor,
    });
    expect(resolve2.status).toBe(409);
  });
});
