import { relations } from "drizzle-orm/relations";
import { organization, member, user, session, invitation, optionTypes, optionValues, sellableEntities, sellableAttributes, categories, entityBrands, brands, sellableCustomFields, inventoryLevels, variants, warehouses, entityMedia, mediaAssets, inventoryMovements, carts, cartLineItems, orders, orderStatusHistory, webhookEndpoints, webhookDeliveries, customers, customerAddresses, prices, priceModifiers, account, entityCategories, variantOptionValues, orderLineItems, customerGroupMembers, customerGroups, promotions, promotionUsages, fulfillmentRecords, fulfillmentEvents, fulfillmentLineItems, loyaltyPoints, loyaltyTransactions, reviews } from "./schema.js";

export const memberRelations = relations(member, ({one}) => ({
	organization: one(organization, {
		fields: [member.organizationId],
		references: [organization.id]
	}),
	user: one(user, {
		fields: [member.userId],
		references: [user.id]
	}),
}));

export const organizationRelations = relations(organization, ({many}) => ({
	members: many(member),
	invitations: many(invitation),
}));

export const userRelations = relations(user, ({many}) => ({
	members: many(member),
	sessions: many(session),
	invitations: many(invitation),
	accounts: many(account),
}));

export const sessionRelations = relations(session, ({one}) => ({
	user: one(user, {
		fields: [session.userId],
		references: [user.id]
	}),
}));

export const invitationRelations = relations(invitation, ({one}) => ({
	organization: one(organization, {
		fields: [invitation.organizationId],
		references: [organization.id]
	}),
	user: one(user, {
		fields: [invitation.inviterId],
		references: [user.id]
	}),
}));

export const optionValuesRelations = relations(optionValues, ({one, many}) => ({
	optionType: one(optionTypes, {
		fields: [optionValues.optionTypeId],
		references: [optionTypes.id]
	}),
	variantOptionValues: many(variantOptionValues),
}));

export const optionTypesRelations = relations(optionTypes, ({one, many}) => ({
	optionValues: many(optionValues),
	sellableEntity: one(sellableEntities, {
		fields: [optionTypes.entityId],
		references: [sellableEntities.id]
	}),
}));

export const sellableAttributesRelations = relations(sellableAttributes, ({one}) => ({
	sellableEntity: one(sellableEntities, {
		fields: [sellableAttributes.entityId],
		references: [sellableEntities.id]
	}),
}));

export const sellableEntitiesRelations = relations(sellableEntities, ({many}) => ({
	sellableAttributes: many(sellableAttributes),
	entityBrands: many(entityBrands),
	optionTypes: many(optionTypes),
	sellableCustomFields: many(sellableCustomFields),
	inventoryLevels: many(inventoryLevels),
	entityMedias: many(entityMedia),
	inventoryMovements: many(inventoryMovements),
	variants: many(variants),
	cartLineItems: many(cartLineItems),
	prices: many(prices),
	priceModifiers: many(priceModifiers),
	entityCategories: many(entityCategories),
	orderLineItems: many(orderLineItems),
	reviews: many(reviews),
}));

export const categoriesRelations = relations(categories, ({one, many}) => ({
	category: one(categories, {
		fields: [categories.parentId],
		references: [categories.id],
		relationName: "categories_parentId_categories_id"
	}),
	categories: many(categories, {
		relationName: "categories_parentId_categories_id"
	}),
	entityCategories: many(entityCategories),
}));

export const entityBrandsRelations = relations(entityBrands, ({one}) => ({
	sellableEntity: one(sellableEntities, {
		fields: [entityBrands.entityId],
		references: [sellableEntities.id]
	}),
	brand: one(brands, {
		fields: [entityBrands.brandId],
		references: [brands.id]
	}),
}));

export const brandsRelations = relations(brands, ({many}) => ({
	entityBrands: many(entityBrands),
}));

export const sellableCustomFieldsRelations = relations(sellableCustomFields, ({one}) => ({
	sellableEntity: one(sellableEntities, {
		fields: [sellableCustomFields.entityId],
		references: [sellableEntities.id]
	}),
}));

