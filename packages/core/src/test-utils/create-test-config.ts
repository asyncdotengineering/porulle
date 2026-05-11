import { defineConfig } from "../config/define-config.js";
import type { CommerceConfig } from "../config/types.js";
import { Ok } from "../kernel/result.js";
import type { StorageAdapter } from "../modules/media/adapter.js";

function createInMemoryStorageAdapter(): StorageAdapter {
  const files = new Map<string, { data: ArrayBuffer; contentType: string }>();
  const baseUrl = "http://localhost:3000/test-assets";

  return {
    providerId: "test-memory-storage",
    async upload(key, data, contentType) {
      const body =
        data instanceof ArrayBuffer
          ? data
          : await new Response(data).arrayBuffer();
      files.set(key, { data: body, contentType });
      return Ok({
        key,
        url: `${baseUrl}/${key}`,
        contentType,
        size: body.byteLength,
      });
    },
    async getUrl(key) {
      return Ok(`${baseUrl}/${key}`);
    },
    async getSignedUrl(key, expiresIn) {
      return Ok(`${baseUrl}/${key}?expiresIn=${expiresIn}`);
    },
    async delete(key) {
      files.delete(key);
      return Ok(undefined);
    },
    async list(prefix) {
      return Ok(
        Array.from(files.entries())
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, file]) => ({
            key,
            url: `${baseUrl}/${key}`,
            contentType: file.contentType,
            size: file.data.byteLength,
          })),
      );
    },
  };
}

export async function createTestConfig(
  overrides: Partial<CommerceConfig> = {},
): Promise<CommerceConfig> {
  // Auto-provision PGlite when no databaseAdapter is provided
  if (!overrides.databaseAdapter) {
    const { createPGliteTestAdapter } = await import("./create-pglite-adapter.js");
    const { adapter } = await createPGliteTestAdapter();
    overrides = { ...overrides, databaseAdapter: adapter };
  }

  return defineConfig({
    version: "0.0.1-test",
    storeName: "Test Store",
    database: {
      provider: "postgresql",
    },
    auth: {
      defaultOrganizationId: "org_default",
      requireEmailVerification: false,
      apiKeys: { enabled: true, defaultPermissions: ["catalog:read"] },
      posPin: { enabled: true },
      roles: {
        owner: { permissions: ["*:*"] },
        admin: { permissions: ["*:*"] },
        staff: {
          permissions: [
            "catalog:create",
            "catalog:update",
            "catalog:delete",
            "catalog:read",
            "inventory:adjust",
            "orders:create",
            "orders:read",
            "orders:update",
            "cart:create",
            "cart:update",
            "customers:update:self",
          ],
        },
        ai_agent: {
          permissions: [
            "catalog:read",
            "catalog:create",
            "inventory:read",
          "inventory:adjust",
          "orders:read",
          "cart:create",
          "cart:update",
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
        "customers:read:self",
        "customers:update:self",
      ],
    },
    entities: {
      product: {
        fields: [
          { name: "weight", type: "number" },
          { name: "brand", type: "text" },
        ],
        variants: { enabled: true, optionTypes: ["size", "color"] },
        fulfillment: "physical",
      },
      digitalDownload: {
        fields: [{ name: "fileAssetId", type: "text" }],
        variants: { enabled: false },
        fulfillment: "digital-download",
      },
      course: {
        fields: [{ name: "modules", type: "json" }],
        variants: { enabled: false },
        fulfillment: "digital-access",
      },
    },
    cart: {
      ttlMinutes: 5,
      hooks: {},
    },
    checkout: {
      hooks: {
        beforeCreate: [],
        afterCreate: [],
      },
    },
    orders: {
      hooks: {
        beforeCreate: [],
        afterCreate: [],
        beforeStatusChange: [],
        afterStatusChange: [],
      },
    },
    inventory: {
      hooks: {
        afterAdjust: [],
      },
    },
    email: {
      async send() {
        // no-op for tests
      },
    },
    storage: createInMemoryStorageAdapter(),
    ...overrides,
  });
}

/**
 * Creates a test config backed by PGlite (in-memory PostgreSQL).
 *
 * This provides production parity for tests by using real SQL execution
 * and PostgreSQL behavior while remaining fast and self-contained.
 *
 * @param overrides - Optional config overrides
 * @returns A promise resolving to an object containing:
 *   - config: The CommerceConfig to pass to createKernel
 *   - cleanup: Async function to reset data between tests
 */
export async function createPGliteTestConfig(
  overrides: Partial<CommerceConfig> = {},
): Promise<{ config: CommerceConfig; cleanup: () => Promise<void> }> {
  const { createPGliteTestAdapter } = await import("./create-pglite-adapter.js");
  const { adapter, cleanup } = await createPGliteTestAdapter();

  const config = await createTestConfig({
    databaseAdapter: adapter,
    ...overrides,
  });

  return { config, cleanup };
}
