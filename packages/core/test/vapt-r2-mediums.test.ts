import { beforeEach, describe, expect, it, vi } from "vitest";
import { Ok } from "../src/kernel/result.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createServer } from "../src/runtime/server.js";
import { createAuth } from "../src/auth/setup.js";
import { createPGliteTestConfig, createTestConfig } from "../src/test-utils/create-test-config.js";
import { MediaService } from "../src/modules/media/service.js";
import type { Actor } from "../src/auth/types.js";

const staffActor: Actor = {
  type: "user",
  userId: "staff-vapt-r2",
  email: "staff@local.test",
  name: "Staff",
  vendorId: null,
  organizationId: null,
  role: "staff",
  permissions: ["*:*"],
};

const customerActor: Actor = {
  type: "user",
  userId: "customer-vapt-r2",
  email: "customer@local.test",
  name: "Customer",
  vendorId: null,
  organizationId: "org_default",
  role: "customer",
  permissions: ["media:write"],
};

function toArrayBuffer(bytes: number[]): ArrayBuffer {
  const arr = new Uint8Array(bytes);
  return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength);
}

describe("VAPT r2 medium closures", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("caps refund amount to amountCaptured", async () => {
    const refundAmounts: number[] = [];
    const { config, cleanup } = await createPGliteTestConfig({
      payments: [{
        providerId: "test-payments",
        async createPaymentIntent() {
          return Ok({ id: "pi_1", status: "requires_capture", amount: 100, currency: "USD" });
        },
        async capturePayment() {
          return Ok({ id: "pi_1", status: "succeeded", amountCaptured: 100 });
        },
        async refundPayment(_paymentId: string, amount: number) {
          refundAmounts.push(amount);
          return Ok({ id: "re_1", status: "succeeded", amountRefunded: amount });
        },
        async cancelPaymentIntent() {
          return Ok(undefined);
        },
        async verifyWebhook() {
          return Ok({ id: "evt_1", type: "payment.succeeded", data: {} });
        },
      }],
    });

    try {
      const kernel = createKernel(config);
      const entity = await kernel.services.catalog.create(
        { type: "product", slug: `refund-cap-${Date.now()}`, attributes: { title: "Product" }, metadata: {} },
        staffActor,
      );
      expect(entity.ok).toBe(true);
      if (!entity.ok) return;

      const order = await kernel.services.orders.create({
        currency: "USD",
        subtotal: 100,
        taxTotal: 0,
        shippingTotal: 0,
        discountTotal: 0,
        grandTotal: 100,
        paymentIntentId: "pi_1",
        metadata: {},
        lineItems: [{
          entityId: entity.value.id,
          entityType: "product",
          title: "Product",
          quantity: 1,
          unitPrice: 100,
          totalPrice: 100,
        }],
      }, staffActor);
      expect(order.ok).toBe(true);
      if (!order.ok) return;

      const updated = await kernel.services.orders.updateOrder(order.value.id, { amountCaptured: 50 }, staffActor);
      expect(updated.ok).toBe(true);

      const cancelled = await kernel.services.orders.cancel(order.value.id, staffActor, "test_refund_cap");
      expect(cancelled.ok).toBe(true);
      expect(refundAmounts.at(-1)).toBe(50);
    } finally {
      await cleanup();
    }
  });

  it("validates media mime by magic bytes and svg policy", async () => {
    const uploadedTypes: string[] = [];
    const storage = {
      providerId: "test-storage",
      async upload(key: string, data: ArrayBuffer, contentType: string) {
        uploadedTypes.push(contentType);
        return Ok({ key, url: `http://localhost/${key}`, contentType, size: data.byteLength });
      },
      async getUrl(key: string) { return Ok(`http://localhost/${key}`); },
      async getSignedUrl(key: string) { return Ok(`http://localhost/${key}`); },
      async delete() { return Ok(undefined); },
      async list() { return Ok([]); },
    };
    const repository = {
      async createAsset() { return undefined; },
      async findAssetById() { return undefined; },
      async removeAllMediaByAssetId() { return undefined; },
      async deleteAsset() { return undefined; },
      async createEntityMedia() { return undefined; },
    };
    const catalogRepository = {
      async findEntityById() { return { id: "entity" }; },
    };

    const service = new MediaService({
      repository: repository as never,
      catalogRepository: catalogRepository as never,
      storage: storage as never,
      config: await createTestConfig(),
    });

    const png = await service.upload({
      filename: "image.png",
      contentType: "image/png",
      data: toArrayBuffer([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
    }, customerActor);
    expect(png.ok).toBe(true);
    expect(uploadedTypes.at(-1)).toBe("image/png");

    const mismatch = await service.upload({
      filename: "image.jpg",
      contentType: "image/png",
      data: toArrayBuffer([0xff, 0xd8, 0xff, 0xdb]),
    }, customerActor);
    expect(mismatch.ok).toBe(false);

    const svg = await service.upload({
      filename: "x.svg",
      contentType: "image/svg+xml",
      data: toArrayBuffer(Array.from(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))),
    }, customerActor);
    expect(svg.ok).toBe(false);

    const serviceWithSvg = new MediaService({
      repository: repository as never,
      catalogRepository: catalogRepository as never,
      storage: storage as never,
      config: await createTestConfig({ media: { allowSvg: true, allowedMimeTypes: ["image/svg+xml"] } }),
    });
    const allowedSvg = await serviceWithSvg.upload({
      filename: "ok.svg",
      contentType: "image/svg+xml",
      data: toArrayBuffer(Array.from(new TextEncoder().encode("<svg></svg>"))),
    }, customerActor);
    expect(allowedSvg.ok).toBe(true);
  });

  it("warns when requireEmailVerification is false in production", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const { config, cleanup } = await createPGliteTestConfig({
      auth: { requireEmailVerification: false },
    });
    try {
      const kernel = createKernel(config);
      createAuth(kernel.database, config);
      expect(warnSpy).toHaveBeenCalledOnce();
    } finally {
      process.env.NODE_ENV = prev;
      await cleanup();
    }
  });

  it("enforces per-email sign-in rate limit and applies csp header", async () => {
    const { app } = await createServer(await createTestConfig({
      auth: { trustedOrigins: ["http://localhost"] },
      rateLimits: { auth: 100, signInPerEmail: 10 },
      security: { csp: { default: "default-src 'self'" } },
    }));

    for (let i = 0; i < 10; i++) {
      const res = await app.request("http://localhost/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost",
          "x-forwarded-for": `10.0.0.${i + 1}`,
        },
        body: JSON.stringify({ email: "rate-limit@local.test", password: "x" }),
      });
      expect(res.status).not.toBe(429);
    }

    const blocked = await app.request("http://localhost/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
        "x-forwarded-for": "10.0.0.11",
      },
      body: JSON.stringify({ email: "rate-limit@local.test", password: "x" }),
    });
    expect(blocked.status).toBe(429);

    const health = await app.request("http://localhost/api/health");
    expect(health.headers.get("content-security-policy")).toBe("default-src 'self'");
  });
});
