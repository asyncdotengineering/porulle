/**
 * Combined schema barrel for Drizzle.
 *
 * Single source of truth for all core table definitions. Both drizzle-kit
 * (via drizzle.config.ts) and the TypeScript type system consume this file.
 *
 * Drizzle-kit resolves re-exports, so pointing the config schema option
 * at this one file discovers every core table. Plugin schemas live in
 * their own packages and are referenced via glob patterns.
 */

// Auth (Better Auth generated tables)
export * from "../../auth/auth-schema.js";

// Catalog module
export * from "../../modules/catalog/schema.js";

// Inventory module
export * from "../../modules/inventory/schema.js";

// Cart module
export * from "../../modules/cart/schema.js";

// Orders module
export * from "../../modules/orders/schema.js";
export * from "../../modules/orders/sequences.js";

// Customers module
export * from "../../modules/customers/schema.js";

// Pricing module
export * from "../../modules/pricing/schema.js";

// Promotions module
export * from "../../modules/promotions/schema.js";

// Media module
export * from "../../modules/media/schema.js";

// Webhooks module
export * from "../../modules/webhooks/schema.js";

// Fulfillment module
export * from "../../modules/fulfillment/schema.js";

// Shipping module (runtime zones & rates)
export * from "../../modules/shipping/schema.js";

// Tax module (runtime tax rates)
export * from "../../modules/tax/schema.js";

// Settings module (org-scoped runtime settings)
export * from "../../modules/settings/schema.js";

// Documents module (fiscal sequences + issued documents)
export * from "../../modules/documents/schema.js";

// Jobs (kernel)
export * from "../jobs/schema.js";

// Compensation failures (kernel)
export * from "../compensation/schema.js";

// Audit module
export * from "../../modules/audit/schema.js";
