import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  createTestServer,
  makeRequest,
  testActor,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";

// Issue #43 — abandoned-checkout recovery was impossible: no cart list, no
// status/age filters, no shopper identity on the cart, no recovery primitive.
// GET /api/carts (status/olderThan/hasCustomer filters + email identity) and
// POST /api/carts/{id}/recover now exist.
describe("Issue #43 — cart list + abandoned-checkout recovery", () => {
  let server: any;
  let kernel: any;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const result = await createTestServer();
    server = result.server;
    kernel = result.kernel;
    cleanup = result.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  async function createCart(body: Record<string, unknown> = {}): Promise<any> {
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/carts",
      body: { currency: "USD", ...body },
      actor: testActor,
    });
    expect(res.status).toBe(201);
    return (await parseJsonResponse<{ data: any }>(res)).data;
  }

  it("lists carts with status filter and shopper email identity", async () => {
    const abandoned = await createCart({ email: "shopper@example.com" });
    const active = await createCart({ email: "active@example.com" });
    const abandonResult = await kernel.services.cart.abandon(abandoned.id, testActor);
    expect(abandonResult.ok).toBe(true);

    const abandonedList = await parseJsonResponse<{ data: any[] }>(
      await makeRequest(server, { method: "GET", url: "http://localhost/api/carts?status=abandoned", actor: testActor }),
    );
    const abandonedIds = abandonedList.data.map((c) => c.id);
    expect(abandonedIds).toContain(abandoned.id);
    expect(abandonedIds).not.toContain(active.id);
    const listedCart = abandonedList.data.find((c) => c.id === abandoned.id);
    expect(listedCart.email).toBe("shopper@example.com");

    const activeList = await parseJsonResponse<{ data: any[] }>(
      await makeRequest(server, { method: "GET", url: "http://localhost/api/carts?status=active", actor: testActor }),
    );
    expect(activeList.data.map((c: any) => c.id)).toContain(active.id);
    expect(activeList.data.map((c: any) => c.id)).not.toContain(abandoned.id);
  });

  it("filters carts by age (olderThan) and customer linkage (hasCustomer)", async () => {
    const cart = await createCart({ email: "aging@example.com" });

    const futureCutoff = new Date(Date.now() + 60_000).toISOString();
    const pastCutoff = new Date(Date.now() - 3_600_000).toISOString();

    const olderThanFuture = await parseJsonResponse<{ data: any[] }>(
      await makeRequest(server, { method: "GET", url: `http://localhost/api/carts?olderThan=${encodeURIComponent(futureCutoff)}`, actor: testActor }),
    );
    expect(olderThanFuture.data.map((c: any) => c.id)).toContain(cart.id);

    const olderThanPast = await parseJsonResponse<{ data: any[] }>(
      await makeRequest(server, { method: "GET", url: `http://localhost/api/carts?olderThan=${encodeURIComponent(pastCutoff)}`, actor: testActor }),
    );
    expect(olderThanPast.data.map((c: any) => c.id)).not.toContain(cart.id);

    // testActor is staff and passed no customerId — cart has no customer
    const withCustomer = await parseJsonResponse<{ data: any[] }>(
      await makeRequest(server, { method: "GET", url: "http://localhost/api/carts?hasCustomer=true", actor: testActor }),
    );
    expect(withCustomer.data.map((c: any) => c.id)).not.toContain(cart.id);

    const withoutCustomer = await parseJsonResponse<{ data: any[] }>(
      await makeRequest(server, { method: "GET", url: "http://localhost/api/carts?hasCustomer=false", actor: testActor }),
    );
    expect(withoutCustomer.data.map((c: any) => c.id)).toContain(cart.id);
  });

  it("recovers an abandoned cart: reactivates it and returns a resume secret", async () => {
    const cart = await createCart({ email: "comeback@example.com" });
    await kernel.services.cart.abandon(cart.id, testActor);

    const res = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/carts/${cart.id}/recover`,
      actor: testActor,
    });
    expect(res.status).toBe(200);
    const recovery = (await parseJsonResponse<{ data: any }>(res)).data;
    expect(recovery.cartId).toBe(cart.id);
    expect(recovery.status).toBe("active");
    expect(typeof recovery.secret).toBe("string");
    expect(recovery.secret.length).toBeGreaterThan(10);

    // The secret gates guest access to resume the cart
    const resume = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/carts/${cart.id}?secret=${recovery.secret}`,
    });
    expect(resume.status).toBe(200);
    const resumed = (await parseJsonResponse<{ data: any }>(resume)).data;
    expect(resumed.status).toBe("active");
  });

  it("refuses to recover a checked-out cart", async () => {
    const cart = await createCart({ email: "done@example.com" });
    await kernel.services.cart.markAsCheckedOut(cart.id);

    const res = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/carts/${cart.id}/recover`,
      actor: testActor,
    });
    expect(res.status).toBe(422);
  });
});
