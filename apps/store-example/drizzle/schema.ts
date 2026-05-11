import { pgTable, unique, text, timestamp, integer, boolean, foreignKey, uuid, jsonb, index } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"



export const organization = pgTable("organization", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	slug: text().notNull(),
	logo: text(),
	createdAt: timestamp("created_at", { mode: 'string' }).notNull(),
	metadata: text(),
}, (table) => [
	unique("organization_slug_unique").on(table.slug),
]);

export const apikey = pgTable("apikey", {
	id: text().primaryKey().notNull(),
	configId: text("config_id").default('default').notNull(),
	name: text(),
	start: text(),
	referenceId: text("reference_id").notNull(),
	prefix: text(),
	key: text().notNull(),
	refillInterval: integer("refill_interval"),
	refillAmount: integer("refill_amount"),
	lastRefillAt: timestamp("last_refill_at", { mode: 'string' }),
	enabled: boolean().default(true),
	rateLimitEnabled: boolean("rate_limit_enabled").default(true),
	rateLimitTimeWindow: integer("rate_limit_time_window").default(86400000),
	rateLimitMax: integer("rate_limit_max").default(10),
	requestCount: integer("request_count").default(0),
	remaining: integer(),
	lastRequest: timestamp("last_request", { mode: 'string' }),
	expiresAt: timestamp("expires_at", { mode: 'string' }),
	createdAt: timestamp("created_at", { mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).notNull(),
	permissions: text(),
	metadata: text(),
});

export const member = pgTable("member", {
	id: text().primaryKey().notNull(),
	organizationId: text("organization_id").notNull(),
	userId: text("user_id").notNull(),
	role: text().default('member').notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "member_organization_id_organization_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "member_user_id_user_id_fk"
		}).onDelete("cascade"),
]);

export const session = pgTable("session", {
	id: text().primaryKey().notNull(),
	expiresAt: timestamp("expires_at", { mode: 'string' }).notNull(),
	token: text().notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).notNull(),
	ipAddress: text("ip_address"),
	userAgent: text("user_agent"),
	userId: text("user_id").notNull(),
	activeOrganizationId: text("active_organization_id"),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "session_user_id_user_id_fk"
		}).onDelete("cascade"),
	unique("session_token_unique").on(table.token),
]);

export const brands = pgTable("brands", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	slug: text().notNull(),
	displayName: text("display_name").notNull(),
	metadata: jsonb().default({}),
}, (table) => [
	unique("brands_slug_unique").on(table.slug),
]);

export const invitation = pgTable("invitation", {
	id: text().primaryKey().notNull(),
	organizationId: text("organization_id").notNull(),
	email: text().notNull(),
	role: text(),
	status: text().default('pending').notNull(),
	expiresAt: timestamp("expires_at", { mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	inviterId: text("inviter_id").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "invitation_organization_id_organization_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.inviterId],
			foreignColumns: [user.id],
			name: "invitation_inviter_id_user_id_fk"
		}).onDelete("cascade"),
]);

export const verification = pgTable("verification", {
	id: text().primaryKey().notNull(),
	identifier: text().notNull(),
	value: text().notNull(),
	expiresAt: timestamp("expires_at", { mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
});

export const user = pgTable("user", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	email: text().notNull(),
	emailVerified: boolean("email_verified").default(false).notNull(),
	image: text(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
	vendorId: text("vendor_id"),
	posOperatorPin: text("pos_operator_pin"),
}, (table) => [
	unique("user_email_unique").on(table.email),
]);

export const optionValues = pgTable("option_values", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	optionTypeId: uuid("option_type_id").notNull(),
	value: text().notNull(),
	displayValue: text("display_value").notNull(),
	sortOrder: integer("sort_order").default(0).notNull(),
	metadata: jsonb().default({}),
}, (table) => [
	foreignKey({
			columns: [table.optionTypeId],
			foreignColumns: [optionTypes.id],
			name: "option_values_option_type_id_option_types_id_fk"
		}).onDelete("cascade"),
]);

export const sellableAttributes = pgTable("sellable_attributes", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	entityId: uuid("entity_id").notNull(),
	locale: text().default('en').notNull(),
	title: text().notNull(),
	subtitle: text(),
	description: text(),
	richDescription: jsonb("rich_description"),
	seoTitle: text("seo_title"),
	seoDescription: text("seo_description"),
}, (table) => [
	index("idx_sellable_attrs_entity_locale").using("btree", table.entityId.asc().nullsLast().op("text_ops"), table.locale.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.entityId],
			foreignColumns: [sellableEntities.id],
			name: "sellable_attributes_entity_id_sellable_entities_id_fk"
		}).onDelete("cascade"),
]);

