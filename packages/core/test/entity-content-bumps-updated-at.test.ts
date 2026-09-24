/**
 * An edit to an entity's content must move the entity's `updated_at`.
 *
 * Consumers version a product from `sellable_entities.updated_at` (a search projection keeps the
 * old copy until that moves). `setAttributes` — title, subtitle, description, SEO — wrote
 * `sellable_attributes` and fired `catalog.afterUpdate` with the entity row UNCHANGED, so a changed
 * title never re-indexed: found on the sim, 2026-09-24. Approving a custom field
 * (`notifyEntityUpdated`) had the same shape.
 *
 * The control is as important: re-setting identical values writes nothing and moves nothing, or
 * every idempotent save looks like an edit and re-projects the catalogue.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { DEFAULT_ORG_ID } from "../src/auth/org.js";
import type { Actor } from "../src/auth/types.js";
import { sellableEntities } from "../src/modules/catalog/schema.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestAdapter } from "../src/test-utils/create-pglite-adapter.js";
import { createTestConfig } from "../src/test-utils/create-test-config.js";
import { createTxContext } from "../src/kernel/database/tx-context.js";
import type { DatabaseAdapter } from "../src/kernel/database/adapter.js";

const editor: Actor = {
  type: "user",
  userId: "content-editor",
  email: "editor@test.local",
  name: "Content Editor",
  vendorId: null,
  organizationId: DEFAULT_ORG_ID,
  role: "admin",
  permissions: ["*:*"],
};

const pause = () => new Promise((resolve) => setTimeout(resolve, 15));

describe("entity content edits move the entity's updated_at", () => {
  let kernel: ReturnType<typeof createKernel>;
  let db: DrizzleDatabase;
  let adapter: DatabaseAdapter;
  let cleanup: () => Promise<void>;
  const seen: Array<{ id: string; updatedAt: unknown; changedFieldPaths: unknown }> = [];

  beforeAll(async () => {
    const pglite = await createPGliteTestAdapter();
    db = pglite.db;
    adapter = pglite.adapter;
    cleanup = pglite.cleanup;
    kernel = createKernel(await createTestConfig({
      databaseAdapter: pglite.adapter,
      entities: { product: { fields: [{ name: "warranty", type: "text" }], variants: { enabled: false }, fulfillment: "physical" } },
    }));
    kernel.hooks.append("catalog.afterUpdate", async (args: { result: { id: string; updatedAt: unknown }; context: { context: Record<string, unknown> } }) => {
      seen.push({ id: args.result.id, updatedAt: args.result.updatedAt, changedFieldPaths: args.context.context.changedFieldPaths });
    });
  }, 60_000);

  afterAll(async () => { await cleanup(); });

  async function product(slug: string): Promise<string> {
    const created = await kernel.services.catalog.create({ type: "product", slug, attributes: { locale: "en", title: "Pleated pant", description: "Wool." } }, editor);
    if (!created.ok) throw new Error(created.error.message);
    return created.value.id;
  }
  const updatedAt = async (id: string) =>
    (await db.select({ at: sellableEntities.updatedAt }).from(sellableEntities).where(eq(sellableEntities.id, id)))[0]?.at.getTime();

  it("a changed title moves updated_at, and catalog.afterUpdate receives the new updated_at", async () => {
    const id = await product("title-edit");
    const before = await updatedAt(id);
    await pause();
    const firedBefore = seen.length;

    const result = await kernel.services.catalog.setAttributes(id, "en", { title: "Pleated wide pant" }, editor);

    expect(result.ok).toBe(true);
    const after = await updatedAt(id);
    expect(after).toBeGreaterThan(before ?? Infinity);
    const fired = seen.slice(firedBefore);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.changedFieldPaths).toEqual(["attributes.en.title"]);
    expect(fired[0]?.updatedAt instanceof Date ? fired[0].updatedAt.getTime() : undefined).toBe(after);
  });

  it("a changed description or SEO field moves updated_at too", async () => {
    const id = await product("description-edit");
    const before = await updatedAt(id);
    await pause();

    await kernel.services.catalog.setAttributes(id, "en", { title: "Pleated pant", description: "Wool, lined.", seoTitle: "Pleated pant" }, editor);

    expect(await updatedAt(id)).toBeGreaterThan(before ?? Infinity);
  });

  it("control: re-setting identical values moves nothing and fires nothing", async () => {
    const id = await product("identical-reset");
    const before = await updatedAt(id);
    await pause();
    const firedBefore = seen.length;

    const result = await kernel.services.catalog.setAttributes(id, "en", { title: "Pleated pant", description: "Wool." }, editor);

    expect(result.ok).toBe(true);
    expect(await updatedAt(id)).toBe(before);
    expect(seen.slice(firedBefore)).toEqual([]);
  });

  it("inside a caller's transaction, the bump is part of that transaction", async () => {
    const id = await product("transactional-edit");
    const before = await updatedAt(id);
    await pause();

    const insideTx = await adapter.transaction(async (tx) => {
      const txCtx = createTxContext(tx, { actor: editor });
      const result = await kernel.services.catalog.setAttributes(id, "en", { title: "Pleated pant, in a transaction" }, editor, txCtx);
      expect(result.ok).toBe(true);
      // Read back through the SAME transaction: the bump is visible inside it, before it commits.
      const row = await kernel.services.catalog.repository.findEntityById(id, txCtx);
      return row?.updatedAt.getTime();
    });

    expect(insideTx).toBeGreaterThan(before ?? Infinity);
    expect(await updatedAt(id)).toBe(insideTx);
  });

  it("approving a custom field moves updated_at, and catalog.afterUpdate receives the new updated_at", async () => {
    const id = await product("custom-field-approval");
    await kernel.services.catalog.repository.createCustomField({
      entityId: id, fieldName: "warranty", fieldType: "text", textValue: "2y", source: "enrichment",
      status: "proposed", confidence: "0.9", evidence: { model: "test" }, locale: "en",
    });
    const before = await updatedAt(id);
    await pause();
    const firedBefore = seen.length;

    const approved = await kernel.services.catalog.approveCustomField(id, "warranty", "en", editor);

    expect(approved.ok).toBe(true);
    const after = await updatedAt(id);
    expect(after).toBeGreaterThan(before ?? Infinity);
    const fired = seen.slice(firedBefore);
    expect(fired.map((event) => event.changedFieldPaths)).toEqual([["customFields.en.warranty"]]);
    expect(fired[0]?.updatedAt instanceof Date ? fired[0].updatedAt.getTime() : undefined).toBe(after);
  });
});
