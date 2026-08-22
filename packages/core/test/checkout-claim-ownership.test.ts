import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createTestServer,
  makeRequest,
  testActor,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";
import { Ok } from "../src/kernel/result.js";
import { carts } from "../src/modules/cart/schema.js";
import { orders } from "../src/modules/orders/schema.js";

/**
 * Red-team round 6, breach 1 (`vapt/redteam-rbac-guest-report.md`): one cart
 * produced two orders and two payment intents. The `active → checking_out`
 * compare-and-swap was sound; the failure path was not. Every pipeline failure
 * called `releaseCheckoutClaim(cartId)`, which reset `checking_out → active`
 * with no notion of who held the claim — so a losing attempt's error unwound
 * the in-flight winner's claim and a third attempt walked into the gap.
 *
 * The claim now carries the winning attempt's checkout id, and releasing is
 * conditional on holding it.
 */
describe("checkout claim ownership (round 6 breach 1 — double charge)", () => {
  let server: any;
  let kernel: any;
  let cleanup: () => Promise<void>;
  let paymentIntents = 0;

  const spyPayments = {
    providerId: "spy-payments",
    async createPaymentIntent(p: { amount: number; currency: string }) {
      paymentIntents += 1;
      return Ok({ id: `pi_${paymentIntents}`, status: "succeeded", amount: p.amount, currency: p.currency, clientSecret: "s" });
    },
    async capturePayment() {
      return Ok({ id: "pi_spy", status: "succeeded", amountCaptured: 0 });
    },
    async refundPayment(_id: string, amount: number) {
      return Ok({ id: "re_spy", status: "succeeded", amountRefunded: amount });
    },
    async cancelPaymentIntent() {
      return Ok(undefined);
    },
    async verifyWebhook() {
      return Ok({ id: "evt", type: "x", data: {} });
    },
  };

  const failingPayments = {
    ...spyPayments,
    providerId: "failing-payments",
    async createPaymentIntent() {
      return { ok: false as const, error: new Error("Card declined") };
    },
  };

  beforeAll(async () => {
    const result = await createTestServer({ payments: [spyPayments, failingPayments] as never });
    server = result.server;
    kernel = result.kernel;
    cleanup = result.cleanup;
    await kernel.services.inventory.createWarehouse({ name: "Main", code: `M${Date.now() % 100000}` });
  });

  afterAll(async () => {
    await cleanup();
  });

  async function createEntity(): Promise<string> {
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/catalog/entities",
      body: {
        type: "product",
        slug: `claim-${Date.now()}-${Math.round(performance.now() * 1000)}`,
        metadata: { title: "Hoodie", basePrice: 2500 },
      },
      actor: testActor,
    });
    return (await parseJsonResponse<{ data: { id: string } }>(res)).data.id;
  }

  async function createCartWithItem(): Promise<string> {
    const entityId = await createEntity();
    await kernel.services.inventory.adjust(
      { entityId, adjustment: 10, reason: "stock" },
      testActor,
    );
    const cart = await kernel.services.cart.create({ currency: "USD" }, testActor);
    expect(cart.ok).toBe(true);
    const added = await kernel.services.cart.addItem(
      { cartId: cart.value.id, entityId, quantity: 1 },
      testActor,
    );
    expect(added.ok).toBe(true);
    return cart.value.id as string;
  }

  async function readCartStatus(cartId: string): Promise<string | undefined> {
    const rows = await kernel.database.db
      .select({ status: carts.status })
      .from(carts)
      .where(eq(carts.id, cartId));
    return rows[0]?.status;
  }

  function checkout(cartId: string, idempotencyKey: string, paymentMethodId = "spy-payments") {
    return makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/checkout",
      body: { cartId, paymentMethodId, currency: "USD", idempotencyKey },
      actor: testActor,
    });
  }

  it("refuses to release a claim held by another checkout attempt", async () => {
    const cartId = await createCartWithItem();

    const winner = await kernel.services.cart.claimForCheckout(cartId, "attempt-A");
    expect(winner.ok).toBe(true);

    const stale = await kernel.services.cart.releaseCheckoutClaim(cartId, "attempt-B");
    expect(stale.ok && stale.value).toBeNull();
    expect(await readCartStatus(cartId)).toBe("checking_out");

    const own = await kernel.services.cart.releaseCheckoutClaim(cartId, "attempt-A");
    expect(own.ok && own.value?.status).toBe("active");
    expect(await readCartStatus(cartId)).toBe("active");
  });

  it("does not let a losing checkout reopen the cart the winner is still in", async () => {
    const cartId = await createCartWithItem();

    // Attempt A wins the claim and is still mid-flight (phase 2: payment
    // authorization, order insert, after-hooks). Its claim must survive
    // everything the other attempts do.
    expect((await kernel.services.cart.claimForCheckout(cartId, "attempt-A")).ok).toBe(true);

    // B loses the claim, fails, and runs its release in the catch block.
    const b = await checkout(cartId, `B-${Date.now()}`);
    expect(b.status).toBe(422);
    expect(await readCartStatus(cartId)).toBe("checking_out");

    // Before the fix this was a 201 — a second order and a second payment
    // intent against the same cart.
    const c = await checkout(cartId, `C-${Date.now()}`);
    expect(c.status).toBe(422);
    expect(await readCartStatus(cartId)).toBe("checking_out");

    // The winner finishes; the cart yields exactly one order and one intent.
    expect((await kernel.services.cart.releaseCheckoutClaim(cartId, "attempt-A")).ok).toBe(true);
    paymentIntents = 0;
    const d = await checkout(cartId, `D-${Date.now()}`);
    expect(d.status).toBe(201);
    expect(paymentIntents).toBe(1);

    const placed = await kernel.database.db
      .select({ metadata: orders.metadata })
      .from(orders);
    expect(
      placed.filter((row: any) => row.metadata?.cartId === cartId),
    ).toHaveLength(1);
  });

  it("still releases a shopper's own failed checkout so they can retry", async () => {
    const cartId = await createCartWithItem();

    // Payment authorization runs in phase 2, after the claim transaction has
    // committed — so this failure has a real claim of its own to release.
    const failed = await checkout(cartId, `fail-${Date.now()}`, "failing-payments");
    expect(failed.status).toBe(422);
    expect(await readCartStatus(cartId)).toBe("active");

    const retry = await checkout(cartId, `retry-${Date.now()}`);
    expect(retry.status).toBe(201);
  });
});