export const categories = pgTable("categories", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	parentId: uuid("parent_id"),
	slug: text().notNull(),
	sortOrder: integer("sort_order").default(0).notNull(),
	metadata: jsonb().default({}),
}, (table) => [
	foreignKey({
			columns: [table.parentId],
			foreignColumns: [table.id],
			name: "categories_parent_id_categories_id_fk"
		}).onDelete("set null"),
	unique("categories_slug_unique").on(table.slug),
]);

export const entityBrands = pgTable("entity_brands", {
	entityId: uuid("entity_id").notNull(),
	brandId: uuid("brand_id").notNull(),
	sortOrder: integer("sort_order").default(0).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.entityId],
			foreignColumns: [sellableEntities.id],
			name: "entity_brands_entity_id_sellable_entities_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.brandId],
			foreignColumns: [brands.id],
			name: "entity_brands_brand_id_brands_id_fk"
		}).onDelete("cascade"),
]);

export const optionTypes = pgTable("option_types", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	entityId: uuid("entity_id").notNull(),
	name: text().notNull(),
	displayName: text("display_name").notNull(),
	sortOrder: integer("sort_order").default(0).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.entityId],
			foreignColumns: [sellableEntities.id],
			name: "option_types_entity_id_sellable_entities_id_fk"
		}).onDelete("cascade"),
]);

export const sellableCustomFields = pgTable("sellable_custom_fields", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	entityId: uuid("entity_id").notNull(),
	fieldName: text("field_name").notNull(),
	fieldType: text("field_type").notNull(),
	textValue: text("text_value"),
	numberValue: integer("number_value"),
	booleanValue: boolean("boolean_value"),
	dateValue: timestamp("date_value", { withTimezone: true, mode: 'string' }),
	jsonValue: jsonb("json_value"),
}, (table) => [
	index("idx_custom_fields_entity_field").using("btree", table.entityId.asc().nullsLast().op("text_ops"), table.fieldName.asc().nullsLast().op("uuid_ops")),
	index("idx_custom_fields_number").using("btree", table.fieldName.asc().nullsLast().op("int4_ops"), table.numberValue.asc().nullsLast().op("int4_ops")),
	index("idx_custom_fields_text").using("btree", table.fieldName.asc().nullsLast().op("text_ops"), table.textValue.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.entityId],
			foreignColumns: [sellableEntities.id],
			name: "sellable_custom_fields_entity_id_sellable_entities_id_fk"
		}).onDelete("cascade"),
]);

export const inventoryLevels = pgTable("inventory_levels", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	entityId: uuid("entity_id").notNull(),
	variantId: uuid("variant_id"),
	warehouseId: uuid("warehouse_id").notNull(),
	quantityOnHand: integer("quantity_on_hand").default(0).notNull(),
	quantityReserved: integer("quantity_reserved").default(0).notNull(),
	quantityIncoming: integer("quantity_incoming").default(0).notNull(),
	unitCost: integer("unit_cost"),
	reorderThreshold: integer("reorder_threshold"),
	reorderQuantity: integer("reorder_quantity"),
	version: integer().default(0).notNull(),
	lastRestockedAt: timestamp("last_restocked_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_inventory_entity_variant_warehouse").using("btree", table.entityId.asc().nullsLast().op("uuid_ops"), table.variantId.asc().nullsLast().op("uuid_ops"), table.warehouseId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.entityId],
			foreignColumns: [sellableEntities.id],
			name: "inventory_levels_entity_id_sellable_entities_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.variantId],
			foreignColumns: [variants.id],
			name: "inventory_levels_variant_id_variants_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.warehouseId],
			foreignColumns: [warehouses.id],
			name: "inventory_levels_warehouse_id_warehouses_id_fk"
		}),
]);

