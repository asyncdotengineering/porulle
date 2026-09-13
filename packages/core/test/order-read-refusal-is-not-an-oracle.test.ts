import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestServer,
  makeRequest,
  parseJsonResponse,
  testActor,
} from "../src/test-utils/rest-api-test-utils.js";
import type { Actor } from "../src/auth/types.js";

/**
 * An addressed order read looked the row up BEFORE it authorized it, so the two refusals told a
 * caller apart: `403 You do not have access to this resource.` meant the order is real, and
 * `404 Order not found.` meant it is not.
 *
 * Entropy is the whole reason that mattered. A v4 uuid is not walked, but an ORDER NUMBER comes out
 * of a sequence — short, ordered, and guessable by construction — and `GET /api/orders/{idOrNumber}`
 * accepts either. So an anonymous caller could enumerate order numbers and read off how many orders
 * a store has taken and when, which is commercially sensitive for anyone selling on this framework
 * and is exactly the kind of thing that leaks before a single real order exists.
 *
 * The same reasoning already governs one branch BELOW this one: the guest-access window refuses a
 * stale cart secret with the identical error as a wrong one, "so a stale window is not an oracle
 * telling the caller their secret is valid". That instinct was right and simply did not reach far
 * enough up — the row's existence had already leaked before that branch was ever consulted.
 *
 * Every assertion here compares the two responses TO EACH OTHER rather than to a literal status.
 * Pinning each against its own expected value is what let them drift apart in the first place: both
 * were individually correct, and the defect lived only in the difference between them.
 */

const STORE_ID = "org_default";

/** A signed-in shopper who owns NO order here: `orders:read:own` over somebody else's row. */
const otherCustomer: Actor = {
  type: "user",
  userId: "oracle-other-customer",
  email: "someone-else@example.com",
  name: "Someone Else",
  vendorId: null,
  organizationId: STORE_ID,
  role: "customer",
  permissions: ["catalog:read", "orders:create", "orders:read:own", "customers:read:self"],
};

type Refusal = { status: number; code: string; message: string };

describe("an order read refuses identically whether or not the order exists", () => {
  let server: any;
  let kernel: any;
  let cleanup: () => Promise<void>;
  let realOrderId: string;
  let realOrderNumber: string;

  beforeAll(async () => {
    const result = await createTestServer({
      auth: {
        allowTestActor: true,
        defaultOrganizationId: STORE_ID,
        requireEmailVerification: false,
        storeResolver: (request: Request) => request.headers.get("x-store-id") ?? STORE_ID,
      },
    });
    server = result.server;
    kernel = result.kernel;
    cleanup = result.cleanup;
    await kernel.services.inventory.createWarehouse(
      { name: "Main", code: `O${Date.now() % 100000}` },
      testActor,
    );

    const entity = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/catalog/entities",
      body: {
        type: "product",
        slug: `oracle-${Date.now()}-${Math.round(performance.now() * 1000)}`,
        status: "active",
        metadata: { title: "Sari", basePrice: 4000 },
      },
      actor: testActor,
    });
    const entityId = (await parseJsonResponse<{ data: { id: string } }>(entity)).data.id;

    const created = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/orders",
      body: {
        currency: "USD",
        subtotal: 4000,
        taxTotal: 0,
        shippingTotal: 0,
        grandTotal: 4000,
        lineItems: [
          { entityId, entityType: "product", title: "Sari", quantity: 1, unitPrice: 4000, totalPrice: 4000 },
        ],
      },
      actor: testActor,
    });
    expect(created.status).toBe(201);
    const order = (await parseJsonResponse<{ data: { id: string; orderNumber: string } }>(created)).data;
    realOrderId = order.id;
    realOrderNumber = order.orderNumber;
  });

  afterAll(async () => {
    await cleanup();
  });

  async function refusal(path: string, actor?: Actor): Promise<Refusal> {
    const response = actor
      ? await makeRequest(server, { method: "GET", url: `http://localhost/api/orders/${path}`, actor })
      : await server.fetch(
          new Request(`http://localhost/api/orders/${path}`, { headers: { "x-store-id": STORE_ID } }),
        );
    const body = await parseJsonResponse<{ error?: { code: string; message: string } }>(response);
    return {
      status: response.status,
      code: body.error?.code ?? "(no error object)",
      message: body.error?.message ?? "(no message)",
    };
  }

  /**
   * The control the whole file rests on. If the fixture order were not readable by ANYONE, every
   * equality below would hold trivially over two identical refusals and the suite would be green
   * whether or not the oracle existed.
   */
  it("is a real order: the store's own operator reads it by id and by number", async () => {
    const byId = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/orders/${realOrderId}`,
      actor: testActor,
    });
    expect(byId.status).toBe(200);

    const byNumber = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/orders/${realOrderNumber}`,
      actor: testActor,
    });
    expect(byNumber.status).toBe(200);
    expect((await parseJsonResponse<{ data: { id: string } }>(byNumber)).data.id).toBe(realOrderId);
  });

  it("tells an anonymous caller nothing by ORDER NUMBER — the door that is enumerable", async () => {
    const real = await refusal(realOrderNumber);
    const fake = await refusal(`${realOrderNumber}-does-not-exist`);

    expect(real).toEqual(fake);
    expect(real.message).not.toContain(realOrderNumber);
  });

  it("tells an anonymous caller nothing by id", async () => {
    const real = await refusal(realOrderId);
    const fake = await refusal(crypto.randomUUID());

    expect(real).toEqual(fake);
    expect(real.message).not.toContain(realOrderId);
  });

  it("tells a signed-in shopper nothing about an order that is not theirs", async () => {
    const real = await refusal(realOrderNumber, otherCustomer);
    const fake = await refusal(`${realOrderNumber}-does-not-exist`, otherCustomer);

    expect(real).toEqual(fake);
    expect(real.message).not.toContain(realOrderNumber);
  });

  /**
   * Anonymous and signed-in-but-not-the-owner must also agree with EACH OTHER. Without this row a
   * refusal could still separate "no credential" from "wrong credential", which tells an enumerator
   * that the account they are using is the wrong one rather than that the order is not there.
   */
  it("refuses a stranger and a wrong shopper with one voice", async () => {
    expect(await refusal(realOrderNumber)).toEqual(await refusal(realOrderNumber, otherCustomer));
  });
});
