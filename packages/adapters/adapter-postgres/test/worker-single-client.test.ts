/**
 * The Worker's connection shape: every transaction in an invocation shares ONE client.
 *
 * On Cloudflare Workers the Neon adapter sends plain queries over HTTP and runs every
 * `transaction()` — through the adapter or through `db.transaction` — on a single postgres.js
 * client with `max: 1`, reused for the whole invocation (`withPooledTransactions`). A transaction
 * opened while another holds that client waits for a connection that never comes: the invocation
 * hangs, and Postgres never sees the statement. Local suites run on a real pool and cannot see it.
 *
 * This reproduces that shape against real Postgres — plain queries on an ordinary pool, every
 * transaction on one shared `max: 1` client — and drives the channel converge paths that open
 * transactions (the import page, entity creation, option-value rewrites, the SKU/barcode pre-pass).
 * Each call is time-limited, so a nested top-level transaction fails the row instead of hanging it.
 *
 * Runs when PORULLE_TEST_PG_URL points at a Postgres server; creates and drops a throwaway
 * database named porulle_lock_<random>.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { buildSchema, createSystemActor, ensureDefaultOrg, type ChannelCatalogItem, type DatabaseAdapter, type PluginDb } from "@porulle/core";
import { createTestKernel, TEST_ORG_ID } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "@porulle/plugin-channel-connector";
import { postgresAdapter } from "../src/index.js";

const serverUrl = process.env.PORULLE_TEST_PG_URL;
const SCRATCH = /^porulle_lock_[a-z0-9]+$/;
const CALL_LIMIT_MS = 5_000;

if (!serverUrl) console.warn("worker rows: SKIPPED — the single-client transaction rows did NOT run (set PORULLE_TEST_PG_URL). A green run that prints this line is not evidence.");

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** A structural check, not a cast: the kernel types its handle `unknown`. */
function isPluginDb(value: unknown): value is PluginDb {
  return typeof value === "object" && value !== null && "select" in value && "insert" in value && "transaction" in value;
}

/** Fail the row, rather than hang it, when a call waits on the one transaction client. */
async function within<T>(label: string, call: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} HUNG for ${CALL_LIMIT_MS} ms — a transaction waited on the invocation's one client`)), CALL_LIMIT_MS);
  });
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function product(externalId: string, sku: string, size: "s" | "m"): ChannelCatalogItem {
  return {
    externalId,
    slug: externalId,
    title: `Product ${externalId}`,
    attributes: [{ locale: "en", title: `Product ${externalId}` }],
    status: "active",
    tags: ["worker-shape"],
    categories: ["worker-shape"],
    options: [{
      name: "size",
      displayName: "Size",
      sortOrder: 0,
      values: [{ value: "s", displayValue: "S", sortOrder: 0 }, { value: "m", displayValue: "M", sortOrder: 1 }],
    }],
    variants: [{ externalId: `${externalId}-v1`, sku, optionValues: { size }, prices: [{ amount: 1000, currency: "LKR" }] }],
  };
}

