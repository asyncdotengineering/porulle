import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import postgres from "postgres";
import { postgresAdapter } from "../src/index.js";
import {
  Ok,
  buildSchema,
  createKernel,
  defineConfig,
  ensureDefaultOrg,
  requireUserId,
  type Actor,
  type StorageAdapter,
} from "@porulle/core";

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function createStorageAdapter(): StorageAdapter {
  return {
    providerId: "test-storage",
    async upload(key, data, contentType) {
      const body =
        data instanceof ArrayBuffer ? data : await new Response(data).arrayBuffer();
      return Ok({
        key,
        url: `http://localhost/media/${key}`,
        contentType,
        size: body.byteLength,
      });
    },
    async getUrl(key) {
      return Ok(`http://localhost/media/${key}`);
    },
    async getSignedUrl(key) {
      return Ok(`http://localhost/media/${key}?signed=true`);
    },
    async delete() {
      return Ok(undefined);
    },
    async list() {
      return Ok([]);
    },
  };
}

const testUrl = process.env.POSTGRES_TEST_URL;

// Without a server these rows are SKIPPED, never passed: a green run with no database proved nothing.
describe.skipIf(!testUrl)("postgres adapter (real Postgres via POSTGRES_TEST_URL)", () => {
  it("executes basic CRUD operations when POSTGRES_TEST_URL is configured", async () => {
    const url = testUrl ?? "";

    const adapter = postgresAdapter({ connectionString: url });

    await adapter.db.execute(sql`CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, name TEXT NOT NULL);`);
    await adapter.db.execute(sql`DELETE FROM items;`);
    await adapter.db.execute(sql`INSERT INTO items (id, name) VALUES ('1', 'alpha');`);

    const rows = await adapter.db.execute(sql`SELECT id, name FROM items;`);
    const totalRows = "length" in rows ? rows.length : (rows as { rows?: unknown[] }).rows?.length;
    expect(totalRows ?? 0).toBeGreaterThanOrEqual(1);

    await adapter.db.execute(sql`UPDATE items SET name = 'beta' WHERE id = '1';`);
    await adapter.db.execute(sql`DELETE FROM items WHERE id = '1';`);
  });

  it("runs admin/customer/inventory regression flow when POSTGRES_TEST_URL is configured", async () => {
    const serverUrl = testUrl ?? "";

    const database = `porulle_regression_${Math.random().toString(36).slice(2, 10)}`;
    const admin = postgres(serverUrl, { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${database}`);
    const scratchUrl = withDatabase(serverUrl, database);

    const adapter = postgresAdapter({ connectionString: scratchUrl });
  try {
    const config = await defineConfig({
        storeName: "Postgres Regression Store",
        database: { provider: "postgresql" },
        databaseAdapter: adapter,
        storage: createStorageAdapter(),
        auth: {
          defaultOrganizationId: "org_default",
          roles: {
            admin: { permissions: ["*:*"] },
            customer: {
              permissions: [
                "catalog:read",
                "cart:create",
                "cart:read",
                "cart:update",
                "orders:create",
                "orders:read:own",
              ],
            },
          },
          customerPermissions: [
            "catalog:read",
            "cart:create",
            "cart:read",
            "cart:update",
            "orders:create",
            "orders:read:own",
          ],
        },
        entities: {
          product: { fields: [], variants: { enabled: false }, fulfillment: "physical" },
          digitalDownload: { fields: [], variants: { enabled: false }, fulfillment: "digital-download" },
          course: { fields: [], variants: { enabled: false }, fulfillment: "digital-access" },
        },
      });
    const ddl = await generateMigration(generateDrizzleJson({}), generateDrizzleJson(buildSchema(config)));
    const raw = postgres(scratchUrl, { max: 1 });
    try {
      for (const statement of ddl) await raw.unsafe(statement);
    } finally {
      await raw.end({ timeout: 5 });
    }
    await ensureDefaultOrg(adapter.db, config.storeName);
    const kernel = createKernel(config);

    const admin: Actor = {
      type: "user",
      userId: "admin-1",
      email: "admin@example.com",
      name: "Admin",
      vendorId: null,
      organizationId: "org_default",
      role: "admin",
      permissions: ["*:*"],
    };

    const customer: Actor = {
      type: "user",
      userId: "customer-1",
      email: "customer@example.com",
      name: "Customer",
      vendorId: null,
      organizationId: "org_default",
      role: "customer",
      permissions: [
        "catalog:read",
        "cart:create",
        "cart:read",
        "cart:update",
        "orders:create",
        "orders:read:own",
      ],
    };

    const physical = await kernel.services.catalog.create(
      { type: "product", slug: `trail-pack-${Date.now()}`, attributes: { title: "Trail Pack" } },
      admin,
    );
    const digital = await kernel.services.catalog.create(
      { type: "digitalDownload", slug: `photo-pack-${Date.now()}`, attributes: { title: "Photo Pack" } },
      admin,
    );
    const course = await kernel.services.catalog.create(
      { type: "course", slug: `growth-course-${Date.now()}`, attributes: { title: "Growth Course" } },
      admin,
    );
    expect(physical.ok && digital.ok && course.ok).toBe(true);
    if (!physical.ok || !digital.ok || !course.ok) return;

    await kernel.services.catalog.publish(physical.value.id, admin);
    await kernel.services.catalog.publish(digital.value.id, admin);
    await kernel.services.catalog.publish(course.value.id, admin);

    await kernel.services.pricing.setBasePrice(
      { entityId: physical.value.id, currency: "USD", amount: 1000 },
      admin,
    );

    const category = await kernel.services.catalog.createCategory(
      { slug: `gear-${Date.now()}`, sortOrder: 1 },
      admin,
    );
    const brand = await kernel.services.catalog.createBrand(
      { slug: `acme-${Date.now()}`, displayName: "ACME" },
      admin,
    );
    expect(category.ok && brand.ok).toBe(true);
    if (!category.ok || !brand.ok) return;

    await kernel.services.catalog.addToCategory(physical.value.id, category.value.id, admin);
    await kernel.services.catalog.addToBrand(physical.value.id, brand.value.id, admin);

    const listed = await kernel.services.catalog.list({
      filter: { brand: brand.value.slug },
      pagination: { page: 1, limit: 20 },
    }, admin);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.items.length).toBeGreaterThanOrEqual(1);

    const warehouse = await kernel.services.inventory.createWarehouse({ name: "Main", code: `MAIN-${Date.now()}` });
    expect(warehouse.ok).toBe(true);
    if (!warehouse.ok) return;

    const adjusted = await kernel.services.inventory.adjust(
      {
        entityId: physical.value.id,
        warehouseId: warehouse.value.id,
        adjustment: 10,
        reason: "seed stock",
      },
      admin,
    );
    expect(adjusted.ok).toBe(true);

    const cart = await kernel.services.cart.create({ customerId: requireUserId(customer), currency: "USD" }, customer);
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    const lineItem = await kernel.services.cart.addItem(
      { cartId: cart.value.id, entityId: physical.value.id, quantity: 2 },
      customer,
    );
    expect(lineItem.ok).toBe(true);

    const reserve = await kernel.services.inventory.reserve(
      {
        entityId: physical.value.id,
        warehouseId: warehouse.value.id,
        quantity: 2,
        orderId: `preview-${Date.now()}`,
      },
      customer,
    );
    expect(reserve.ok).toBe(true);

    const order = await kernel.services.orders.create(
      {
        customerId: requireUserId(customer),
        currency: "USD",
        subtotal: 2000,
        taxTotal: 0,
        shippingTotal: 0,
        discountTotal: 0,
        grandTotal: 2000,
        lineItems: [
          {
            entityId: physical.value.id,
            entityType: "product",
            title: "Trail Pack",
            quantity: 2,
            unitPrice: 1000,
            totalPrice: 2000,
          },
        ],
      },
      customer,
    );
    expect(order.ok).toBe(true);
    if (!order.ok) return;

    const release = await kernel.services.inventory.release(
      {
        entityId: physical.value.id,
        warehouseId: warehouse.value.id,
        quantity: 2,
        orderId: order.value.id,
      },
      admin,
    );
    expect(release.ok).toBe(true);

    const settle = await kernel.services.inventory.adjust(
      {
        entityId: physical.value.id,
        warehouseId: warehouse.value.id,
        adjustment: -2,
        reason: "sale",
        referenceType: "order",
        referenceId: order.value.id,
      },
      admin,
    );
    expect(settle.ok).toBe(true);

    const available = await kernel.services.inventory.getAvailable(physical.value.id);
    expect(available.ok).toBe(true);
    if (!available.ok) return;
    expect(available.value).toBe(8);
  } finally {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  }
  }, 120_000);
});
