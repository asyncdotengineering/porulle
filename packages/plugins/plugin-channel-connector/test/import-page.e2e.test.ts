import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Actor, ChannelCatalogImage, ChannelCatalogItem, StorageAdapter } from "@porulle/core";
import { and, eq, inArray, isNull } from "@porulle/core/drizzle";
import {
  auditLog,
  brands,
  catalogFieldOwnership,
  categories,
  entityBrands,
  entityCategories,
  entityMedia,
  entityTags,
  mediaAssets,
  optionTypes,
  optionValues,
  prices,
  sellableEntities,
  sellableEntityRevisions,
  tags,
  variantOptionValues,
  variants,
} from "@porulle/core/schema";
// The package's own harness cannot see the statements core issues (`import-statement-budget.test.ts`
// counts only the service's handle). The PGlite adapter's query log sees every statement, and this
// suite's first job is to count them, so it builds the adapter itself.
import { createPGliteTestAdapter, createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import {
  channelConnectorPlugin,
  ChannelConnectorService,
  HERO_IMAGE_BYTE_CAP,
  mockChannelConnector,
  selectImportImages,
} from "../src/index.js";
import { channelEntityMap } from "../src/schema.js";

/**
 * END-TO-END: a page of products lands through the real kernel on the import fast path.
 *
 * Measured before this existed (2026-09-22, PGlite query log, gflock-shaped product with 12 variants):
 * **564 statements per product cold**, because every core write re-read the entity, recorded a
 * revision per mutation and wrote one row per statement. The fast path takes a page, reads the
 * page's state once, writes multi-row inside ONE transaction with a savepoint per item, records one
 * revision per item and one audit row per page, and fires no per-entity hook.
 *
 * ## The ways this suite could LIE, written before the code, and the row that closes each
 *
 *  F1  The page reports success while writing nothing.            -> row counts in every table.
 *  F2  The statement count regresses and nothing notices.          -> per-item budget asserted from
 *      the query log, and the number is written to the artifact so a regression is a diff.
 *  F3  One poisoned item takes the page down.                      -> a bad option reference fails
 *      that item only (caught before any write); the others commit.
 *  F3b A failure INSIDE the database leaves partial rows.          -> a duplicate SKU trips the
 *      store's partial unique index after the entity row is in; the savepoint rolls it back, no
 *      entity row survives, code `conflict`, the others commit.
 *  F4  A slug conflict takes the page down or silently adopts.     -> conflict with a merchant-made
 *      entity fails that item only.
 *  F5  Shared vocabulary is duplicated or a pre-existing one fails.-> one brand / category / tag row
 *      each, every item linked.
 *  F6  Already-mapped items are re-imported as new.                -> the same page again creates
 *      nothing and costs a fraction of the cold run.
 *  F7  Media: every photo is fetched, or the wrong ones.           -> hero only is fetched; deferred
 *      set is the first photo of each OTHER variant with its variant refs intact.
 *  F8  A hero over the byte cap is buffered or stored.             -> refused mid-stream, reported,
 *      no asset row, item still created.
 *  F9  The hero is stored but not linked where the index reads it. -> entity-level primary link plus
 *      variant-level links for the hero's variants.
 *  F10 The map rows are missing or mis-hashed.                     -> one entity row and one variant
 *      row per variant with non-empty hashes.
 *  F11 A caller without sync permission writes.                    -> refused, nothing written.
 *  F12 reject-everything still commits the good rows.              -> kernel call with one bad row
 *      writes nothing.
 *  F13 Per-entity hooks still fire (audit row per entity).         -> one audit row for the page,
 *      none per entity.
 *  F14 Results come back in some other order.                      -> entityIds follow input order.
 *  F15 fetchCatalogPage writes.                                    -> zero writes in the log.
 *
 * Artifact: `IMPORT_PAGE_E2E_OUT` (default `<tmpdir>/porulle-import-page-e2e.json`) — statement
 * counts by verb and table for the cold and warm runs, the per-item budget, the per-row results and
 * the media summary. Repeatable: the fixture is deterministic and the counts are exact.
 */
const OUT = process.env.IMPORT_PAGE_E2E_OUT ?? join(tmpdir(), "porulle-import-page-e2e.json");
const COLOURS = ["red", "blue", "black"] as const;
const SIZES = ["xs", "s", "m", "l"] as const;
const GOOD = 20;
const PER_ITEM_BUDGET = 16;
const WARM_PER_ITEM_BUDGET = 8;

function product(index: number, overrides: Partial<ChannelCatalogItem> = {}): ChannelCatalogItem {
  const slug = `dress-${index}`;
  return {
    externalId: `ext-${index}`,
    slug,
    title: `Long Midi Dress ${index}`,
    description: "A long midi dress in a soft crepe. Material : Polyester.",
    status: "active",
    brand: "gflock",
    categories: ["women-dresses"],
    tags: ["Women_Dresses", "Use_Party", "Use_Evening", "size-s", "New Arrival"],
    metadata: { product_type: "Women_Dresses", vendor: "GFLOCK" },
    options: [
      { name: "color", displayName: "Color", sortOrder: 0, values: COLOURS.map((value, sortOrder) => ({ value, displayValue: value, sortOrder })) },
      { name: "size", displayName: "Size", sortOrder: 1, values: SIZES.map((value, sortOrder) => ({ value, displayValue: value.toUpperCase(), sortOrder })) },
    ],
    variants: COLOURS.flatMap((colour) => SIZES.map((size) => ({
      externalId: `ext-${index}-${colour}-${size}`,
      sku: `LMD-${index}-${colour}-${size}`.toUpperCase(),
      optionValues: { color: colour, size },
      prices: [{ currency: "LKR", amount: 799000 }],
    }))),
    images: [
      { externalId: `img-${index}-hero`, url: `https://cdn.example.test/${slug}/hero-red.jpg`, role: "primary", sortOrder: 0, variantExternalIds: SIZES.map((size) => `ext-${index}-red-${size}`) },
      { externalId: `img-${index}-red-2`, url: `https://cdn.example.test/${slug}/red-2.jpg`, role: "gallery", sortOrder: 1, variantExternalIds: SIZES.map((size) => `ext-${index}-red-${size}`) },
      { externalId: `img-${index}-blue`, url: `https://cdn.example.test/${slug}/blue.jpg`, role: "gallery", sortOrder: 2, variantExternalIds: SIZES.map((size) => `ext-${index}-blue-${size}`) },
      { externalId: `img-${index}-blue-2`, url: `https://cdn.example.test/${slug}/blue-2.jpg`, role: "gallery", sortOrder: 3, variantExternalIds: SIZES.map((size) => `ext-${index}-blue-${size}`) },
      { externalId: `img-${index}-black`, url: `https://cdn.example.test/${slug}/black.jpg`, role: "gallery", sortOrder: 4, variantExternalIds: SIZES.map((size) => `ext-${index}-black-${size}`) },
    ],
    ...overrides,
  };
}

/** F3: a variant referencing an option value the item does not declare. */
const poisoned = product(98, {
  externalId: "ext-poison",
  slug: "dress-poison",
  variants: [{ externalId: "ext-poison-v", sku: "POISON-1", optionValues: { color: "chartreuse", size: "m" }, prices: [{ currency: "LKR", amount: 1 }] }],
});
/** F4: a slug already taken by a merchant-made entity (no source store), so neither path may adopt it. */
const conflicting = product(99, { externalId: "ext-conflict", slug: "merchant-made-dress" });
/** F3b: passes every in-memory check; its second variant's SKU belongs to dress-1, so the variants insert is what fails. */
const duplicateSku = product(97, {
  externalId: "ext-dupsku",
  slug: "dress-dupsku",
  variants: [
    { externalId: "ext-dupsku-a", sku: "DUPSKU-A", optionValues: { color: "red", size: "xs" }, prices: [{ currency: "LKR", amount: 1 }] },
    { externalId: "ext-dupsku-b", sku: "LMD-1-RED-XS", optionValues: { color: "red", size: "s" }, prices: [{ currency: "LKR", amount: 1 }] },
  ],
});
const BAD = ["ext-conflict", "ext-dupsku", "ext-poison"];
const page: ChannelCatalogItem[] = [...Array.from({ length: GOOD }, (_, index) => product(index + 1)), poisoned, conflicting, duplicateSku];

function classify(statement: string): string {
  const sql = statement.trim().toLowerCase();
  const verb = sql.startsWith("select") ? "select" : sql.startsWith("insert") ? "insert" : sql.startsWith("update") ? "update" : sql.startsWith("delete") ? "delete" : sql.startsWith("savepoint") ? "savepoint" : sql.startsWith("release") ? "release" : sql.startsWith("rollback") ? "rollback" : "other";
  const table = /(?:from|into|update|delete\s+from)\s+"?([a-z_]+)"?/.exec(sql)?.[1] ?? "-";
  return `${verb} ${table}`;
}
function summarise(statements: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const statement of statements) counts[classify(statement)] = (counts[classify(statement)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}
const isWrite = (statement: string) => /^\s*(insert|update|delete)/i.test(statement);

function streamOf(totalBytes: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= totalBytes) { controller.close(); return; }
      const chunk = new Uint8Array(Math.min(65_536, totalBytes - sent));
      chunk.fill(7);
      sent += chunk.length;
      controller.enqueue(chunk);
    },
  });
}