export const entityMedia = pgTable("entity_media", {
	entityId: uuid("entity_id").notNull(),
	variantId: uuid("variant_id"),
	mediaAssetId: uuid("media_asset_id").notNull(),
	role: text().notNull(),
	sortOrder: integer("sort_order").default(0).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.entityId],
			foreignColumns: [sellableEntities.id],
			name: "entity_media_entity_id_sellable_entities_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.variantId],
			foreignColumns: [variants.id],
			name: "entity_media_variant_id_variants_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.mediaAssetId],
			foreignColumns: [mediaAssets.id],
			name: "entity_media_media_asset_id_media_assets_id_fk"
		}).onDelete("cascade"),
]);

export const inventoryMovements = pgTable("inventory_movements", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	entityId: uuid("entity_id").notNull(),
	variantId: uuid("variant_id"),
	warehouseId: uuid("warehouse_id").notNull(),
	type: text().notNull(),
	quantity: integer().notNull(),
	referenceType: text("reference_type"),
	referenceId: text("reference_id"),
	reason: text(),
	performedBy: text("performed_by").notNull(),
	performedAt: timestamp("performed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.entityId],
			foreignColumns: [sellableEntities.id],
			name: "inventory_movements_entity_id_sellable_entities_id_fk"
		}),
	foreignKey({
			columns: [table.variantId],
			foreignColumns: [variants.id],
			name: "inventory_movements_variant_id_variants_id_fk"
		}),
	foreignKey({
			columns: [table.warehouseId],
			foreignColumns: [warehouses.id],
			name: "inventory_movements_warehouse_id_warehouses_id_fk"
		}),
]);

export const mediaAssets = pgTable("media_assets", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	storageKey: text("storage_key").notNull(),
	filename: text().notNull(),
	contentType: text("content_type").notNull(),
	size: integer().notNull(),
	width: integer(),
	height: integer(),
	alt: text(),
	metadata: jsonb().default({}),
	uploadedAt: timestamp("uploaded_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const carts = pgTable("carts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	customerId: uuid("customer_id"),
	status: text().default('active').notNull(),
	currency: text().default('USD').notNull(),
	secret: text(),
	metadata: jsonb().default({}),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const sellableEntities = pgTable("sellable_entities", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	type: text().notNull(),
	slug: text().notNull(),
	status: text().default('draft').notNull(),
	isVisible: boolean("is_visible").default(false).notNull(),
	metadata: jsonb().default({}),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	publishedAt: timestamp("published_at", { withTimezone: true, mode: 'string' }),
	supplierCode: text("supplier_code"),
	countryOfOrigin: text("country_of_origin"),
}, (table) => [
	unique("sellable_entities_slug_unique").on(table.slug),
]);

export const variants = pgTable("variants", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	entityId: uuid("entity_id").notNull(),
	sku: text(),
	barcode: text(),
	status: text().default('active').notNull(),
	sortOrder: integer("sort_order").default(0).notNull(),
	metadata: jsonb().default({}),
}, (table) => [
	foreignKey({
			columns: [table.entityId],
			foreignColumns: [sellableEntities.id],
			name: "variants_entity_id_sellable_entities_id_fk"
		}).onDelete("cascade"),
	unique("variants_sku_unique").on(table.sku),
]);

export const warehouses = pgTable("warehouses", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	code: text().notNull(),
	address: jsonb(),
	isActive: boolean("is_active").default(true).notNull(),
	priority: integer().default(0).notNull(),
	metadata: jsonb().default({}),
}, (table) => [
	unique("warehouses_code_unique").on(table.code),
]);

