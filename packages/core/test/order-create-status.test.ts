import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kernel } from "../src/runtime/kernel.js";
import { createTestServer, testActor } from "../src/test-utils/rest-api-test-utils.js";
// Item 5 of the release needs no runtime assertion: this type-only import fails `check-types`
// when the export is missing, and `check-types` is already a gate. It is here rather than in a
// comment so the failure has a location.
import type { CreatePaymentIntentParams } from "../src/index.js";

/**
 * An order must be creatable in a status other than the state machine's initial one.
 *
 * `repo.create` was handed `status: "pending"` as a LITERAL (`modules/orders/service.ts`), and
 * neither `CreateOrderInput` nor `CreateOrderOptions` carried a status, so every order in the
 * framework was born `pending` whatever the caller intended. `customTransitions` adds states and
 * edges; it cannot change `initial`.
 *
 * That blocks a marketplace, and the obvious workaround — create, then immediately transition —
 * is worse than it looks. `pending` is the NORMAL state of an ordinary order, so an order stopped
 * between the two calls is indistinguishable from a legitimate one: nothing can reap it, and
 * nothing can alarm on it.
 *
 * The seam must be additive. T6 is what holds it to that.
 */

const PENDING_PAYMENT = "pending_payment";

function orderBody(entityId: string) {
  return {
    currency: "USD",
    subtotal: 5000,
    taxTotal: 0,
    shippingTotal: 0,
    discountTotal: 0,
    grandTotal: 5000,
    lineItems: [
      {
        entityId,
        entityType: "product",
        title: "Order status line",
        quantity: 1,
        unitPrice: 5000,
        totalPrice: 5000,
      },
    ],
  };
}

describe("an order can be created in a declared non-initial status", () => {
  let kernel: Kernel;
  let cleanup: () => Promise<void>;
  let entityId: string;

  beforeAll(async () => {
    // `pending_payment` exists only because this config declares it. A test that asserted a
    // status the machine does not know would be testing the absence of validation, not the seam.
    const server = await createTestServer({
      orders: {
        customTransitions: {
          pending_payment: ["confirmed", "cancelled"],
          pending: ["pending_payment"],
        },
      },
    });
    kernel = server.kernel;
    cleanup = server.cleanup;

    const entity = await kernel.services.catalog.create(
      {
        type: "product",
        slug: `order-status-${crypto.randomUUID()}`,
        status: "active",
        attributes: { title: "Order status product" },
        metadata: {},
      },
      testActor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) throw entity.error;
    entityId = entity.value.id;

    const priced = await kernel.services.pricing.setBasePrice({
      entityId,
      currency: "USD",
      amount: 5000,
    });
    expect(priced.ok).toBe(true);
  });

  afterAll(async () => {
    await cleanup();
  });

  it("T4 creates the order in the requested status", async () => {
    const created = await kernel.services.orders.create(
      { ...orderBody(entityId), status: PENDING_PAYMENT },
      testActor,
      undefined,
      { trustedPricing: true },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw created.error;
    expect(created.value.status).toBe(PENDING_PAYMENT);

    // Read it back rather than trusting the returned object: the defect being fixed lives in what
    // is written to the row, and a create that returned the requested status while persisting
    // "pending" would satisfy the line above and nothing else.
    const reread = await kernel.services.orders.getById(created.value.id, testActor);
    expect(reread.ok).toBe(true);
    if (!reread.ok) throw reread.error;
    expect(reread.value.status).toBe(PENDING_PAYMENT);
  });

  it("T5 refuses a status the configured machine does not declare", async () => {
    const created = await kernel.services.orders.create(
      { ...orderBody(entityId), status: "not_a_declared_state" },
      testActor,
      undefined,
      { trustedPricing: true },
    );
    // Refused, NOT quietly downgraded to the initial state. A silent fallback would recreate the
    // exact indistinguishable-order problem this seam exists to remove, while looking like it
    // worked.
    expect(created.ok).toBe(false);
  });

  it("T6 still creates in the machine's initial status when none is given", async () => {
    const created = await kernel.services.orders.create(
      orderBody(entityId),
      testActor,
      undefined,
      { trustedPricing: true },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw created.error;
    // This row is what makes the seam ADDITIVE. If it ever goes red, the release carries a second
    // breaking change nobody asked for.
    expect(created.value.status).toBe("pending");
  });

  it("T8 refuses a declared state that is not one an order may START in", async () => {
    // T5 only pins that an UNDECLARED string is refused. `fulfilled` is perfectly well declared —
    // it is in the machine's `states` — so a seam validated against `states` accepts it, and an
    // order is created past its entire lifecycle: no transition recorded, no beforeStatusChange
    // hook fired, no status history, nothing to audit. The seam exists to let an order start
    // BEFORE the normal beginning; this row is what stops it starting after the end.
    const created = await kernel.services.orders.create(
      { ...orderBody(entityId), status: "fulfilled" },
      testActor,
      undefined,
      { trustedPricing: true },
    );
    expect(created.ok).toBe(false);
    if (created.ok) throw new Error("an order was created directly in a terminal-ish state");

    // The refusal must say WHICH mistake was made. "No such state" and "that state is not one an
    // order may start in" send a caller to different places, and a message that conflates them
    // sends them to the wrong one.
    const message = String((created.error as { message?: string }).message ?? "");
    expect(message.toLowerCase()).not.toContain("unknown");
    expect(message).toMatch(/start|initial|creat/i);
  });

  it("T9 still accepts every state the machine declares an order MAY start in", async () => {
    // The mirror of T8, and the row that stops T8 being satisfied by refusing everything: both
    // core-declared initial states must work. Without this, `status === "pending"` hardcoded
    // would pass T4, T5, T6 and T8 together.
    for (const startable of ["pending", PENDING_PAYMENT]) {
      const created = await kernel.services.orders.create(
        { ...orderBody(entityId), status: startable },
        testActor,
        undefined,
        { trustedPricing: true },
      );
      expect(created.ok, `expected ${startable} to be a legal initial state`).toBe(true);
      if (!created.ok) throw created.error;
      expect(created.value.status).toBe(startable);
    }
  });

  it("T7 exports CreatePaymentIntentParams so an adapter author can name its own argument", () => {
    // THIS ROW IS GREEN UNDER VITEST WHETHER OR NOT THE EXPORT EXISTS, and that is not a defect to
    // fix by deleting it. `import type` is erased before the test runs, so vitest can say nothing
    // about item 5. Its real gate is `npm run check-types`, which fails with
    //   error TS2305: Module '"../src/index.js"' has no exported member 'CreatePaymentIntentParams'
    // and that error is the proof. The annotation below is what produces it, so removing the type
    // to "make the test meaningful" would remove the only thing that checks anything.
    const declared: CreatePaymentIntentParams = {
      amount: 1000,
      currency: "USD",
      orderId: "order-status-export-check",
    };
    expect(declared.amount).toBe(1000);
  });
});
