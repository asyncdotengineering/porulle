/**
 * The mock connector answered every pushed order with `mock-order-${orders.size + 1}`, counted in an
 * in-memory Map. Every Worker isolate starts that Map empty, so on a deployed host two DIFFERENT paid
 * orders both came back as `mock-order-1` (found on prod, 2026-09-25), and anything keyed on
 * (store, remote_order_id) conflated them. The id is now derived from the order itself.
 */
import { describe, expect, it } from "vitest";
import type { ChannelOrderSlice, ChannelStore } from "@porulle/core";
import { mockChannelConnector } from "../src/index.js";

const store = { id: "store-1", organizationId: "org-1", provider: "mock", credentials: {}, storeDomain: "mock.test", status: "connected", webhookSecret: "secret" } satisfies ChannelStore;
const slice = (orderId: string): ChannelOrderSlice => ({
  orderId,
  currency: "LKR",
  grandTotal: 1000,
  lines: [{ externalVariantId: "v-1", title: "Linen shirt", quantity: 1, unitPrice: 1000, totalPrice: 1000 }],
  customer: { name: "Shopper", email: "shopper@test.local", shippingAddress: { address1: "1 Road", city: "Colombo" } },
});

async function remoteIdOf(orderId: string): Promise<string> {
  // A FRESH connector per push: the deployed case, where each isolate starts with an empty Map.
  const pushed = await mockChannelConnector({ catalog: [] }).pushOrder(store, slice(orderId));
  if (!pushed.ok) throw new Error(`mock pushOrder refused order ${orderId}`);
  return pushed.value.remoteOrderId;
}

describe("the mock connector's remote order id", () => {
  it("differs for two different orders, even from two fresh connector instances", async () => {
    expect(await remoteIdOf("order-a")).not.toBe(await remoteIdOf("order-b"));
  });

  it("is the same for a re-push of the same order, so a retry does not mint a second remote order", async () => {
    expect(await remoteIdOf("order-a")).toBe(await remoteIdOf("order-a"));
  });

  it("keeps the mock-order- prefix the existing export row reads", async () => {
    expect(await remoteIdOf("order-a")).toMatch(/^mock-order-/);
  });
});