export const cartLineItems = pgTable("cart_line_items", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	cartId: uuid("cart_id").notNull(),
	entityId: uuid("entity_id").notNull(),
	variantId: uuid("variant_id"),
	quantity: integer().default(1).notNull(),
	unitPriceSnapshot: integer("unit_price_snapshot").notNull(),
	currency: text().notNull(),
	metadata: jsonb().default({}),
	addedAt: timestamp("added_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.cartId],
			foreignColumns: [carts.id],
			name: "cart_line_items_cart_id_carts_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.entityId],
			foreignColumns: [sellableEntities.id],
			name: "cart_line_items_entity_id_sellable_entities_id_fk"
		}),
	foreignKey({
			columns: [table.variantId],
			foreignColumns: [variants.id],
			name: "cart_line_items_variant_id_variants_id_fk"
		}),
]);

export const orderStatusHistory = pgTable("order_status_history", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orderId: uuid("order_id").notNull(),
	fromStatus: text("from_status").notNull(),
	toStatus: text("to_status").notNull(),
	reason: text(),
	changedBy: text("changed_by").notNull(),
	changedAt: timestamp("changed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.orderId],
			foreignColumns: [orders.id],
			name: "order_status_history_order_id_orders_id_fk"
		}).onDelete("cascade"),
]);

export const webhookEndpoints = pgTable("webhook_endpoints", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	url: text().notNull(),
	secret: text().notNull(),
	events: jsonb().notNull(),
	isActive: boolean("is_active").default(true).notNull(),
	metadata: jsonb().default({}),
});

export const webhookDeliveries = pgTable("webhook_deliveries", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	endpointId: uuid("endpoint_id").notNull(),
	eventName: text("event_name").notNull(),
	payload: jsonb().notNull(),
	statusCode: integer("status_code"),
	attemptCount: integer("attempt_count").default(0).notNull(),
	nextRetryAt: timestamp("next_retry_at", { withTimezone: true, mode: 'string' }),
	deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: 'string' }),
	failedAt: timestamp("failed_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.endpointId],
			foreignColumns: [webhookEndpoints.id],
			name: "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk"
		}),
]);

export const customerAddresses = pgTable("customer_addresses", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	customerId: uuid("customer_id").notNull(),
	type: text().notNull(),
	isDefault: boolean("is_default").default(false).notNull(),
	firstName: text("first_name").notNull(),
	lastName: text("last_name").notNull(),
	line1: text().notNull(),
	line2: text(),
	city: text().notNull(),
	state: text(),
	postalCode: text("postal_code"),
	country: text().notNull(),
	phone: text(),
}, (table) => [
	foreignKey({
			columns: [table.customerId],
			foreignColumns: [customers.id],
			name: "customer_addresses_customer_id_customers_id_fk"
		}).onDelete("cascade"),
]);

export const orders = pgTable("orders", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orderNumber: text("order_number").notNull(),
	customerId: uuid("customer_id"),
	status: text().default('pending').notNull(),
	currency: text().notNull(),
	subtotal: integer().notNull(),
	taxTotal: integer("tax_total").notNull(),
	shippingTotal: integer("shipping_total").notNull(),
	discountTotal: integer("discount_total").default(0).notNull(),
	grandTotal: integer("grand_total").notNull(),
	metadata: jsonb().default({}),
	placedAt: timestamp("placed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	fulfilledAt: timestamp("fulfilled_at", { withTimezone: true, mode: 'string' }),
	cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	unique("orders_order_number_unique").on(table.orderNumber),
]);

export const customerGroups = pgTable("customer_groups", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	description: text(),
	metadata: jsonb().default({}),
}, (table) => [
	unique("customer_groups_name_unique").on(table.name),
]);

