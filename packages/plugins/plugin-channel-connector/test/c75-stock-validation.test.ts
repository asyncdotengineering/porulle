import { beforeAll, describe, expect, it } from "vitest";
import { CommerceValidationError, type Actor } from "@porulle/core";
import { createPluginTestApp, TEST_ORG_ID } from "@porulle/core/testing";
import { sellableEntities } from "@porulle/core/schema";
import { channelConnectorPlugin, mockChannelConnector } from "../src/index.js";
import { channelEntityMap, connectedStores } from "../src/schema.js";

const actor: Actor = {
  type: "user",
  userId: "c75-test-admin",
  email: "c75@test.local",
  name: "c75 Test Admin",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "admin",
  permissions: ["*"],
};

describe("c75 checkout.beforePayment stock validation", () => {
  const mockOptions: {
    inventory: Array<{ externalId: string; available: number }>;
    throwOnInventory?: boolean;
    inventoryError?: Error;
    inventoryDelayMs?: number;
    onFetchInventory?: (ids: string[]) => void;
  } = { inventory: [] };
  const mock = mockChannelConnector(mockOptions);
  let built: Awaited<ReturnType<typeof createPluginTestApp>>;

  beforeAll(async () => {
    built = await createPluginTestApp(channelConnectorPlugin({
      connectors: [mock],
      inventoryTimeoutMs: 100,
    }));
  }, 30_000);

  async function addChannelLine(input: {
    title: string;
    externalId: string;
    available: number;
    variant?: boolean;
  }) {
    const storeId = crypto.randomUUID();
    const entityId = crypto.randomUUID();
    const variantId = input.variant ? crypto.randomUUID() : undefined;
    await built.db.insert(connectedStores).values({
      id: storeId,
      organizationId: TEST_ORG_ID,
      provider: "mock",
      credentials: {},
      storeDomain: `${storeId}.mock.test`,
    });
    await built.db.insert(sellableEntities).values({
      id: entityId,
      organizationId: TEST_ORG_ID,
      sourceStoreId: storeId,
      type: "product",
      slug: `${input.title.toLowerCase().replaceAll(" ", "-")}-${entityId}`,
    });
    await built.db.insert(channelEntityMap).values({
      organizationId: TEST_ORG_ID,
      storeId,
      kind: input.variant ? "variant" : "entity",
      externalId: input.externalId,
      entityId,
      ...(variantId ? { variantId } : {}),
      syncHash: "c75",
    });
    mockOptions.inventory.push({ externalId: input.externalId, available: input.available });
    return {
      entityId,
      ...(variantId ? { variantId } : {}),
      storeId,
      line: {
        entityId,
        ...(variantId ? { variantId } : {}),
        title: input.title,
        quantity: 1,
      },
    };
  }

  async function validate(lines: Array<{ entityId: string; variantId?: string; title: string; quantity: number }>) {
    const hook = built.kernel.hooks.resolve("checkout.beforePayment")[0] as (args: unknown) => Promise<unknown>;
    return hook({
      data: { lineItems: lines },
      context: { actor, db: built.db, services: built.kernel.services },
    });
  }

  it("blocks a sold-out channel line and names the line", async () => {
    const item = await addChannelLine({ title: "Sold Out Lamp", externalId: "sold-out", available: 0 });
    await expect(validate([{ ...item.line, quantity: 1 }])).rejects.toThrow("Sold Out Lamp");
  });

  it("fails closed when inventory throws or returns an error", async () => {
    const item = await addChannelLine({ title: "Unavailable Lamp", externalId: "unavailable", available: 1 });
    mockOptions.throwOnInventory = true;
    await expect(validate([item.line])).rejects.toThrow("Unavailable Lamp");
    delete mockOptions.throwOnInventory;
    mockOptions.inventoryError = new CommerceValidationError("remote failure");
    await expect(validate([item.line])).rejects.toThrow("Unavailable Lamp");
    delete mockOptions.inventoryError;
    mockOptions.inventoryDelayMs = 150;
    await expect(validate([item.line])).rejects.toThrow("Unavailable Lamp");
    delete mockOptions.inventoryDelayMs;
  });

  it("validates distinct stores in parallel with one inventory call per store", async () => {
    const first = await addChannelLine({ title: "First Store Item", externalId: "parallel-one", available: 1 });
    const second = await addChannelLine({ title: "Second Store Item", externalId: "parallel-two", available: 1 });
    let active = 0;
    let maximum = 0;
    const calls: string[][] = [];
    mockOptions.inventoryDelayMs = 30;
    mockOptions.onFetchInventory = (ids) => {
      calls.push(ids);
      active += 1;
      maximum = Math.max(maximum, active);
      setTimeout(() => { active -= 1; }, 30);
    };
    await validate([first.line, second.line]);
    expect(calls).toEqual(expect.arrayContaining([["parallel-one"], ["parallel-two"]]));
    expect(calls).toHaveLength(2);
    expect(maximum).toBe(2);
    delete mockOptions.inventoryDelayMs;
    delete mockOptions.onFetchInventory;
  });

  it("does not call a connector for native-only lines", async () => {
    const entityId = crypto.randomUUID();
    await built.db.insert(sellableEntities).values({
      id: entityId,
      organizationId: TEST_ORG_ID,
      type: "product",
      slug: `native-${entityId}`,
    });
    let calls = 0;
    mockOptions.onFetchInventory = () => { calls += 1; };
    await validate([{ entityId, title: "Native Item", quantity: 1 }]);
    expect(calls).toBe(0);
    delete mockOptions.onFetchInventory;
  });

  it("allows an in-stock channel line", async () => {
    const item = await addChannelLine({ title: "Available Lamp", externalId: "available", available: 2, variant: true });
    await expect(validate([{ ...item.line, quantity: 1 }])).resolves.toBeDefined();
  });

  it("registers only the plugin hook and leaves core checkout unmodified", () => {
    expect(built.kernel.hooks.resolve("checkout.beforePayment")).toHaveLength(1);
    expect(built.kernel.hooks.resolve("checkout.beforePayment")[0]).toBeTypeOf("function");
    expect(built.kernel.hooks.resolve("checkout.beforeCreate")).toHaveLength(0);
  });

});
