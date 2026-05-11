import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";
import { testAdminActor } from "../src/test-utils/test-actors.js";

const N = 20;

function makeLineItem(entityId: string) {
  return {
    entityId,
    entityType: "product",
    title: "Concurrency Product",
    quantity: 1,
    unitPrice: 100,
    totalPrice: 100,
  };
}

function parseOrderSeq(orderNumber: string): number {
  const parts = orderNumber.split("-");
  const tail = parts[parts.length - 1];
  if (tail == null || !/^\d{6}$/.test(tail)) {
    throw new Error(`unexpected order number shape: ${orderNumber}`);
  }
  return Number.parseInt(tail, 10);
}

describe("order numbers — concurrent create (PGlite)", () => {
  let kernel: ReturnType<typeof createKernel>;
  let cleanup: () => Promise<void>;
  let entityId: string;

  beforeAll(async () => {
    const { config, cleanup: c } = await createPGliteTestConfig();
    cleanup = c;
    kernel = createKernel(config);

    const entity = await kernel.services.catalog.create(
      {
        type: "product",
        slug: `order-seq-concurrency-${Date.now()}`,
        attributes: { title: "Order Seq Test" },
        metadata: {},
      },
      testAdminActor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) throw new Error("setup: catalog create failed");
    entityId = entity.value.id;
  });

  afterAll(async () => {
    await cleanup();
  });

  it(`creates ${N} orders in parallel — unique, consecutive global sequence suffixes`, async () => {
    const creates = Array.from({ length: N }, () =>
      kernel.services.orders.create(
        {
          currency: "USD",
          subtotal: 100,
          taxTotal: 0,
          shippingTotal: 0,
          discountTotal: 0,
          grandTotal: 100,
          metadata: {},
          lineItems: [makeLineItem(entityId)],
        },
        testAdminActor,
      ),
    );

    const results = await Promise.all(creates);
    const orderNumbers: string[] = [];
    const year = String(new Date().getFullYear());

    for (const r of results) {
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const on = r.value.orderNumber;
      expect(on).toMatch(new RegExp(`^ORD-${year}-\\d{6}$`));
      orderNumbers.push(on);
    }

    expect(orderNumbers).toHaveLength(N);

    const nums = orderNumbers.map(parseOrderSeq);
    expect(new Set(nums).size).toBe(N);

    const sorted = [...nums].sort((a, b) => a - b);
    const min = sorted[0]!;
    for (let i = 0; i < sorted.length; i++) {
      expect(sorted[i]).toBe(min + i);
    }
  });
});