export const prices = pgTable("prices", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	entityId: uuid("entity_id").notNull(),
	variantId: uuid("variant_id"),
	currency: text().notNull(),
	amount: integer().notNull(),
	customerGroupId: text("customer_group_id"),
	minQuantity: integer("min_quantity"),
	maxQuantity: integer("max_quantity"),
	validFrom: timestamp("valid_from", { withTimezone: true, mode: 'string' }),
	validUntil: timestamp("valid_until", { withTimezone: true, mode: 'string' }),
	metadata: jsonb().default({}),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_prices_customer_group").using("btree", table.customerGroupId.asc().nullsLast().op("text_ops")),
	index("idx_prices_entity_variant_currency").using("btree", table.entityId.asc().nullsLast().op("text_ops"), table.variantId.asc().nullsLast().op("uuid_ops"), table.currency.asc().nullsLast().op("text_ops")),
	index("idx_prices_quantity").using("btree", table.minQuantity.asc().nullsLast().op("int4_ops"), table.maxQuantity.asc().nullsLast().op("int4_ops")),
	index("idx_prices_validity").using("btree", table.validFrom.asc().nullsLast().op("timestamptz_ops"), table.validUntil.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.entityId],
			foreignColumns: [sellableEntities.id],
			name: "prices_entity_id_sellable_entities_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.variantId],
			foreignColumns: [variants.id],
			name: "prices_variant_id_variants_id_fk"
		}).onDelete("cascade"),
]);

export const promotions = pgTable("promotions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	code: text(),
	name: text().notNull(),
	type: text().notNull(),
	value: integer().default(0).notNull(),
	buyQuantity: integer("buy_quantity"),
	getQuantity: integer("get_quantity"),
	isAutomatic: boolean("is_automatic").default(false).notNull(),
	isActive: boolean("is_active").default(true).notNull(),
	priority: integer().default(100).notNull(),
	conditions: jsonb().default({}),
	usageLimitTotal: integer("usage_limit_total"),
	usageLimitPerCustomer: integer("usage_limit_per_customer"),
	validFrom: timestamp("valid_from", { withTimezone: true, mode: 'string' }),
	validUntil: timestamp("valid_until", { withTimezone: true, mode: 'string' }),
	metadata: jsonb().default({}),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_promotions_active_priority").using("btree", table.isActive.asc().nullsLast().op("int4_ops"), table.priority.asc().nullsLast().op("bool_ops")),
	index("idx_promotions_code").using("btree", table.code.asc().nullsLast().op("text_ops")),
	index("idx_promotions_validity").using("btree", table.validFrom.asc().nullsLast().op("timestamptz_ops"), table.validUntil.asc().nullsLast().op("timestamptz_ops")),
	unique("promotions_code_unique").on(table.code),
]);

export const customers = pgTable("customers", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: text("user_id").notNull(),
	email: text(),
	phone: text(),
	firstName: text("first_name"),
	lastName: text("last_name"),
	metadata: jsonb().default({}),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	posOperatorPin: text("pos_operator_pin"),
}, (table) => [
	unique("customers_user_id_unique").on(table.userId),
	unique("customers_email_unique").on(table.email),
]);

export const priceModifiers = pgTable("price_modifiers", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	type: text().notNull(),
	value: integer().notNull(),
	priority: integer().default(100).notNull(),
	entityId: uuid("entity_id"),
	variantId: uuid("variant_id"),
	customerGroupId: text("customer_group_id"),
	currency: text(),
	minQuantity: integer("min_quantity"),
	maxQuantity: integer("max_quantity"),
	conditions: jsonb().default({}),
	validFrom: timestamp("valid_from", { withTimezone: true, mode: 'string' }),
	validUntil: timestamp("valid_until", { withTimezone: true, mode: 'string' }),
	metadata: jsonb().default({}),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_price_modifiers_entity_variant").using("btree", table.entityId.asc().nullsLast().op("uuid_ops"), table.variantId.asc().nullsLast().op("uuid_ops")),
	index("idx_price_modifiers_priority").using("btree", table.priority.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.entityId],
			foreignColumns: [sellableEntities.id],
			name: "price_modifiers_entity_id_sellable_entities_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.variantId],
			foreignColumns: [variants.id],
			name: "price_modifiers_variant_id_variants_id_fk"
		}).onDelete("cascade"),
]);

export const commerceAuditLog = pgTable("commerce_audit_log", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	entityType: text("entity_type").notNull(),
	entityId: text("entity_id").notNull(),
	event: text().notNull(),
	payload: jsonb().default({}).notNull(),
	actorId: text("actor_id"),
	actorType: text("actor_type"),
	requestId: text("request_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_audit_entity").using("btree", table.entityType.asc().nullsLast().op("text_ops"), table.entityId.asc().nullsLast().op("text_ops")),
]);