export const inventoryLevelsRelations = relations(inventoryLevels, ({one}) => ({
	sellableEntity: one(sellableEntities, {
		fields: [inventoryLevels.entityId],
		references: [sellableEntities.id]
	}),
	variant: one(variants, {
		fields: [inventoryLevels.variantId],
		references: [variants.id]
	}),
	warehouse: one(warehouses, {
		fields: [inventoryLevels.warehouseId],
		references: [warehouses.id]
	}),
}));

export const variantsRelations = relations(variants, ({one, many}) => ({
	inventoryLevels: many(inventoryLevels),
	entityMedias: many(entityMedia),
	inventoryMovements: many(inventoryMovements),
	sellableEntity: one(sellableEntities, {
		fields: [variants.entityId],
		references: [sellableEntities.id]
	}),
	cartLineItems: many(cartLineItems),
	prices: many(prices),
	priceModifiers: many(priceModifiers),
	variantOptionValues: many(variantOptionValues),
	orderLineItems: many(orderLineItems),
}));

export const warehousesRelations = relations(warehouses, ({many}) => ({
	inventoryLevels: many(inventoryLevels),
	inventoryMovements: many(inventoryMovements),
}));

export const entityMediaRelations = relations(entityMedia, ({one}) => ({
	sellableEntity: one(sellableEntities, {
		fields: [entityMedia.entityId],
		references: [sellableEntities.id]
	}),
	variant: one(variants, {
		fields: [entityMedia.variantId],
		references: [variants.id]
	}),
	mediaAsset: one(mediaAssets, {
		fields: [entityMedia.mediaAssetId],
		references: [mediaAssets.id]
	}),
}));

export const mediaAssetsRelations = relations(mediaAssets, ({many}) => ({
	entityMedias: many(entityMedia),
}));

export const inventoryMovementsRelations = relations(inventoryMovements, ({one}) => ({
	sellableEntity: one(sellableEntities, {
		fields: [inventoryMovements.entityId],
		references: [sellableEntities.id]
	}),
	variant: one(variants, {
		fields: [inventoryMovements.variantId],
		references: [variants.id]
	}),
	warehouse: one(warehouses, {
		fields: [inventoryMovements.warehouseId],
		references: [warehouses.id]
	}),
}));

export const cartLineItemsRelations = relations(cartLineItems, ({one}) => ({
	cart: one(carts, {
		fields: [cartLineItems.cartId],
		references: [carts.id]
	}),
	sellableEntity: one(sellableEntities, {
		fields: [cartLineItems.entityId],
		references: [sellableEntities.id]
	}),
	variant: one(variants, {
		fields: [cartLineItems.variantId],
		references: [variants.id]
	}),
}));

export const cartsRelations = relations(carts, ({many}) => ({
	cartLineItems: many(cartLineItems),
}));

export const orderStatusHistoryRelations = relations(orderStatusHistory, ({one}) => ({
	order: one(orders, {
		fields: [orderStatusHistory.orderId],
		references: [orders.id]
	}),
}));

export const ordersRelations = relations(orders, ({many}) => ({
	orderStatusHistories: many(orderStatusHistory),
	orderLineItems: many(orderLineItems),
	fulfillmentRecords: many(fulfillmentRecords),
}));

export const webhookDeliveriesRelations = relations(webhookDeliveries, ({one}) => ({
	webhookEndpoint: one(webhookEndpoints, {
		fields: [webhookDeliveries.endpointId],
		references: [webhookEndpoints.id]
	}),
}));

export const webhookEndpointsRelations = relations(webhookEndpoints, ({many}) => ({
	webhookDeliveries: many(webhookDeliveries),
}));

export const customerAddressesRelations = relations(customerAddresses, ({one}) => ({
	customer: one(customers, {
		fields: [customerAddresses.customerId],
		references: [customers.id]
	}),
}));

export const customersRelations = relations(customers, ({many}) => ({
	customerAddresses: many(customerAddresses),
	customerGroupMembers: many(customerGroupMembers),
	fulfillmentRecords: many(fulfillmentRecords),
	loyaltyPoints: many(loyaltyPoints),
	loyaltyTransactions: many(loyaltyTransactions),
	reviews: many(reviews),
}));

export const pricesRelations = relations(prices, ({one}) => ({
	sellableEntity: one(sellableEntities, {
		fields: [prices.entityId],
		references: [sellableEntities.id]
	}),
	variant: one(variants, {
		fields: [prices.variantId],
		references: [variants.id]
	}),
}));