describe.skipIf(!serverUrl)("channel converge under the Worker's one-client-per-invocation transactions (real Postgres)", () => {
  const database = `porulle_lock_${Math.random().toString(36).slice(2, 10)}`;
  let admin: ReturnType<typeof postgres>;
  let plain: ReturnType<typeof postgresAdapter>;
  let txClient: ReturnType<typeof postgres>;
  let service: ChannelConnectorService;
  let storeId: string;
  const remote = { catalog: [product("w-1", "W1", "s"), product("w-2", "W2", "s")] };
  const actor = () => createSystemActor(TEST_ORG_ID);

  beforeAll(async () => {
    if (!serverUrl) throw new Error("unreachable: describe is skipped without PORULLE_TEST_PG_URL");
    if (!SCRATCH.test(database)) throw new Error(`refusing to create a database named ${database}`);
    admin = postgres(serverUrl, { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${database}`);
    const url = withDatabase(serverUrl, database);
    plain = postgresAdapter({ connectionString: url, pool: { max: 5 } });
    // Every transaction on ONE client, as the Worker's pooled scope does. Plain queries keep the
    // ordinary pool, as they keep Neon HTTP on the Worker.
    txClient = postgres(url, { max: 1, prepare: false });
    const txDb = drizzle(txClient);
    const transaction = <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => txDb.transaction(async (tx) => fn(tx));
    const db = new Proxy(plain.db, { get: (target, prop, receiver) => (prop === "transaction" ? transaction : Reflect.get(target, prop, receiver)) });
    const adapter: DatabaseAdapter = { provider: "postgresql", db, transaction };

    const connector = mockChannelConnector(remote);
    const kernel = await createTestKernel({ databaseAdapter: adapter, plugins: [channelConnectorPlugin({ connectors: [connector] })] });
    const raw = postgres(url, { max: 1 });
    try {
      for (const statement of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(buildSchema(kernel.config)))) await raw.unsafe(statement);
      await ensureDefaultOrg(plain.db);
      const [store] = await raw<{ id: string }[]>`insert into connected_stores (organization_id, provider, credentials, store_domain) values (${TEST_ORG_ID}, 'mock', '{}'::jsonb, 'worker-shape.test') returning id`;
      if (!store) throw new Error("no store row");
      storeId = store.id;
    } finally {
      await raw.end({ timeout: 5 });
    }
    const serviceDb: unknown = kernel.database.db;
    if (!isPluginDb(serviceDb)) throw new Error("kernel database handle is not a drizzle db");
    service = new ChannelConnectorService(serviceDb, kernel.services, { connectors: [connector] });
    console.log(`worker rows: RAN against ${database}`);
  }, 120_000);

  afterAll(async () => {
    if (!SCRATCH.test(database)) throw new Error(`refusing to drop a database named ${database}`);
    try {
      await txClient?.end({ timeout: 5 });
      await plain?.db.$client.end({ timeout: 5 });
    } finally {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.end({ timeout: 5 });
    }
  }, 60_000);

  it("control: the harness does catch a transaction opened inside another on the one client", async () => {
    // The shape this suite exists to forbid, on its OWN one-connection client so the deliberately
    // stuck transaction cannot starve the row below. If this stops hanging, the harness no longer
    // models the Worker and that row proves nothing.
    if (!serverUrl) throw new Error("unreachable: describe is skipped without PORULLE_TEST_PG_URL");
    const lone = postgres(withDatabase(serverUrl, database), { max: 1, prepare: false });
    const loneDb = drizzle(lone);
    try {
      const nested = loneDb.transaction(async () => loneDb.transaction(async () => "inner"));
      nested.catch(() => {});
      await expect(within("nested top-level transaction", nested)).rejects.toThrow(/HUNG/);
    } finally {
      await lone.end({ timeout: 1 });
    }
  }, 60_000);

  it("imports a page on the fast path, then converges option-value and SKU drift, without a nested transaction hanging", async () => {
    const page = await within("convergeCatalogPage (fast path)", service.convergeCatalogPage(TEST_ORG_ID, storeId, remote.catalog, actor()));
    expect(page.ok && { created: page.value.created, failures: page.value.failures }).toEqual({ created: 2, failures: [] });

    // Option-value rewrite on an existing variant + an upstream SKU swap between the two products.
    remote.catalog = [product("w-1", "W2", "m"), product("w-2", "W1", "s")];
    const changed = await within("convergeCatalogPage (editor path)", service.convergeCatalogPage(TEST_ORG_ID, storeId, remote.catalog, actor()));
    expect(changed.ok && changed.value.failures).toEqual([]);

    const reconciled = await within("reconcile", service.reconcile(TEST_ORG_ID, storeId, actor()));
    expect(reconciled.ok && reconciled.value.failures).toBeUndefined();
  }, 90_000);
});

it.skipIf(Boolean(serverUrl))("SKIPPED — the single-client transaction rows did NOT run: set PORULLE_TEST_PG_URL", () => {});
