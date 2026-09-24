/**
 * One store's import page must not hold the organization's shared vocabulary hostage.
 *
 * `catalog.importProducts` opens one transaction per page and, inside it, INSERTs any tag,
 * category or brand the page names that does not exist yet. A new row's unique key stays
 * uncommitted until the page commits, so a second store's page naming the same tag waits on that
 * unique index for the first page's whole transaction — about 100 s per page on the sim's after6
 * run (2026-09-24, four stores onboarding at once).
 *
 * This needs REAL Postgres: two connections to one database. PGlite is one connection, and the
 * "two-connection" test adapter is two PGlite instances that share no data, so neither can show
 * one transaction waiting on another's uncommitted key.
 *
 * Runs when PORULLE_TEST_PG_URL points at a Postgres server (a maintenance database such as
 * `postgres`). It creates a throwaway database named porulle_lock_<random>, and drops it again.
 * The schema is applied from generated DDL: drizzle-kit's `pushSchema` introspects through the
 * driver and exits the process against a postgres-js instance, and a fresh database needs no
 * introspection.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { buildSchema, createSystemActor, createTxContext, ensureDefaultOrg, type ImportProduct } from "@porulle/core";
import { createTestKernel, TEST_ORG_ID } from "@porulle/core/testing";
import { postgresAdapter } from "../src/index.js";

const serverUrl = process.env.PORULLE_TEST_PG_URL;
const SCRATCH = /^porulle_lock_[a-z0-9]+$/;
const B_MUST_FINISH_WITHIN_MS = 5_000;

if (!serverUrl) console.warn("lock rows: SKIPPED — the real-Postgres import lock rows did NOT run (set PORULLE_TEST_PG_URL). A green run that prints this line is not evidence of the lock fix.");

function scratchName(): string {
  const name = `porulle_lock_${Math.random().toString(36).slice(2, 10)}`;
  if (!SCRATCH.test(name)) throw new Error(`refusing to create a database named ${name}`);
  return name;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function product(prefix: string, tag: string): ImportProduct {
  return {
    ref: `${prefix}-1`,
    slug: `${prefix}-1`,
    status: "active",
    attributes: [{ locale: "en", title: `Product ${prefix}` }],
    variants: [{ ref: `${prefix}-1-v1`, sku: `${prefix.toUpperCase()}-1`, prices: [{ currency: "LKR", amount: 1000 }] }],
    tags: [tag],
  };
}

const page = (prefix: string, tag: string): ImportProduct[] => [product(prefix, tag)];

describe.skipIf(!serverUrl)("an import page and another store's page sharing a new tag (real Postgres)", () => {
  const database = scratchName();
  let admin: ReturnType<typeof postgres>;
  /** Plain SQL on the scratch database, for DDL and read-backs (core and this package resolve
   *  different drizzle-orm copies, so core's table objects do not type against this adapter). */
  let raw: ReturnType<typeof postgres>;
  const tagIds = async (slug: string): Promise<string[]> =>
    (await raw<{ id: string }[]>`select id from tags where organization_id = ${TEST_ORG_ID} and slug = ${slug}`).map((row) => row.id);
  const entityIds = async (slugs: string[]): Promise<string[]> =>
    (await raw<{ id: string }[]>`select id from sellable_entities where slug in ${raw(slugs)} order by id`).map((row) => row.id);
  const taggedEntityIds = async (tagId: string): Promise<string[]> =>
    (await raw<{ entity_id: string }[]>`select entity_id from entity_tags where tag_id = ${tagId} order by entity_id`).map((row) => row.entity_id);
  let kernel: Awaited<ReturnType<typeof createTestKernel>>;
  let adapter: ReturnType<typeof postgresAdapter>;
  const actor = () => createSystemActor(TEST_ORG_ID);

  beforeAll(async () => {
    if (!serverUrl) throw new Error("unreachable: describe is skipped without PORULLE_TEST_PG_URL");
    admin = postgres(serverUrl, { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${database}`);
    adapter = postgresAdapter({ connectionString: withDatabase(serverUrl, database), pool: { max: 5 } });
    kernel = await createTestKernel({ databaseAdapter: adapter });
    const ddl = await generateMigration(generateDrizzleJson({}), generateDrizzleJson(buildSchema(kernel.config)));
    raw = postgres(withDatabase(serverUrl, database), { max: 2 });
    for (const statement of ddl) await raw.unsafe(statement);
    await ensureDefaultOrg(adapter.db);
    console.log(`lock row: RAN against ${database}`);
  }, 120_000);

  afterAll(async () => {
    try {
      await raw?.end({ timeout: 5 });
      await adapter?.db.$client.end({ timeout: 5 });
    } finally {
      if (!SCRATCH.test(database)) throw new Error(`refusing to drop a database named ${database}`);
      await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.end({ timeout: 5 });
    }
  }, 60_000);

  // Another store's page (four stores onboarding at once), and the SAME store's next page (the sim's
  // single-store leg: an insert into tags waited 36.6 s behind the store's own 89 s page).
  it.each([
    ["another store's page", "store-b"],
    ["the same store's next page", "store-a"],
  ])("lets %s complete while page A's transaction is still open", async (_label, storeB) => {
    const tag = `new-season-${storeB}`;
    let releaseA: () => void = () => {};
    const aHeld = new Promise<void>((resolve) => { releaseA = resolve; });
    let aImported: () => void = () => {};
    const aReady = new Promise<void>((resolve) => { aImported = resolve; });

    // A's page runs inside a transaction this test holds open after the page has written.
    const a = adapter.transaction(async (tx) => {
      const imported = await kernel.services.catalog.importProducts(
        page(`a${storeB.slice(-1)}`, tag), { sourceStoreId: "store-a" }, actor(), createTxContext(tx, { actor: actor() }),
      );
      expect(imported.ok && imported.value.created).toBe(1);
      aImported();
      await aHeld;
    });
    await aReady;

    const started = Date.now();
    const b = kernel.services.catalog.importProducts(page(`b${storeB.slice(-1)}`, tag), { sourceStoreId: storeB }, actor());
    const outcome = await Promise.race([
      b.then((result) => ({ finished: true as const, result })),
      new Promise<{ finished: false }>((resolve) => setTimeout(() => resolve({ finished: false }), B_MUST_FINISH_WITHIN_MS)),
    ]);
    const elapsedMs = Date.now() - started;
    console.log(`lock row (${_label}): page B ${outcome.finished ? "completed" : "was STILL BLOCKED"} after ${elapsedMs} ms while A's transaction was open`);

    releaseA();
    await a;
    const bResult = await b;

    expect(outcome.finished, `B waited ${elapsedMs} ms on A's open page transaction`).toBe(true);
    expect(bResult.ok && bResult.value.created).toBe(1);
    const [tagId, ...extraTags] = await tagIds(tag);
    expect(extraTags).toEqual([]);
    expect(tagId).toBeDefined();
    expect(await taggedEntityIds(tagId ?? "")).toEqual(await entityIds([`a${storeB.slice(-1)}-1`, `b${storeB.slice(-1)}-1`]));
  }, 60_000);

  it("control: a lone page with a new tag still creates and links it", async () => {
    const result = await kernel.services.catalog.importProducts(page("solo", "only-here"), { sourceStoreId: "store-solo" }, actor());

    expect(result.ok && result.value.created).toBe(1);
    const [tagId] = await tagIds("only-here");
    expect(await taggedEntityIds(tagId ?? "")).toEqual(await entityIds(["solo-1"]));
  }, 60_000);

  it("control: reject-everything rolls back every ITEM, and the newly created tag remains (shared vocabulary)", async () => {
    // The page is rejected from INSIDE its transaction: its second item's sku is already this
    // store's, so its savepoint raises a unique violation. An in-memory failure would reject the
    // page before any transaction opened and prove nothing about rollback.
    const seeded = await kernel.services.catalog.importProducts(page("rejseed", "seed-only"), { sourceStoreId: "store-rej" }, actor());
    expect(seeded.ok && seeded.value.created).toBe(1);
    const clash: ImportProduct = { ...product("rej2", "left-behind"), variants: [{ ref: "rej2-1-v1", sku: "REJSEED-1" }] };

    const result = await kernel.services.catalog.importProducts(
      [...page("rej", "left-behind"), clash], { sourceStoreId: "store-rej", errorPolicy: "reject-everything" }, actor(),
    );

    expect(result.ok && result.value.created).toBe(0);
    expect(await entityIds(["rej-1", "rej2-1"])).toEqual([]);
    // Documented behaviour, not a leak: vocabulary is organization-wide and reusable, and creating
    // it outside the page transaction is exactly what stops another store's page from waiting.
    expect(await tagIds("left-behind")).toHaveLength(1);
  }, 60_000);
});

it.skipIf(Boolean(serverUrl))("SKIPPED — the real-Postgres lock rows did NOT run: set PORULLE_TEST_PG_URL", () => {});
