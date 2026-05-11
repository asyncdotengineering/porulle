import { defineConfig, Ok, type PaymentAdapter } from "@porulle/core";
import { postgresAdapter } from "@porulle/adapter-postgres";
import { localStorageAdapter } from "@porulle/adapter-local-storage";
import { loyaltyPlugin } from "@porulle/plugin-loyalty";
import { wishlistPlugin } from "@porulle/plugin-wishlist";
import { reviewsPlugin } from "@porulle/plugin-reviews";
import { extendedSellableEntities } from "./src/plugins/extended-catalog-schema.js";
import { supplierInfoRoutes } from "./src/routes/supplier-info.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://localhost:5432/unified_commerce";

// Public URL of the deployed instance. Used for trusted origins (Better Auth
// CSRF/cookie checks) and as the prefix served back to clients for uploaded
// media. Defaults to localhost for local dev. In production this MUST be set
// to the canonical https origin (e.g. https://store.example.com).
const PUBLIC_URL = process.env.PUBLIC_URL ?? "http://localhost:4000";

const mockPayments: PaymentAdapter = {
  providerId: "mock-payments",
  async createPaymentIntent(params: { amount: number; currency: string }) {
    return Ok({
      id: `pi_${Date.now()}`,
      status: "requires_capture",
      amount: params.amount,
      currency: params.currency,
      clientSecret: `secret_${Date.now()}`,
    });
  },
  async capturePayment(paymentIntentId: string, amount?: number) {
    return Ok({
      id: paymentIntentId,
      status: "succeeded",
      amountCaptured: amount ?? 0,
    });
  },
  async refundPayment(_paymentId: string, amount: number) {
    return Ok({
      id: `re_${Date.now()}`,
      status: "succeeded",
      amountRefunded: amount,
    });
  },
  async cancelPaymentIntent() {
    return Ok(undefined);
  },
  async verifyWebhook() {
    return Ok({ id: "evt_mock", type: "payment.succeeded", data: {} });
  },
};

export default defineConfig({
  storeName: "Acme Streetwear",
  version: "1.0.0",

  // App-level schema: extended core tables — no plugin needed
  schema: [
    { extendedSellableEntities },
  ],

  database: {
    provider: "postgresql",
  },
  databaseAdapter: postgresAdapter({
    connectionString: DATABASE_URL,
    // Fly Managed Postgres (and most managed PG offerings) front the DB
    // with a transaction-mode pooler that rejects libpq startup params.
    // When deployed (DATABASE_URL contains a non-localhost host), tell
    // the adapter to skip them. Set timeouts on the DB role instead.
    pool: {
      pooled: !DATABASE_URL.includes("localhost"),
    },
  }),

  storage: localStorageAdapter({
    basePath: "./.data/media",
    baseUrl: `${PUBLIC_URL}/assets`,
  }),

  auth: {
    // VAPT demo default only; production storefronts must set this to true
    // and configure config.email.send for verification delivery.
    requireEmailVerification: false,
    // For B2C single-storefront deployments, every customer falls into the
    // store's default org. Without this, strict-org-resolution rejects
    // customer-self-service requests (the customer has no Better Auth org
    // membership). Multi-tenant SaaS deployments should use storeResolver
    // instead and leave this unset.
    defaultOrganizationId: "org_default",
    apiKeys: { enabled: true, defaultPermissions: ["catalog:read", "orders:read"] },
    trustedOrigins: [PUBLIC_URL],
    roles: {
      owner: { permissions: ["*:*"] },
      admin: { permissions: ["*:*"] },
      staff: {
        permissions: [
          "catalog:create",
          "catalog:update",
          "catalog:read",
          "inventory:adjust",
          "inventory:read",
          "orders:create",
          "orders:read",
          "orders:update",
          "cart:create",
          "cart:update",
          "customers:read",
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
      fields: [
        { name: "weight", type: "number", unit: "grams" },
        { name: "material", type: "text" },
        { name: "care_instructions", type: "text" },
      ],
      variants: { enabled: true, optionTypes: ["size", "color"] },
      fulfillment: "physical",
    },
    gift_card: {
      fields: [{ name: "denomination", type: "number" }],
      variants: { enabled: false },
      fulfillment: "digital",
    },
  },

  shipping: {
    type: "weight_based",
    flatRate: 500, // cents — fallback for flat rate
    freeShippingThreshold: 10000, // free shipping over $100
    brackets: [
      { upToGrams: 500, cost: 499 },
      { upToGrams: 1000, cost: 799 },
      { upToGrams: 2000, cost: 1199 },
      { upToGrams: 5000, cost: 1599 },
    ],
    fallbackCost: 1999,
  },

  payments: [mockPayments],

  routes: (app, kernel) => {
    supplierInfoRoutes(app, kernel);
  },

  plugins: [
    loyaltyPlugin({
      pointsPerDollar: 1,
      tierThresholds: { silver: 500, gold: 1500, platinum: 3000 },
    }),
    wishlistPlugin(),
    reviewsPlugin(),
  ],
});
