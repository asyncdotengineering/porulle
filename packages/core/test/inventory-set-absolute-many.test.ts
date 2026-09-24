/**
 * `inventory.setAbsoluteMany` — one catalogue page of absolute levels, set-based.
 *
 * A store's inventory sync levelled 20 variants per Workflow step through `setAbsolute`, each a
 * permission check, a row lock, a clamped write, a movement row and an `inventory.afterAdjust` —
 * so a 27k-variant store took ~2.8 h and every changed variant re-marked its product. This keeps
 * setAbsolute's invariants (permission, default warehouse, org, no-op when unchanged, clamp at 0, a
 * movement per change) in a CONSTANT number of statements per call, and announces the page ONCE
 * through `inventory.afterAdjustMany`, grouped by product. Every change is still audited.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Actor } from "../src/auth/types.js";
import { DEFAULT_ORG_ID } from "../src/auth/org.js";
import { variants } from "../src/modules/catalog/schema.js";
import { inventoryLevels, inventoryMovements } from "../src/modules/inventory/schema.js";
import { auditLog } from "../src/modules/audit/schema.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig, createTestConfig } from "../src/test-utils/create-test-config.js";
import { defineCommercePlugin, type PluginHookRegistration } from "../src/kernel/plugin/manifest.js";
import type { QueryLog } from "../src/test-utils/create-pglite-adapter.js";

const syncer: Actor = {
  type: "user",
  userId: "inventory-sync",
  email: "sync@test.local",
  name: "Inventory Sync",
  vendorId: null,
  organizationId: DEFAULT_ORG_ID,
  role: "admin",
  permissions: ["*:*"],
};

describe("inventory.setAbsoluteMany", () => {
  let kernel: ReturnType<typeof createKernel>;
  let db: DrizzleDatabase;
  let queryLog: QueryLog;
  let cleanup: () => Promise<void>;
  const many: Array<{ entities: Array<{ entityId: string; levels: Array<{ variantId: string | null; quantityOnHand: number }> }> }> = [];
  let single = 0;

  beforeAll(async () => {
    const built = await createPGliteTestConfig();
    cleanup = built.cleanup;
    queryLog = built.queryLog;
    kernel = createKernel(built.config);
    db = kernel.database.db as DrizzleDatabase;
    kernel.hooks.append("inventory.afterAdjustMany", async (args: { result: (typeof many)[number] }) => { many.push(args.result); });
    kernel.hooks.append("inventory.afterAdjust", async () => { single += 1; });
  }, 60_000);
  afterAll(async () => { await cleanup(); });

  async function productWithVariants(slug: string, count: number): Promise<{ entityId: string; variantIds: string[] }> {
    const created = await kernel.services.catalog.create({ type: "product", slug, attributes: { locale: "en", title: slug } }, syncer);
    if (!created.ok) throw new Error(created.error.message);
    const rows = await db.insert(variants).values(Array.from({ length: count }, (_, index) => ({
      entityId: created.value.id, organizationId: DEFAULT_ORG_ID, sku: `${slug}-${index}`,
    }))).returning({ id: variants.id });
    return { entityId: created.value.id, variantIds: rows.map((row) => row.id) };
  }
  const levelsOf = async (entityId: string) => new Map(
    (await db.select({ variantId: inventoryLevels.variantId, qty: inventoryLevels.quantityOnHand }).from(inventoryLevels)
      .where(eq(inventoryLevels.entityId, entityId))).map((row) => [row.variantId, row.qty]),
  );

  it("levels every row, one movement per change, ONE afterAdjustMany for the product and no afterAdjust", async () => {
    const product = await productWithVariants("nine-variants", 9);
    // Three variants already hold stock; two of them unchanged, one changed.
    for (const variantId of product.variantIds.slice(0, 3)) {
      await kernel.services.inventory.setAbsolute({ entityId: product.entityId, variantId, quantity: 5 }, syncer);
    }
    const movementsBefore = (await db.select().from(inventoryMovements).where(eq(inventoryMovements.entityId, product.entityId))).length;
    const auditBefore = (await db.select().from(auditLog).where(eq(auditLog.entityType, "inventory"))).length;
    many.length = 0;
    single = 0;

    const rows = product.variantIds.map((variantId, index) => ({ entityId: product.entityId, variantId, quantity: index < 2 ? 5 : index === 8 ? -4 : index }));
    const result = await kernel.services.inventory.setAbsoluteMany(rows, syncer);

    expect(result.ok).toBe(true);
    const levels = await levelsOf(product.entityId);
    expect(product.variantIds.map((id) => levels.get(id))).toEqual([5, 5, 2, 3, 4, 5, 6, 7, 0]);
    // 7 changed: index 2 (5 → 2) and six new rows. Indices 0 and 1 were already 5.
    expect((await db.select().from(inventoryMovements).where(eq(inventoryMovements.entityId, product.entityId))).length - movementsBefore).toBe(7);
    expect(single).toBe(0);
    expect(many).toHaveLength(1);
    expect(many[0]?.entities.map((entity) => entity.entityId)).toEqual([product.entityId]);
    expect(many[0]?.entities[0]?.levels).toHaveLength(7);
    // Every change is still audited: one row per changed level.
    expect((await db.select().from(auditLog).where(eq(auditLog.entityType, "inventory"))).length - auditBefore).toBe(7);
  });

  it("storm guard: an unchanged page writes nothing and announces nothing", async () => {
    const product = await productWithVariants("unchanged-page", 4);
    const rows = product.variantIds.map((variantId) => ({ entityId: product.entityId, variantId, quantity: 3 }));
    await kernel.services.inventory.setAbsoluteMany(rows, syncer);
    many.length = 0;
    single = 0;

    queryLog.start();
    const result = await kernel.services.inventory.setAbsoluteMany(rows, syncer);
    const statements = queryLog.stop();

    expect(result.ok).toBe(true);
    expect(statements.filter((statement) => !/^\s*select/i.test(statement))).toEqual([]);
    expect(many).toEqual([]);
    expect(single).toBe(0);
  });

  it("budget: the statement count is the same for 10 rows and 250 rows", async () => {
    const small = await productWithVariants("budget-small", 10);
    const big = await productWithVariants("budget-big", 250);
    const count = async (product: { entityId: string; variantIds: string[] }) => {
      queryLog.start();
      await kernel.services.inventory.setAbsoluteMany(product.variantIds.map((variantId, index) => ({ entityId: product.entityId, variantId, quantity: index + 1 })), syncer);
      return queryLog.stop().length;
    };

    const smallStatements = await count(small);
    const bigStatements = await count(big);

    expect(bigStatements).toBe(smallStatements);
    expect(bigStatements).toBeLessThanOrEqual(8);
  });

  it("refuses an actor without inventory:adjust, writing nothing", async () => {
    const product = await productWithVariants("no-permission", 1);
    const reader: Actor = { ...syncer, userId: "reader", permissions: ["inventory:read"] };

    const [variantId] = product.variantIds;
    if (variantId === undefined) throw new Error("no variant");
    const result = await kernel.services.inventory.setAbsoluteMany([{ entityId: product.entityId, variantId, quantity: 9 }], reader);

    expect(result.ok).toBe(false);
    expect((await levelsOf(product.entityId)).size).toBe(0);
  });
});

describe("a subscriber to inventory.afterAdjust must also take inventory.afterAdjustMany", () => {
  const noop = (..._args: unknown[]): undefined => undefined;
  const plugin = (keys: string[]) => defineCommercePlugin({
    id: `pairing-probe-${keys.length}`,
    version: "1.0.0",
    hooks: (): PluginHookRegistration[] => keys.map((key) => ({ key, handler: noop })),
  });

  it("a plugin subscribing to afterAdjust alone is refused at boot, by name", async () => {
    await expect(createTestConfig({ plugins: [plugin(["inventory.afterAdjust"])] }).then(createKernel))
      .rejects.toThrow(/Plugin "pairing-probe-1" subscribes to "inventory.afterAdjust" but not to "inventory.afterAdjustMany"/);
  });

  it("a plugin subscribing to both boots", async () => {
    const config = await createTestConfig({ plugins: [plugin(["inventory.afterAdjust", "inventory.afterAdjustMany"])] });
    expect(() => createKernel(config)).not.toThrow();
  });

  it("config.inventory.hooks with afterAdjust alone is refused at boot", async () => {
    const config = await createTestConfig({ inventory: { hooks: { afterAdjust: [async () => undefined] } } });
    expect(() => createKernel(config)).toThrow(/config\.inventory\.hooks subscribes to "inventory.afterAdjust"/);
  });
});
