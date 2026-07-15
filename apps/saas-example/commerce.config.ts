import { defineConfig, Ok, type PaymentAdapter } from "@porulle/core";
import { postgresAdapter } from "@porulle/adapter-postgres";
import { localStorageAdapter } from "@porulle/adapter-local-storage";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://localhost:5432/saas_example";

const mockPayments: PaymentAdapter = {
  providerId: "card-mock",
  async createPaymentIntent(params) {
    return Ok({
      id: `pi_${Date.now()}`,
      status: "requires_capture",
      amount: params.amount,
      currency: params.currency,
      clientSecret: `secret_${Date.now()}`,
    });
  },
  async capturePayment(paymentIntentId, amount) {
    // Return the captured amount only when specified; leaving it undefined lets
    // the core capture() default to the full order total (production Stripe
    // captures the full authorized amount when no amount is passed).
    return Ok({ id: paymentIntentId, status: "succeeded", ...(amount != null ? { amountCaptured: amount } : {}) });
  },
  async refundPayment(paymentId, amount) {
    return Ok({ id: `re_${Date.now()}`, status: "succeeded", amountRefunded: amount });
  },
  async cancelPaymentIntent() {
    return Ok(undefined);
  },
  async verifyWebhook(request: Request) {
    const payload = await request.clone().json() as Record<string, unknown>;
    return Ok({ id: `evt_${Date.now()}`, type: String(payload.type ?? ""), data: payload.data ?? {} });
  },
};

/**
 * SaaS Example Configuration
 *
 * This config powers a multi-tenant commerce SaaS. Multiple organizations
 * (stores) share one UC instance. Each organization has its own catalog,
 * orders, customers, inventory, and pricing — completely isolated.
 *
 * The seed script creates two stores:
 * - "Alpha Streetwear" (org_alpha) — urban fashion
 * - "Beta Organics" (org_beta) — organic food
 *
 * Both stores use the same slug "summer-special" to demonstrate
 * composite unique constraints (organizationId + slug).
 */
export default defineConfig({
  storeName: "UnifiedCommerce SaaS Platform",
  version: "1.0.0",

  database: { provider: "postgresql" },
  databaseAdapter: postgresAdapter({ connectionString: DATABASE_URL }),

  storage: localStorageAdapter({
    basePath: "./.data/media",
    baseUrl: "http://localhost:4001/assets",
  }),

  auth: {
    requireEmailVerification: false,
    trustedOrigins: ["http://localhost:4001"],
    roles: {
      owner: { permissions: ["*:*"] },
      admin: { permissions: ["*:*"] },
      staff: {
        permissions: [
          "catalog:read", "catalog:create", "catalog:update",
          "inventory:adjust", "orders:read", "orders:create", "orders:update",
          "pricing:manage", "promotions:manage",
        ],
      },
      customer: {
        permissions: [
          "catalog:read", "cart:create", "cart:read", "cart:update",
          "orders:create", "orders:read:own",
        ],
      },
    },
    customerPermissions: [
      "catalog:read", "cart:create", "cart:read", "cart:update",
      "orders:create", "orders:read:own",
    ],
  },

  entities: {
    product: {
      fields: [],
      variants: { enabled: true, optionTypes: ["size", "color"] },
      fulfillment: "physical",
    },
  },

  shipping: {
    type: "flat" as const,
    flatRate: 500,
    freeShippingThreshold: 5000,
    brackets: [],
    fallbackCost: 500,
  },

  payments: [mockPayments],

  email: {
    async send(input) {
      console.log(`[EMAIL] ${input.template} -> ${input.to}`, input.data);
    },
  },
});
