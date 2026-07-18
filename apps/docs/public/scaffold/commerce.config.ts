import { defineConfig, Ok, type PaymentAdapter } from "@porulle/core";
import { pgliteAdapter } from "@porulle/adapter-pglite";
import { localStorageAdapter } from "@porulle/adapter-local-storage";

// The public origin of this instance — trusted for auth (CSRF/cookies) and used
// as the prefix for uploaded media. Localhost for dev; set the https origin in prod.
const PUBLIC_URL = process.env.PUBLIC_URL ?? "http://localhost:4000";

// ── Payments ───────────────────────────────────────────────────────────────
// Runs out of the box with a mock gateway (no keys needed). For real payments,
// `pnpm add @porulle/adapter-stripe` and swap the line in `payments:` below:
//   import { stripeAdapter } from "@porulle/adapter-stripe";
//   payments: [stripeAdapter({ secretKey: process.env.STRIPE_SECRET_KEY!, webhookSecret: process.env.STRIPE_WEBHOOK_SECRET! })],
const mockPayments: PaymentAdapter = {
  providerId: "mock-payments",
  async createPaymentIntent(p: { amount: number; currency: string }) {
    return Ok({ id: `pi_${Date.now()}`, status: "requires_capture", amount: p.amount, currency: p.currency, clientSecret: `secret_${Date.now()}` });
  },
  async capturePayment(id: string, amount?: number) {
    return Ok({ id, status: "succeeded", amountCaptured: amount ?? 0 });
  },
  async refundPayment(_id: string, amount: number) {
    return Ok({ id: `re_${Date.now()}`, status: "succeeded", amountRefunded: amount });
  },
  async cancelPaymentIntent() {
    return Ok(undefined);
  },
  async verifyWebhook() {
    return Ok({ id: "evt_mock", type: "payment.succeeded", data: {} });
  },
};

export default defineConfig({
  storeName: "My Porulle Store",
  version: "0.1.0",

  // Zero-infra embedded Postgres (PGlite). Persists to ./.data/pgdata; schema is
  // pushed on boot — no migration command. For production, swap one line:
  //   import { postgresAdapter } from "@porulle/adapter-postgres";
  //   databaseAdapter: postgresAdapter({ connectionString: process.env.DATABASE_URL! }),
  database: { provider: "postgresql" },
  databaseAdapter: await pgliteAdapter({ path: process.env.PGLITE_PATH ?? "./.data/pgdata" }),

  storage: localStorageAdapter({
    basePath: "./.data/media",
    baseUrl: `${PUBLIC_URL}/assets`,
  }),

  auth: {
    requireEmailVerification: false,
    // Single-storefront / B2C: every customer falls into the store's default org.
    defaultOrganizationId: "org_default",
    apiKeys: { enabled: true, defaultPermissions: ["catalog:read", "orders:read"] },
    trustedOrigins: [PUBLIC_URL],
  },

  // Your catalog shape — the 20% to make your own.
  entities: {
    product: {
      fields: [
        { name: "material", type: "text" },
        { name: "weight", type: "number", unit: "grams" },
      ],
      variants: { enabled: true, optionTypes: ["size", "color"] },
      fulfillment: "physical",
    },
  },

  shipping: {
    type: "flat_rate",
    flatRate: 500, // cents
    freeShippingThreshold: 10000, // free over $100
  },

  payments: [mockPayments],

  // Add plugins as you grow, e.g.:
  //   import { loyaltyPlugin } from "@porulle/plugin-loyalty";
  //   plugins: [loyaltyPlugin({ pointsPerDollar: 1 })],
  plugins: [],
});
