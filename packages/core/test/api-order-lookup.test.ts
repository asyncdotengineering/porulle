/**
 * GET /api/orders/lookup (#4)
 *
 * Receipt-less fuzzy order lookup by order number, customer name, email, or
 * phone (digits-normalized). <3 chars returns a hint.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestServer,
  makeRequest,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";
import { orders } from "../src/modules/orders/schema.js";
import type { Actor } from "../src/auth/types.js";

const admin: Actor = {
  type: "user",
  userId: "00000000-0000-0000-0000-0000000000ad",
  email: null,
  name: "Admin",
  vendorId: null,
  organizationId: "org_default",
  role: "owner",
  permissions: ["*:*"],
};

type LookupItem = { id: string; orderNumber: string; customer: { name: string | null; phone: string | null } | null };

describe("GET /api/orders/lookup (#4)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let kernel: any;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const r = await createTestServer();
    server = r.server;
    kernel = r.kernel;
    cleanup = r.cleanup;

    const cust = await kernel.services.customers.updateByUserId(
      "u-lookup",
      { firstName: "Nimali", lastName: "Perera", phone: "+94 77 412 6601", email: "nimali@example.com" },
      admin,
    );
    await kernel.database.db.insert(orders).values({
      organizationId: "org_default",
      customerId: cust.value.id,
      orderNumber: "ORD-2026-A2AC88",
      status: "confirmed",
      currency: "USD",
      subtotal: 18400,
      taxTotal: 0,
      shippingTotal: 0,
      grandTotal: 18400,
    });
  });
  afterEach(async () => { await cleanup(); });

  async function lookup(q: string) {
    const res = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/orders/lookup?q=${encodeURIComponent(q)}`,
      actor: admin,
    });
    return parseJsonResponse<{ data: { items: LookupItem[]; hint?: string } }>(res);
  }

  it("matches by customer last name", async () => {
    const json = await lookup("Perera");
    expect(json.data.items).toHaveLength(1);
    expect(json.data.items[0]!.orderNumber).toBe("ORD-2026-A2AC88");
    expect(json.data.items[0]!.customer?.name).toBe("Nimali Perera");
  });

  it("matches by phone, ignoring whitespace and dashes", async () => {
    const json = await lookup("412 6601");
    expect(json.data.items).toHaveLength(1);
    expect(json.data.items[0]!.customer?.phone).toBe("+94 77 412 6601");
  });

  it("matches by partial order number", async () => {
    const json = await lookup("A2AC88");
    expect(json.data.items).toHaveLength(1);
  });

  it("returns a hint for queries shorter than 3 characters", async () => {
    const json = await lookup("ab");
    expect(json.data.items).toHaveLength(0);
    expect(json.data.hint).toBeTruthy();
  });
});