/** A real JPEG header so the media service's sniffing accepts the bytes as `image/jpeg`. */
function jpegBytes(size = 512): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
}

type Artifact = Record<string, unknown>;
const artifact: Artifact = { fixture: { products: GOOD, variantsPerProduct: COLOURS.length * SIZES.length, imagesPerProduct: 5, poisoned: 1, conflicting: 1, duplicateSku: 1 } };

describe("E2E: a page of products lands on the import fast path", () => {
  let built: Awaited<ReturnType<typeof createPluginTestApp>>;
  let service: ChannelConnectorService;
  let queryLog: Awaited<ReturnType<typeof createPGliteTestAdapter>>["queryLog"];
  let storeId: string;
  let merchantMadeEntityId: string;
  const fetched: string[] = [];
  let oversizeUrls = new Set<string>();
  const fetchSpy = vi.spyOn(globalThis, "fetch");

  beforeAll(async () => {
    const pglite = await createPGliteTestAdapter();
    queryLog = pglite.queryLog;
    const storage: StorageAdapter = {
      providerId: "e2e-storage",
      async upload(key: string, _data: ArrayBuffer | ReadableStream, contentType: string) {
        return { ok: true as const, value: { key, url: `https://storage.test/${key}`, contentType, size: 1 } };
      },
      async getUrl(key: string) { return { ok: true as const, value: `https://storage.test/${key}` }; },
      async delete() { return { ok: true as const, value: undefined }; },
    } as unknown as StorageAdapter;
    fetchSpy.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      fetched.push(url);
      if (oversizeUrls.has(url)) {
        return new Response(streamOf(2 * HERO_IMAGE_BYTE_CAP), { headers: { "content-type": "image/jpeg", "content-length": "1" } });
      }
      return new Response(jpegBytes(), { headers: { "content-type": "image/jpeg" } });
    });
    const mock = mockChannelConnector({ catalog: page });
    built = await createPluginTestApp(channelConnectorPlugin({ connectors: [mock] }), { storage, databaseAdapter: pglite.adapter });
    service = new ChannelConnectorService(built.db, built.kernel.services, { connectors: [mock] });
    const response = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain: "e2e.test", webhookSecret: "s" }),
    });
    expect(response.status).toBe(201);
    storeId = (await response.json()).data.id as string;

    // F4's obstacle: a product a person made in Merchant Center holding the slug the last item wants.
    const catalog = built.kernel.services.catalog as { create(input: unknown, actor: Actor): Promise<{ ok: boolean; value?: { id: string } }> };
    const made = await catalog.create({ type: "product", slug: "merchant-made-dress", status: "active", metadata: {} }, testAdminActor);
    expect(made.ok).toBe(true);
    merchantMadeEntityId = made.value!.id;
  }, 120_000);

  afterAll(() => {
    fetchSpy.mockRestore();
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(artifact, null, 2));
    console.log(`artifact ${OUT}`);
  });

  it("F15: fetchCatalogPage returns the page and writes nothing", async () => {
    queryLog.start();
    const fetchedPage = await service.fetchCatalogPage(TEST_ORG_ID, storeId, null);
    const statements = queryLog.stop();
    expect(fetchedPage.ok).toBe(true);
    if (!fetchedPage.ok) return;
    expect(fetchedPage.value.items).toHaveLength(page.length);
    expect(fetchedPage.value.nextCursor).toBeNull();
    expect(statements.filter(isWrite)).toEqual([]);
  });

  it("F1–F5, F7, F9, F10, F13, F14: a cold page creates every good item in bulk and reports the two bad ones", async () => {
    fetched.length = 0;
    queryLog.start();
    const outcome = await service.convergeCatalogPage(TEST_ORG_ID, storeId, page, testAdminActor);
    const statements = queryLog.stop();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const result = outcome.value;

    // F14 + F3/F4: exactly the good ones, in order; the two bad ones named by ref.
    expect(result.created).toBe(GOOD);
    expect(result.entityIds).toHaveLength(GOOD);
    expect(result.failures.map((failure) => failure.externalId).sort()).toEqual(BAD);
    expect(result.failures.find((failure) => failure.externalId === "ext-dupsku")?.error).toMatch(/^conflict: /);

    // F1: every table holds what the fixture implies.
    const entities = await built.db.select().from(sellableEntities).where(eq(sellableEntities.sourceStoreId, storeId));
    expect(entities).toHaveLength(GOOD);
    expect(entities.map((entity) => entity.slug).sort()).toEqual(Array.from({ length: GOOD }, (_, index) => `dress-${index + 1}`).sort());
    const ids = entities.map((entity) => entity.id);
    // input order: dress-1 first
    expect(result.entityIds[0]).toBe(entities.find((entity) => entity.slug === "dress-1")?.id);
    expect(await built.db.select().from(variants).where(inArray(variants.entityId, ids))).toHaveLength(GOOD * 12);
    expect(await built.db.select().from(prices).where(inArray(prices.entityId, ids))).toHaveLength(GOOD * 12);
    const typeRows = await built.db.select().from(optionTypes).where(inArray(optionTypes.entityId, ids));
    expect(typeRows).toHaveLength(GOOD * 2);
    expect(typeRows.every((row) => row.displayName === "Color" || row.displayName === "Size")).toBe(true);
    const valueRows = await built.db.select().from(optionValues).where(inArray(optionValues.optionTypeId, typeRows.map((row) => row.id)));
    expect(valueRows).toHaveLength(GOOD * 7);
    const variantRows = await built.db.select().from(variants).where(inArray(variants.entityId, ids));
    expect(await built.db.select().from(variantOptionValues).where(inArray(variantOptionValues.variantId, variantRows.map((row) => row.id)))).toHaveLength(GOOD * 12 * 2);
    expect(variantRows.every((row) => row.sourceStoreId === storeId && row.organizationId === TEST_ORG_ID)).toBe(true);

    // F5: one brand, one category, five tags — every item linked, nothing duplicated.
    const brandRows = await built.db.select().from(brands).where(eq(brands.slug, "gflock"));
    expect(brandRows).toHaveLength(1);
    expect(await built.db.select().from(entityBrands).where(inArray(entityBrands.entityId, ids))).toHaveLength(GOOD);
    const categoryRows = await built.db.select().from(categories).where(eq(categories.slug, "women-dresses"));
    expect(categoryRows).toHaveLength(1);
    expect(await built.db.select().from(entityCategories).where(inArray(entityCategories.entityId, ids))).toHaveLength(GOOD);
    const tagRows = await built.db.select().from(tags).where(eq(tags.organizationId, TEST_ORG_ID));
    expect(tagRows.filter((row) => ["Women_Dresses", "Use_Party", "Use_Evening", "size-s", "New Arrival"].includes(row.slug))).toHaveLength(5);
    expect(await built.db.select().from(entityTags).where(inArray(entityTags.entityId, ids))).toHaveLength(GOOD * 5);

    // Ownership seeded as the store's; one revision per entity, reason import, revision 1.
    const ownership = await built.db.select().from(catalogFieldOwnership).where(inArray(catalogFieldOwnership.entityId, ids));
    expect(ownership.length).toBeGreaterThanOrEqual(GOOD * 8);
    expect(ownership.every((row) => row.owner === "store" && row.storeId === storeId)).toBe(true);
    const revisions = await built.db.select().from(sellableEntityRevisions).where(inArray(sellableEntityRevisions.entityId, ids));
    expect(revisions).toHaveLength(GOOD);
    expect(revisions.every((row) => row.reason === "import" && row.revision === 1)).toBe(true);

    // F3 / F3b: no partial rows for the poisoned item or the one that failed mid-savepoint; F4: the merchant's entity untouched.
    expect(await built.db.select().from(sellableEntities).where(eq(sellableEntities.slug, "dress-poison"))).toHaveLength(0);
    expect(await built.db.select().from(sellableEntities).where(eq(sellableEntities.slug, "dress-dupsku"))).toHaveLength(0);
    expect(await built.db.select().from(variants).where(eq(variants.sku, "DUPSKU-A"))).toHaveLength(0);
    const merchantMade = await built.db.select().from(sellableEntities).where(eq(sellableEntities.id, merchantMadeEntityId));
    expect(merchantMade[0]?.sourceStoreId ?? null).toBeNull();
    expect(await built.db.select().from(variants).where(eq(variants.entityId, merchantMadeEntityId))).toHaveLength(0);

    // F10: map rows, one per entity and one per variant, hashed.
    const mapRows = await built.db.select().from(channelEntityMap).where(and(eq(channelEntityMap.storeId, storeId), inArray(channelEntityMap.entityId, ids)));
    expect(mapRows.filter((row) => row.kind === "entity")).toHaveLength(GOOD);
    expect(mapRows.filter((row) => row.kind === "variant")).toHaveLength(GOOD * 12);
    expect(mapRows.every((row) => row.syncHash.length === 64)).toBe(true);
    expect(mapRows.filter((row) => row.kind === "variant").every((row) => row.variantId !== null)).toBe(true);

    // F13: one audit row for the page, none per entity.
    const audit = await built.db.select().from(auditLog).where(eq(auditLog.organizationId, TEST_ORG_ID));
    const imported = audit.filter((row) => row.event === "imported");
    expect(imported).toHaveLength(1);
    expect(audit.filter((row) => row.entityType === "catalog_entity" && ids.includes(row.entityId))).toHaveLength(0);

    // F7: hero only fetched, once per good item (the poisoned and conflicting items never reach media).
    expect(fetched).toHaveLength(GOOD);
    expect(fetched.every((url) => url.endsWith("/hero-red.jpg"))).toBe(true);
    expect(result.heroesImported).toBe(GOOD);
    expect(result.mediaFailures).toEqual([]);
    expect(result.deferredMedia).toHaveLength(GOOD);
    for (const deferred of result.deferredMedia) {
      expect(deferred.images.map((image) => image.url.split("/").pop())).toEqual(["blue.jpg", "black.jpg"]);
      expect(deferred.images.every((image) => (image.variantExternalIds?.length ?? 0) === SIZES.length)).toBe(true);
    }
    // F9: hero stored once per product, linked at entity level as primary and to each of its variants.
    const assets = await built.db.select().from(mediaAssets).where(eq(mediaAssets.organizationId, TEST_ORG_ID));
    expect(assets.filter((asset) => String(asset.metadata?.channelImageExternalId ?? "").endsWith("-hero"))).toHaveLength(GOOD);
    const links = await built.db.select().from(entityMedia).where(inArray(entityMedia.entityId, ids));
    expect(links.filter((link) => link.variantId === null && link.role === "primary")).toHaveLength(GOOD);
    expect(links.filter((link) => link.variantId !== null)).toHaveLength(GOOD * SIZES.length);

    // F2: the budget, and the number itself into the artifact.
    const perItem = statements.length / GOOD;
    artifact.cold = { statements: statements.length, perItem: Number(perItem.toFixed(1)), budgetPerItem: PER_ITEM_BUDGET, byVerbTable: summarise(statements) };
    artifact.results = { created: result.created, failures: result.failures, entityIds: result.entityIds.length };
    artifact.media = { heroesFetched: fetched.length, heroesImported: result.heroesImported, deferredPerProduct: result.deferredMedia[0]?.images.length ?? 0 };
    expect(perItem).toBeLessThanOrEqual(PER_ITEM_BUDGET);
  }, 120_000);

  it("F8: a hero over the byte cap is refused mid-stream, reported, and the item still lands", async () => {
    const big = product(50, { externalId: "ext-big", slug: "dress-big" });
    oversizeUrls = new Set([big.images![0]!.url]);
    fetched.length = 0;
    const outcome = await service.convergeCatalogPage(TEST_ORG_ID, storeId, [big], testAdminActor);
    oversizeUrls = new Set();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.created).toBe(1);
    expect(outcome.value.mediaFailures).toEqual([expect.objectContaining({ externalId: "ext-big", reason: "too-large" })]);
    expect(outcome.value.heroesImported).toBe(0);
    const [entity] = await built.db.select().from(sellableEntities).where(eq(sellableEntities.slug, "dress-big"));
    expect(entity).toBeDefined();
    expect(await built.db.select().from(entityMedia).where(eq(entityMedia.entityId, entity!.id))).toHaveLength(0);
    const assets = await built.db.select().from(mediaAssets).where(eq(mediaAssets.organizationId, TEST_ORG_ID));
    expect(assets.some((asset) => asset.metadata?.channelImageExternalId === "img-50-hero")).toBe(false);
    artifact.oversizeHero = { refused: true, reason: outcome.value.mediaFailures[0]?.reason ?? null };
  }, 60_000);

  it("F6: the same page again creates nothing and costs a fraction of the cold run", async () => {
    fetched.length = 0;
    queryLog.start();
    const outcome = await service.convergeCatalogPage(TEST_ORG_ID, storeId, page, testAdminActor);
    const statements = queryLog.stop();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.created).toBe(0);
    expect(outcome.value.entityIds).toHaveLength(GOOD);
    expect(outcome.value.failures.map((failure) => failure.externalId).sort()).toEqual(BAD);
    expect(await built.db.select().from(sellableEntities).where(eq(sellableEntities.sourceStoreId, storeId))).toHaveLength(GOOD + 1);
    expect(fetched).toEqual([]);
    const perItem = statements.length / GOOD;
    artifact.warm = { statements: statements.length, perItem: Number(perItem.toFixed(1)), budgetPerItem: WARM_PER_ITEM_BUDGET, byVerbTable: summarise(statements) };
    expect(perItem).toBeLessThanOrEqual(WARM_PER_ITEM_BUDGET);
  }, 120_000);

  it("F11: an actor without catalog:sync is refused and nothing is written", async () => {
    const noSync: Actor = { ...testAdminActor, permissions: ["catalog:create", "catalog:update", "catalog:read", "channels:manage"] };
    const before = (await built.db.select().from(sellableEntities).where(eq(sellableEntities.organizationId, TEST_ORG_ID))).length;
    queryLog.start();
    const outcome = await service.convergeCatalogPage(TEST_ORG_ID, storeId, [product(60, { externalId: "ext-nosync", slug: "dress-nosync" })], noSync);
    const statements = queryLog.stop();
    expect(outcome.ok).toBe(false);
    expect(statements.filter(isWrite)).toEqual([]);
    expect((await built.db.select().from(sellableEntities).where(eq(sellableEntities.organizationId, TEST_ORG_ID))).length).toBe(before);
  });

  it("F12: reject-everything writes nothing when one row is bad (kernel-level call)", async () => {
    const catalog = built.kernel.services.catalog as {
      importProducts(page: unknown[], options: { sourceStoreId: string; errorPolicy: "reject-everything" }, actor: Actor): Promise<{ ok: boolean; value?: { created: number; failed: number } }>;
    };
    const before = (await built.db.select().from(sellableEntities).where(eq(sellableEntities.organizationId, TEST_ORG_ID))).length;
    const report = await catalog.importProducts([
      { ref: "good", slug: "dress-policy-good", attributes: [{ locale: "en", title: "Good" }], variants: [{ ref: "g1", sku: "POLICY-G1", options: {} }] },
      { ref: "bad", slug: "dress-policy-bad", attributes: [{ locale: "en", title: "Bad" }], options: [{ name: "size", values: [{ value: "m" }] }], variants: [{ ref: "b1", sku: "POLICY-B1", options: { size: "xxl" } }] },
    ], { sourceStoreId: storeId, errorPolicy: "reject-everything" }, testAdminActor);
    expect(report.ok).toBe(true);
    expect(report.value?.created).toBe(0);
    expect(report.value?.failed).toBe(2);
    expect((await built.db.select().from(sellableEntities).where(eq(sellableEntities.organizationId, TEST_ORG_ID))).length).toBe(before);
    expect(await built.db.select().from(sellableEntities).where(isNull(sellableEntities.sourceStoreId))).toHaveLength(1);
  });

  it("selectImportImages: hero plus the first photo of each other variant, nothing more", () => {
    const item = product(1);
    const { hero, perVariant } = selectImportImages(item);
    expect(hero?.externalId).toBe("img-1-hero");
    expect(perVariant.map((image) => image.externalId)).toEqual(["img-1-blue", "img-1-black"]);
    const single = product(2, { images: [{ url: "https://cdn.example.test/only.jpg", role: "gallery", variantExternalIds: ["ext-2-red-xs"] }, { url: "https://cdn.example.test/only-2.jpg", role: "gallery", variantExternalIds: ["ext-2-red-xs"] }] });
    expect(selectImportImages(single)).toEqual({ hero: single.images![0], perVariant: [] });
    const shared: ChannelCatalogImage[] = [
      { url: "https://cdn.example.test/a.jpg", role: "primary", variantExternalIds: ["v1"] },
      { url: "https://cdn.example.test/a.jpg", role: "gallery", variantExternalIds: ["v2"] },
      { url: "https://cdn.example.test/b.jpg", role: "gallery", variantExternalIds: ["v2", "v3"] },
    ];
    const dedup = selectImportImages(product(3, { images: shared, variants: [] }));
    expect(dedup.perVariant.map((image) => image.url.split("/").pop())).toEqual(["b.jpg"]);
    expect(selectImportImages(product(4, { images: [] }))).toEqual({ hero: null, perVariant: [] });
  });
});