export const priceModifiersRelations = relations(priceModifiers, ({one}) => ({
	sellableEntity: one(sellableEntities, {
		fields: [priceModifiers.entityId],
		references: [sellableEntities.id]
	}),
	variant: one(variants, {
		fields: [priceModifiers.variantId],
		references: [variants.id]
	}),
}));

export const accountRelations = relations(account, ({one}) => ({
	user: one(user, {
		fields: [account.userId],
		references: [user.id]
	}),
}));

export const entityCategoriesRelations = relations(entityCategories, ({one}) => ({
	sellableEntity: one(sellableEntities, {
		fields: [entityCategories.entityId],
		references: [sellableEntities.id]
	}),
	category: one(categories, {
		fields: [entityCategories.categoryId],
		references: [categories.id]
	}),
}));

export const variantOptionValuesRelations = relations(variantOptionValues, ({one}) => ({
	variant: one(variants, {
		fields: [variantOptionValues.variantId],
		references: [variants.id]
	}),
	optionValue: one(optionValues, {
		fields: [variantOptionValues.optionValueId],
		references: [optionValues.id]
	}),
}));

export const orderLineItemsRelations = relations(orderLineItems, ({one, many}) => ({
	order: one(orders, {
		fields: [orderLineItems.orderId],
		references: [orders.id]
	}),
	sellableEntity: one(sellableEntities, {
		fields: [orderLineItems.entityId],
		references: [sellableEntities.id]
	}),
	variant: one(variants, {
		fields: [orderLineItems.variantId],
		references: [variants.id]
	}),
	fulfillmentLineItems: many(fulfillmentLineItems),
}));

export const customerGroupMembersRelations = relations(customerGroupMembers, ({one}) => ({
	customer: one(customers, {
		fields: [customerGroupMembers.customerId],
		references: [customers.id]
	}),
	customerGroup: one(customerGroups, {
		fields: [customerGroupMembers.groupId],
		references: [customerGroups.id]
	}),
}));

export const customerGroupsRelations = relations(customerGroups, ({many}) => ({
	customerGroupMembers: many(customerGroupMembers),
}));

export const promotionUsagesRelations = relations(promotionUsages, ({one}) => ({
	promotion: one(promotions, {
		fields: [promotionUsages.promotionId],
		references: [promotions.id]
	}),
}));

export const promotionsRelations = relations(promotions, ({many}) => ({
	promotionUsages: many(promotionUsages),
}));

export const fulfillmentRecordsRelations = relations(fulfillmentRecords, ({one, many}) => ({
	order: one(orders, {
		fields: [fulfillmentRecords.orderId],
		references: [orders.id]
	}),
	customer: one(customers, {
		fields: [fulfillmentRecords.customerId],
		references: [customers.id]
	}),
	fulfillmentEvents: many(fulfillmentEvents),
	fulfillmentLineItems: many(fulfillmentLineItems),
}));

export const fulfillmentEventsRelations = relations(fulfillmentEvents, ({one}) => ({
	fulfillmentRecord: one(fulfillmentRecords, {
		fields: [fulfillmentEvents.fulfillmentId],
		references: [fulfillmentRecords.id]
	}),
}));

export const fulfillmentLineItemsRelations = relations(fulfillmentLineItems, ({one}) => ({
	fulfillmentRecord: one(fulfillmentRecords, {
		fields: [fulfillmentLineItems.fulfillmentId],
		references: [fulfillmentRecords.id]
	}),
	orderLineItem: one(orderLineItems, {
		fields: [fulfillmentLineItems.orderLineItemId],
		references: [orderLineItems.id]
	}),
}));

export const loyaltyPointsRelations = relations(loyaltyPoints, ({one}) => ({
	customer: one(customers, {
		fields: [loyaltyPoints.customerId],
		references: [customers.id]
	}),
}));

export const loyaltyTransactionsRelations = relations(loyaltyTransactions, ({one}) => ({
	customer: one(customers, {
		fields: [loyaltyTransactions.customerId],
		references: [customers.id]
	}),
}));

export const reviewsRelations = relations(reviews, ({one}) => ({
	sellableEntity: one(sellableEntities, {
		fields: [reviews.entityId],
		references: [sellableEntities.id]
	}),
	customer: one(customers, {
		fields: [reviews.customerId],
		references: [customers.id]
	}),
}));