import { consoleEmailAdapter, defineConfig } from "@porulle/core";
import { postgresAdapter } from "@porulle/adapter-postgres";
import { localStorageAdapter } from "@porulle/adapter-local-storage";

const DATABASE_URL = process.env.DATABASE_URL!;

export default defineConfig({
  storeName: "Starter Store",
  version: "1.0.0",

  database: {
    provider: "postgresql",
  },
  databaseAdapter: postgresAdapter({ connectionString: DATABASE_URL }),

  storage: localStorageAdapter({
    basePath: "./.data/media",
    baseUrl: "http://localhost:4000/assets",
  }),

  email: consoleEmailAdapter(),

  auth: {
    requireEmailVerification: false,
    apiKeys: { enabled: true },
    trustedOrigins: ["http://localhost:4000"],
    roles: {
      owner: { permissions: ["*:*"] },
      admin: { permissions: ["*:*"] },
      manager: {
        permissions: [
          "catalog:create",
          "catalog:update",
          "catalog:delete",
          "catalog:read",
          "inventory:read",
          "inventory:adjust",
          "orders:read",
          "orders:update",
          "cart:create",
          "cart:update",
          "customers:read:self",
          "customers:update:self",
        ],
      },
      customer: {
        permissions: [
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
  },

  entities: {
    product: {
      fields: [{ name: "weight", type: "number", unit: "grams" }],
      variants: { enabled: true, optionTypes: ["size", "color"] },
      fulfillment: "physical",
    },
  },
});
