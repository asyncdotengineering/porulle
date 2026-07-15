import type { CommerceConfig } from "./types.js";

export const defaultConfig: Partial<CommerceConfig> = {
  version: "0.0.1",
  auth: {
    requireEmailVerification: true,
    sessionDuration: 60 * 60 * 24 * 7,
    twoFactor: { enabled: false },
    apiKeys: { enabled: false },
    posPin: { enabled: false },
    apiKeyScopes: {
      compensation_admin: {
        prefix: "uc_cfadm_",
        description: "List and resolve compensation step failures",
        permissions: { compensation: ["admin"] },
      },
    },
    roles: {
      owner: { permissions: ["*:*"] },
      admin: { permissions: ["*:*", "compensation:admin"] },
      manager: {
        permissions: [
          "catalog:create",
          "catalog:update",
          "catalog:delete",
          "catalog:read",
          "inventory:read",
          "inventory:adjust",
          "orders:read",
          "orders:create",
          "orders:update",
          "orders:manage",
          "cart:create",
          "cart:update",
          "cart:manage",
          "shipping:manage",
          "tax:manage",
          "settings:manage",
          "analytics:read",
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
  cart: {
    ttlMinutes: 60 * 24 * 7,
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
      beforeDelete: [],
    },
  },
  inventory: {
    hooks: {
      afterAdjust: [],
    },
  },
};
