/**
 * Commerce config for "The Blue Apron Bistro" — a full-service restaurant
 * demonstrating POS + Restaurant Extension plugins.
 *
 * Stakeholder roles:
 * - owner: CEO/founder — full access, P&L visibility, audit trail
 * - manager: Floor manager — voids, discounts, returns, KDS admin, checklists
 * - cashier: POS operator — ring up sales, accept payment, open/close shifts
 * - server: Waitstaff — table assignment, order taking, KDS viewing
 * - chef: Kitchen staff — KDS ticket status updates only
 * - barista: Bar station — KDS viewing for drinks only
 */

import { defineConfig, Ok, type PaymentAdapter } from "@porulle/core";
import { postgresAdapter } from "@porulle/adapter-postgres";
import { localStorageAdapter } from "@porulle/adapter-local-storage";
import { posPlugin } from "@porulle/plugin-pos";
import { posRestaurantPlugin } from "@porulle/plugin-pos-restaurant";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://localhost:5432/uc_restaurant";

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
    return Ok({ id: paymentIntentId, status: "succeeded", amountCaptured: amount ?? 0 });
  },
  async refundPayment(_paymentId: string, amount: number) {
    return Ok({ id: `re_${Date.now()}`, status: "succeeded", amountRefunded: amount });
  },
  async cancelPaymentIntent() { return Ok(undefined); },
  async verifyWebhook() { return Ok({ id: "evt_mock", type: "payment.succeeded", data: {} }); },
};

export default defineConfig({
  storeName: "The Blue Apron Bistro",
  version: "1.0.0",

  database: { provider: "postgresql" },
  databaseAdapter: postgresAdapter({ connectionString: DATABASE_URL }),
  storage: localStorageAdapter({ basePath: "./.data/media", baseUrl: "http://localhost:4002/assets" }),

  auth: {
    requireEmailVerification: false,
    apiKeys: { enabled: true, defaultPermissions: ["catalog:read"] },
    trustedOrigins: ["http://localhost:4002"],
    roles: {
      owner: { permissions: ["*:*"] },
      manager: {
        permissions: [
          "pos:admin", "pos:manage", "pos:operate",
          "pos-restaurant:admin",
          "catalog:read", "catalog:create", "catalog:update",
          "inventory:adjust", "inventory:read",
          "orders:create", "orders:read", "orders:update",
          "cart:create", "cart:update", "cart:read",
          "customers:read",
        ],
      },
      cashier: {
        permissions: [
          "pos:operate",
          "catalog:read", "orders:create", "orders:read",
          "cart:create", "cart:update", "cart:read",
          "customers:read",
        ],
      },
      server: {
        permissions: [
          "pos:operate",
          "catalog:read",
          "cart:create", "cart:update", "cart:read",
        ],
      },
      chef: {
        permissions: ["pos:operate", "catalog:read"],
      },
      barista: {
        permissions: ["pos:operate", "catalog:read"],
      },
      customer: {
        permissions: ["catalog:read", "cart:create", "cart:read", "orders:read:own"],
      },
    },
  },

  rateLimits: { api: 10000, auth: 10000, checkout: 10000 },

  entities: {
    product: {
      fields: [
        { name: "prep_time_minutes", type: "number" },
        { name: "allergens", type: "text" },
        { name: "course", type: "text" },
      ],
      variants: { enabled: true, optionTypes: ["size", "temperature"] },
      fulfillment: "physical",
    },
  },

  shipping: { type: "flat", flatRate: 0, brackets: [], fallbackCost: 0 },
  payments: [mockPayments],

  plugins: [
    posPlugin({ defaultCurrency: "USD", maxHoldHours: 24, discountOverrideThreshold: 20 }),
    posRestaurantPlugin({ enableKDS: true, enableTips: true, enableModifiers: true, kdsAlertMinutes: 15 }),
  ],
});
