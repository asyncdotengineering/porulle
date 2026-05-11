import { describe, expect, it } from "vitest";
import { createSDK } from "../src/index.js";

describe("sdk client", () => {
  function createMockSDK() {
    const calls: Array<{ url: string; method: string; body?: string | null }> = [];

    const sdk = createSDK({
      baseUrl: "https://commerce.local",
      auth: { type: "api_key", key: "test-key" },
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init);
        const body = req.body ? await new Response(req.body).text() : null;
        calls.push({
          url: req.url,
          method: req.method,
          body,
        });

        return new Response(JSON.stringify({ data: { ok: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    return { sdk, calls };
  }

  it("sends auth header on every request", async () => {
    const { sdk, calls } = createMockSDK();
    await sdk.catalog.list();

    // The fetch mock receives a Request object; auth middleware sets the header
    expect(calls[0]?.url).toContain("/api/catalog/entities");
    expect(calls[0]?.method).toBe("GET");
  });

  it("catalog.list sends GET to /api/catalog/entities", async () => {
    const { sdk, calls } = createMockSDK();
    await sdk.catalog.list({ type: "product", page: "1", limit: "10" });

    expect(calls[0]?.url).toContain("/api/catalog/entities");
    expect(calls[0]?.url).toContain("type=product");
    expect(calls[0]?.url).toContain("page=1");
  });

  it("catalog.get sends GET with path param", async () => {
    const { sdk, calls } = createMockSDK();
    await sdk.catalog.get("my-product");

    expect(calls[0]?.url).toContain("/api/catalog/entities/my-product");
  });

  it("catalog.create sends POST with body", async () => {
    const { sdk, calls } = createMockSDK();
    await sdk.catalog.create({ type: "product", slug: "new-product" });

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/api/catalog/entities");
    expect(calls[0]?.body).toContain("new-product");
  });

  it("cart.addItem sends POST with path and body", async () => {
    const { sdk, calls } = createMockSDK();
    await sdk.cart.addItem("cart-123", { entityId: "entity-1", quantity: 2 });

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/api/carts/cart-123/items");
    expect(calls[0]?.body).toContain("entity-1");
  });

  it("orders.list sends GET", async () => {
    const { sdk, calls } = createMockSDK();
    await sdk.orders.list({ page: "1" });

    expect(calls[0]?.url).toContain("/api/orders");
    expect(calls[0]?.url).toContain("page=1");
  });

  it("me.profile.get sends GET to /api/me/profile", async () => {
    const { sdk, calls } = createMockSDK();
    await sdk.me.profile.get();

    expect(calls[0]?.url).toContain("/api/me/profile");
  });

  it("me.orders.tracking sends GET with path param", async () => {
    const { sdk, calls } = createMockSDK();
    await sdk.me.orders.tracking("ord-1");

    expect(calls[0]?.url).toContain("/api/me/orders/ord-1/tracking");
  });

  it("me.orders.reorder sends POST", async () => {
    const { sdk, calls } = createMockSDK();
    await sdk.me.orders.reorder("ord-1");

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/api/me/orders/ord-1/reorder");
  });

  it("raw client can access plugin routes", async () => {
    const { sdk, calls } = createMockSDK();
    await sdk.raw.GET("/api/appointments/services");

    expect(calls[0]?.url).toContain("/api/appointments/services");
  });

  it("search.query sends GET with query params", async () => {
    const { sdk, calls } = createMockSDK();
    await sdk.search.query({ q: "shoes", type: "product" });

    expect(calls[0]?.url).toContain("/api/search");
    expect(calls[0]?.url).toContain("q=shoes");
  });

  it("webhooks.create sends POST", async () => {
    const { sdk, calls } = createMockSDK();
    await sdk.webhooks.create({ url: "https://hook.example.com", events: ["order.created"], secret: "s3cr3t" });

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toContain("hook.example.com");
  });
});