export const commerceJobs = pgTable("commerce_jobs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	queue: text().default('default').notNull(),
	taskSlug: text("task_slug").notNull(),
	input: jsonb().default({}).notNull(),
	output: jsonb(),
	status: text().default('pending').notNull(),
	attempts: integer().default(0).notNull(),
	maxAttempts: integer("max_attempts").default(1).notNull(),
	error: text(),
	waitUntil: timestamp("wait_until", { withTimezone: true, mode: 'string' }),
	concurrencyKey: text("concurrency_key"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	processingStartedAt: timestamp("processing_started_at", { withTimezone: true, mode: 'string' }),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
});

export const account = pgTable("account", {
	id: text().primaryKey().notNull(),
	accountId: text("account_id").notNull(),
	providerId: text("provider_id").notNull(),
	userId: text("user_id").notNull(),
	accessToken: text("access_token"),
	refreshToken: text("refresh_token"),
	idToken: text("id_token"),
	accessTokenExpiresAt: timestamp("access_token_expires_at", { mode: 'string' }),
	refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { mode: 'string' }),
	scope: text(),
	password: text(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "account_user_id_user_id_fk"
		}).onDelete("cascade"),
]);

export const entityCategories = pgTable("entity_categories", {
	entityId: uuid("entity_id").notNull(),
	categoryId: uuid("category_id").notNull(),
	sortOrder: integer("sort_order").default(0).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.entityId],
			foreignColumns: [sellableEntities.id],
			name: "entity_categories_entity_id_sellable_entities_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.categoryId],
			foreignColumns: [categories.id],
			name: "entity_categories_category_id_categories_id_fk"
		}).onDelete("cascade"),
]);

export const variantOptionValues = pgTable("variant_option_values", {
	variantId: uuid("variant_id").notNull(),
	optionValueId: uuid("option_value_id").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.variantId],
			foreignColumns: [variants.id],
			name: "variant_option_values_variant_id_variants_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.optionValueId],
			foreignColumns: [optionValues.id],
			name: "variant_option_values_option_value_id_option_values_id_fk"
		}).onDelete("cascade"),
]);

export const orderLineItems = pgTable("order_line_items", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orderId: uuid("order_id").notNull(),
	entityId: uuid("entity_id").notNull(),
	entityType: text("entity_type").notNull(),
	variantId: uuid("variant_id"),
	sku: text(),
	title: text().notNull(),
	quantity: integer().notNull(),
	unitPrice: integer("unit_price").notNull(),
	totalPrice: integer("total_price").notNull(),
	taxAmount: integer("tax_amount").default(0).notNull(),
	discountAmount: integer("discount_amount").default(0).notNull(),
	fulfillmentStatus: text("fulfillment_status").default('unfulfilled').notNull(),
	metadata: jsonb().default({}),
}, (table) => [
	foreignKey({
			columns: [table.orderId],
			foreignColumns: [orders.id],
			name: "order_line_items_order_id_orders_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.entityId],
			foreignColumns: [sellableEntities.id],
			name: "order_line_items_entity_id_sellable_entities_id_fk"
		}),
	foreignKey({
			columns: [table.variantId],
			foreignColumns: [variants.id],
			name: "order_line_items_variant_id_variants_id_fk"
		}),
]);

export const customerGroupMembers = pgTable("customer_group_members", {
	customerId: uuid("customer_id").notNull(),
	groupId: uuid("group_id").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.customerId],
			foreignColumns: [customers.id],
			name: "customer_group_members_customer_id_customers_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.groupId],
			foreignColumns: [customerGroups.id],
			name: "customer_group_members_group_id_customer_groups_id_fk"
		}).onDelete("cascade"),
]);

export const promotionUsages = pgTable("promotion_usages", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	promotionId: uuid("promotion_id").notNull(),
	customerId: text("customer_id"),
	orderId: text("order_id"),
	usedAt: timestamp("used_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_promotion_usage_customer").using("btree", table.customerId.asc().nullsLast().op("text_ops")),
	index("idx_promotion_usage_promotion").using("btree", table.promotionId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.promotionId],
			foreignColumns: [promotions.id],
			name: "promotion_usages_promotion_id_promotions_id_fk"
		}).onDelete("cascade"),
]);

