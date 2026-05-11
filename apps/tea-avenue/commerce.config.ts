/**
 * Tea Avenue — Multi-Outlet Sri Lankan Tea Chain
 *
 * Composes ALL 11 operational plugins to exercise every requirement
 * from the Tea Avenue POS CSV (dated 21.02.23).
 *
 * Outlets:
 *   org_ta_col7    — Tea Avenue Colombo 7 (flagship, dine-in + takeaway)
 *   org_ta_kandy   — Tea Avenue Kandy (smaller, takeaway-focused)
 *   org_ta_central — Tea Avenue Central Kitchen (production + warehouse)
 */

import { defineConfig, Ok, type PaymentAdapter } from "@porulle/core";
import { postgresAdapter } from "@porulle/adapter-postgres";
import { localStorageAdapter } from "@porulle/adapter-local-storage";
import { posPlugin } from "@porulle/plugin-pos";
import { posRestaurantPlugin } from "@porulle/plugin-pos-restaurant";
import { uomPlugin } from "@porulle/plugin-uom";
import { procurementPlugin } from "@porulle/plugin-procurement";
import { warehousePlugin } from "@porulle/plugin-warehouse";
import { productionPlugin } from "@porulle/plugin-production";
import { loyaltyPlugin } from "@porulle/plugin-loyalty";
import { notificationsPlugin } from "@porulle/plugin-notifications";
import { scheduledOrdersPlugin } from "@porulle/plugin-scheduled-orders";
import { reviewsPlugin } from "@porulle/plugin-reviews";
import { wishlistPlugin } from "@porulle/plugin-wishlist";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://localhost:5432/tea_avenue";

const mockPayments: PaymentAdapter = {
  providerId: "mock-payments",
  async createPaymentIntent(params: { amount: number; currency: string }) {
    return Ok({ id: `pi_${Date.now()}`, status: "requires_capture", amount: params.amount, currency: params.currency, clientSecret: `secret_${Date.now()}` });
  },
  async capturePayment(id: string, amount?: number) { return Ok({ id, status: "succeeded", amountCaptured: amount ?? 0 }); },
  async refundPayment(_id: string, amount: number) { return Ok({ id: `re_${Date.now()}`, status: "succeeded", amountRefunded: amount }); },
  async cancelPaymentIntent() { return Ok(undefined); },
  async verifyWebhook() { return Ok({ id: "evt_mock", type: "payment.succeeded", data: {} }); },
};

export default defineConfig({
  storeName: "Tea Avenue",
  version: "1.0.0",

  database: { provider: "postgresql" },
  databaseAdapter: postgresAdapter({ connectionString: DATABASE_URL }),
  storage: localStorageAdapter({ basePath: "./.data/media", baseUrl: "http://localhost:4003/assets" }),

  auth: {
    requireEmailVerification: false,
    apiKeys: { enabled: true, defaultPermissions: ["catalog:read"] },
    trustedOrigins: ["http://localhost:4003"],
    roles: {
      owner: { permissions: ["*:*"] },
      manager: {
        permissions: [
          "pos:admin", "pos:manage", "pos:operate", "pos-restaurant:admin",
          "procurement:admin", "procurement:create", "procurement:read",
          "warehouse:admin", "warehouse:operate", "warehouse:read",
          "production:admin", "production:create", "production:read",
          "uom:admin", "uom:read", "loyalty:admin",
          "notifications:admin", "notifications:write", "notifications:read",
          "reviews:admin", "reviews:read", "reviews:write",
          "scheduled-orders:admin", "scheduled-orders:create", "scheduled-orders:read",
          "catalog:read", "catalog:create", "catalog:update",
          "inventory:adjust", "inventory:read",
          "orders:create", "orders:read", "orders:update",
          "cart:create", "cart:update", "cart:read", "customers:read",
        ],
      },
      cashier: {
        permissions: [
          "pos:operate", "catalog:read", "orders:create", "orders:read",
          "cart:create", "cart:update", "cart:read", "customers:read",
        ],
      },
      barista: { permissions: ["pos:operate", "catalog:read"] },
      kitchen: { permissions: ["pos:operate", "catalog:read"] },
      customer: {
        permissions: [
          "catalog:read", "cart:create", "cart:read", "cart:update",
          "orders:create", "orders:read:own", "customers:read:self",
          "reviews:write", "reviews:read", "wishlist:read", "wishlist:write",
          "scheduled-orders:create", "scheduled-orders:read",
        ],
      },
    },
  },

  rateLimits: { api: 10000, auth: 10000, checkout: 10000 },

  entities: {
    tea: {
      fields: [
        { name: "brew_time_seconds", type: "number" },
        { name: "temperature_celsius", type: "number" },
        { name: "caffeine_mg", type: "number" },
        { name: "origin", type: "text" },
      ],
      variants: { enabled: true, optionTypes: ["size", "temperature"] },
      fulfillment: "physical",
    },
    snack: {
      fields: [
        { name: "calories", type: "number" },
        { name: "allergens", type: "text" },
        { name: "is_vegetarian", type: "text" },
      ],
      variants: { enabled: false },
      fulfillment: "physical",
    },
  },

  shipping: { type: "flat", flatRate: 0, brackets: [], fallbackCost: 0 },
  payments: [mockPayments],

  plugins: [
    // POS + Restaurant
    posPlugin({ defaultCurrency: "LKR", maxHoldHours: 24, discountOverrideThreshold: 20 }),
    posRestaurantPlugin({ enableKDS: true, enableTips: true, enableModifiers: true, kdsAlertMinutes: 10 }),
    // Supply Chain
    uomPlugin(),
    procurementPlugin(),
    warehousePlugin(),
    productionPlugin(),
    // Customer Experience
    loyaltyPlugin({ pointsPerDollar: 10, tierThresholds: { silver: 1000, gold: 5000, platinum: 15000 } }),
    notificationsPlugin(),
    scheduledOrdersPlugin(),
    reviewsPlugin(),
    wishlistPlugin(),
  ],
});
