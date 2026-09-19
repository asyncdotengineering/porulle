import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/types.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";
import { createTestKernel } from "../src/test-utils/create-test-kernel.js";
import { FulfillmentRepository } from "../src/modules/fulfillment/repository/index.js";

/**
 * `FulfillmentService.updateTracking` looked a fulfilment up with `repository.findById(id, ctx)`
 * — no organization — and then wrote carrier, trackingNumber, status, shippedAt and deliveredAt
 * through `repository.update(id, data, ctx)`, whose only predicate is the fulfilment id. Neither
 * the read nor the write was confined to a tenant, and the method took no actor to confine it by.
 *
 * The asymmetry is what made it survive review: `createFulfillment`, on the same service and the
 * same row, asserts a permission, resolves an organization and looks the ORDER up scoped. You
 * could not create a fulfilment outside your organization; you could update any fulfilment's
 * tracking from anywhere.
 *
 * A fulfilment does not own tenant identity — `fulfillment_records` has no organization column.
 * Its non-null `orderId` is the only authoritative edge to `orders.organizationId`, so the
 * predicate has to bind the supplied id to the caller's organization through that foreign key,
 * in the query, for the read AND for the write. Read protection is not write protection.
 */

const ORG_A = "org_fulfiltrack_a";
const ORG_B = "org_fulfiltrack_b";

const admin = (org: string): Actor => ({
  type: "user",
  userId: `admin_${org}`,
  email: `admin@${org}.test`,
  name: "admin",
  vendorId: null,
  organizationId: org,
  role: "admin",
  permissions: ["*:*"],
});

type Refusal = { code: string; message: string };

describe("a fulfilment tracking update is confined to its organization", () => {
  let kernel: Awaited<ReturnType<typeof createTestKernel>>;
  let repo: FulfillmentRepository;
  let fulfilmentB: string;

  beforeAll(async () => {
    kernel = await createTestKernel();
    repo = new FulfillmentRepository(kernel.database.db as DrizzleDatabase);

    await kernel.services.organization.create({ id: ORG_A, name: "A", slug: "fulfiltrack-a" });
    await kernel.services.organization.create({ id: ORG_B, name: "B", slug: "fulfiltrack-b" });

    const entity = await kernel.services.catalog.create(
      { type: "product", slug: `fulfiltrack-b-${Date.now()}` },
      admin(ORG_B),
    );
    if (!entity.ok) throw new Error(`entity seed failed: ${JSON.stringify(entity)}`);

    const order = await kernel.services.orders.create(
      {
        currency: "USD",
        subtotal: 4000,
        taxTotal: 0,
        shippingTotal: 0,
        grandTotal: 4000,
        lineItems: [
          {
            entityId: entity.value.id,
            entityType: "product",
            title: "Sari",
            quantity: 1,
            unitPrice: 4000,
            totalPrice: 4000,
          },
        ],
      },
      admin(ORG_B),
    );
    if (!order.ok) throw new Error(`order seed failed: ${JSON.stringify(order)}`);

    const firstLine = order.value.lineItems[0];
    if (!firstLine) throw new Error("order seed produced no line items");

    const created = await kernel.services.fulfillment.createFulfillment(
      { orderId: order.value.id, lineItems: [{ orderLineItemId: firstLine.id, quantity: 1 }] },
      admin(ORG_B),
    );
    if (!created.ok) throw new Error(`fulfilment seed failed: ${JSON.stringify(created)}`);
    fulfilmentB = created.value.id;
  });

  async function refuse(actor: Actor, fulfillmentId: string): Promise<Refusal> {
    const res = await kernel.services.fulfillment.updateTracking(
      { fulfillmentId, carrier: "INTRUDER", trackingNumber: "X-1", status: "shipped" },
      actor,
    );
    if (res.ok) throw new Error("expected a refusal, got a successful update");
    return { code: res.error.code, message: res.error.message };
  }

  /**
   * The control the whole file rests on. Without a caller who CAN update, every assertion below
   * holds trivially against a guard that refuses everybody — which is the failure a sibling card
   * shipped on this very method today, and it looks exactly like the security working.
   */
  it("the owning organization CAN update its own fulfilment", async () => {
    const res = await kernel.services.fulfillment.updateTracking(
      { fulfillmentId: fulfilmentB, carrier: "DHL", trackingNumber: "B-OWNER-1", status: "shipped" },
      admin(ORG_B),
    );
    expect(res.ok).toBe(true);

    const row = await repo.findById(ORG_B, fulfilmentB);
    expect(row?.carrier).toBe("DHL");
    expect(row?.trackingNumber).toBe("B-OWNER-1");
  });

  it("another organization CANNOT, and the row is unchanged when it tries", async () => {
    const before = await repo.findById(ORG_B, fulfilmentB);
    expect(before).toBeDefined();

    await refuse(admin(ORG_A), fulfilmentB);

    // Read the row back. A refusal that still wrote is exactly what a status-only assertion
    // cannot see, and it is the shape this card exists to close.
    const after = await repo.findById(ORG_B, fulfilmentB);
    expect(after?.carrier).toBe(before?.carrier);
    expect(after?.trackingNumber).toBe(before?.trackingNumber);
    expect(after?.status).toBe(before?.status);
    expect(after?.shippedAt?.getTime()).toBe(before?.shippedAt?.getTime());
    expect(after?.updatedAt?.getTime()).toBe(before?.updatedAt?.getTime());
  });

  it("refuses a real cross-tenant id exactly as it refuses a fabricated one", async () => {
    const real = await refuse(admin(ORG_A), fulfilmentB);
    const fake = await refuse(admin(ORG_A), crypto.randomUUID());

    expect(real).toEqual(fake);
    expect(real.message).not.toContain(fulfilmentB);
  });

  /**
   * The anti-"refuses everybody" row, and the reason it is separate from the control above: the
   * method has no actor of its own in the failing design, so a fix that resolves ONLY an explicit
   * actor would refuse every actorless caller while passing every row that supplies one.
   */
  it("resolves the organization from ctx.actor when no explicit actor is passed", async () => {
    const res = await kernel.services.fulfillment.updateTracking(
      { fulfillmentId: fulfilmentB, carrier: "CTX", trackingNumber: "B-CTX-1" },
      null,
      { tx: kernel.database.db, actor: admin(ORG_B), requestId: "fulfiltrack-ctx" },
    );
    expect(res.ok).toBe(true);

    const row = await repo.findById(ORG_B, fulfilmentB);
    expect(row?.trackingNumber).toBe("B-CTX-1");
  });

  /**
   * The WRITE itself must carry the tenant predicate. Asserting only through the service cannot
   * tell "the scoped read stopped it" from "the scoped write stopped it" — both leave the row
   * unchanged — so the repository update is exercised directly.
   */
  it("the repository update is organization-constrained, not merely preceded by a scoped read", async () => {
    const before = await repo.findById(ORG_B, fulfilmentB);
    expect(before).toBeDefined();

    const written = await repo.update(ORG_A, fulfilmentB, { carrier: "DIRECT-INTRUDER" });
    expect(written).toBeUndefined();

    const after = await repo.findById(ORG_B, fulfilmentB);
    expect(after?.carrier).toBe(before?.carrier);
  });

  it("findById does not return another organization's fulfilment", async () => {
    expect(await repo.findById(ORG_A, fulfilmentB)).toBeUndefined();
    expect(await repo.findById(ORG_B, fulfilmentB)).toBeDefined();
  });
});