export const fulfillmentRecords = pgTable("fulfillment_records", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orderId: uuid("order_id").notNull(),
	customerId: uuid("customer_id"),
	type: text().notNull(),
	status: text().default('pending').notNull(),
	carrier: text(),
	trackingNumber: text("tracking_number"),
	trackingUrl: text("tracking_url"),
	estimatedDelivery: timestamp("estimated_delivery", { withTimezone: true, mode: 'string' }),
	shippedAt: timestamp("shipped_at", { withTimezone: true, mode: 'string' }),
	deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: 'string' }),
	downloadUrl: text("download_url"),
	downloadExpiresAt: timestamp("download_expires_at", { withTimezone: true, mode: 'string' }),
	maxDownloads: integer("max_downloads"),
	downloadCount: integer("download_count").default(0).notNull(),
	entityType: text("entity_type"),
	entityId: uuid("entity_id"),
	grantedAt: timestamp("granted_at", { withTimezone: true, mode: 'string' }),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	isActive: boolean("is_active").default(true).notNull(),
	metadata: jsonb().default({}),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.orderId],
			foreignColumns: [orders.id],
			name: "fulfillment_records_order_id_orders_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.customerId],
			foreignColumns: [customers.id],
			name: "fulfillment_records_customer_id_customers_id_fk"
		}),
]);

export const fulfillmentEvents = pgTable("fulfillment_events", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	fulfillmentId: uuid("fulfillment_id").notNull(),
	eventType: text("event_type").notNull(),
	fromStatus: text("from_status"),
	toStatus: text("to_status"),
	description: text(),
	actorId: text("actor_id"),
	metadata: jsonb().default({}),
	occurredAt: timestamp("occurred_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.fulfillmentId],
			foreignColumns: [fulfillmentRecords.id],
			name: "fulfillment_events_fulfillment_id_fulfillment_records_id_fk"
		}).onDelete("cascade"),
]);

export const fulfillmentLineItems = pgTable("fulfillment_line_items", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	fulfillmentId: uuid("fulfillment_id").notNull(),
	orderLineItemId: uuid("order_line_item_id").notNull(),
	quantity: integer().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.fulfillmentId],
			foreignColumns: [fulfillmentRecords.id],
			name: "fulfillment_line_items_fulfillment_id_fulfillment_records_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.orderLineItemId],
			foreignColumns: [orderLineItems.id],
			name: "fulfillment_line_items_order_line_item_id_order_line_items_id_f"
		}).onDelete("cascade"),
]);

export const loyaltyPoints = pgTable("loyalty_points", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	customerId: uuid("customer_id").notNull(),
	points: integer().default(0).notNull(),
	tier: text().default('bronze').notNull(),
	lifetimeSpend: integer("lifetime_spend").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.customerId],
			foreignColumns: [customers.id],
			name: "loyalty_points_customer_id_customers_id_fk"
		}).onDelete("cascade"),
	unique("loyalty_points_customer_id_unique").on(table.customerId),
]);

export const loyaltyTransactions = pgTable("loyalty_transactions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	customerId: uuid("customer_id").notNull(),
	orderId: uuid("order_id"),
	type: text().notNull(),
	amount: integer().notNull(),
	description: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.customerId],
			foreignColumns: [customers.id],
			name: "loyalty_transactions_customer_id_customers_id_fk"
		}).onDelete("cascade"),
]);

export const reviews = pgTable("reviews", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	entityId: uuid("entity_id").notNull(),
	customerId: uuid("customer_id"),
	rating: integer().notNull(),
	title: text(),
	body: text(),
	status: text().default('pending').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.entityId],
			foreignColumns: [sellableEntities.id],
			name: "reviews_entity_id_sellable_entities_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.customerId],
			foreignColumns: [customers.id],
			name: "reviews_customer_id_customers_id_fk"
		}).onDelete("set null"),
]);
