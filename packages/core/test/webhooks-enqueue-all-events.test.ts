import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ExecutionEngine } from "../src/kernel/jobs/adapter.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestAdapter } from "../src/test-utils/create-pglite-adapter.js";
import { createTestConfig } from "../src/test-utils/create-test-config.js";
import { testAdminActor as admin } from "../src/test-utils/test-actors.js";

/**
 * `deliverWebhooks` is registered on 15 hook channels and enqueues through
 * `context.jobs`. Every one of them must reach the kernel's execution engine —
 * a hook context built without the engine silently drops the delivery.
 */
describe("webhook delivery reaches the jobs engine for every hooked module", () => {
  let cleanup: () => Promise<void>;
  let kernel: ReturnType<typeof createKernel>;
  const deliveries: string[] = [];

  beforeAll(async () => {
    const harness = await createPGliteTestAdapter();
    cleanup = harness.cleanup;
    const jobs: ExecutionEngine = {
      execution: { mode: "push" },
      register() {},
      async enqueue(slug, input) {
        if (slug === "webhooks/deliver") deliveries.push(String(input.eventName));
        return randomUUID();
      },
    };
    kernel = createKernel(await createTestConfig({ databaseAdapter: harness.adapter, jobs: { adapter: jobs } }));
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    deliveries.length = 0;
    await cleanup();
  });

  async function subscribe(event: string): Promise<void> {
    const endpoint = await kernel.services.webhooks.createEndpoint(
      { url: "https://example.com/webhook", secret: "test-secret", events: [event] },
      admin,
    );
    expect(endpoint.ok).toBe(true);
  }

  it("customers.create", async () => {
    await subscribe("customers.create");
    const created = await kernel.services.customers.createWalkIn({ firstName: "Walk", lastName: "In" }, admin);
    expect(created.ok).toBe(true);
    expect(deliveries).toEqual(["customers.create"]);
  });

  it("promotions.create", async () => {
    await subscribe("promotions.create");
    const created = await kernel.services.promotions.create(
      { code: `WH${Date.now()}`, name: "Webhook promo", type: "percentage_off_order", value: 10 },
      admin,
    );
    expect(created.ok).toBe(true);
    expect(deliveries).toEqual(["promotions.create"]);
  });

  it("inventory.update", async () => {
    const entity = await kernel.services.catalog.create(
      { type: "product", slug: `wh-inv-${Date.now()}`, attributes: { locale: "en", title: "Stocked" } },
      admin,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;
    await subscribe("inventory.update");
    const adjusted = await kernel.services.inventory.adjust(
      { entityId: entity.value.id, adjustment: 5, reason: "restock" },
      admin,
    );
    expect(adjusted.ok).toBe(true);
    expect(deliveries).toEqual(["inventory.update"]);
  });
});
