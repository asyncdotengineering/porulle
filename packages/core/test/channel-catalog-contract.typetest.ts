import type {
  ChannelCatalogImage,
  ChannelCatalogItem,
  ChannelCatalogLocalizedAttributes,
  ChannelCatalogOptionType,
  ChannelCatalogPrice,
  ChannelCatalogVariant,
  ChannelPushCatalogField,
  ChannelPushCatalogImage,
  ChannelPushCatalogItem,
  ChannelPushCatalogItemOutcome,
  ChannelPushCatalogPreviousField,
  ChannelPushCatalogResult,
  ChannelPushCatalogVariant,
} from "../src/modules/channels/adapter.js";
import { sellableAttributes } from "../src/modules/catalog/schema.js";

type RequiredKeys<T extends object> = {
  [K in keyof T]-?: {} extends Pick<T, K> ? never : K;
}[keyof T];

type SellableAttributePayloadColumns = Exclude<
  keyof typeof sellableAttributes.$inferSelect,
  "id" | "entityId"
>;

type MissingLocalizedColumns = Exclude<
  SellableAttributePayloadColumns,
  keyof ChannelCatalogLocalizedAttributes
>;

type NewItemFields = Pick<
  ChannelCatalogItem,
  "attributes" | "images" | "options" | "tags" | "brand" | "categories" | "status"
>;

type NewVariantFields = Pick<ChannelCatalogVariant, "optionValues" | "prices">;

const localizedAttributesCoverSellableAttributeColumns: MissingLocalizedColumns extends never ? true : never = true;
const newItemFieldsAreOptional: RequiredKeys<NewItemFields> extends never ? true : never = true;
const newVariantFieldsAreOptional: RequiredKeys<NewVariantFields> extends never ? true : never = true;

const fullCatalogItem: ChannelCatalogItem = {
  externalId: "contract-product",
  slug: "contract-product",
  title: "Contract product",
  description: "Default locale description",
  attributes: [{
    locale: "en",
    title: "Contract product",
    subtitle: "Contract subtitle",
    description: "Localized description",
    richDescription: { blocks: [] },
    seoTitle: "Contract product | Porulle",
    seoDescription: "Contract SEO description",
  }],
  images: [{
    url: "https://example.test/product.jpg",
    alt: "Contract product",
    role: "primary",
    sortOrder: 0,
    variantExternalIds: ["contract-variant"],
  } satisfies ChannelCatalogImage],
  options: [{
    name: "color",
    displayName: "Color",
    sortOrder: 0,
    values: [{ value: "blue", displayValue: "Blue", sortOrder: 0 }],
  } satisfies ChannelCatalogOptionType],
  tags: ["contract"],
  brand: "Porulle",
  categories: ["products"],
  status: "active",
  variants: [{
    externalId: "contract-variant",
    sku: "CONTRACT-SKU",
    barcode: "0123456789012",
    optionValues: { color: "blue" },
    prices: [{ currency: "USD", amount: 2500 } satisfies ChannelCatalogPrice],
  }],
};

const legacyCatalogItem: ChannelCatalogItem = {
  externalId: "legacy-product",
  slug: "legacy-product",
  title: "Legacy product",
  variants: [{ externalId: "legacy-variant" }],
};

const pushCatalogItem: ChannelPushCatalogItem = {
  externalId: "push-contract-product",
  fields: [{
    fieldPath: "attributes.en.title",
    intent: "display",
    value: "Push contract product",
  } satisfies ChannelPushCatalogField],
  images: [{
    url: "https://example.test/push-contract-product.jpg",
    role: "primary",
  } satisfies ChannelPushCatalogImage],
};

const pushCatalogOutcome: ChannelPushCatalogItemOutcome = {
  externalId: pushCatalogItem.externalId,
  ok: true,
};
const pushCatalogResult: ChannelPushCatalogResult = { outcomes: [pushCatalogOutcome] };

// The import shape must stay structurally unable to express checkout state.
type CheckoutBoundaryKeys =
  | "quantity"
  | "stock"
  | "stockQuantity"
  | "inventory"
  | "inventoryQuantity"
  | "available"
  | "availableQuantity"
  | "fulfillmentStatus"
  | "orderId"
  | "customerId";
type BoundaryViolations = Extract<
  | keyof ChannelCatalogItem
  | keyof ChannelCatalogVariant
  | keyof ChannelCatalogImage
  | keyof ChannelCatalogPrice
  | keyof ChannelCatalogOptionType
  | keyof ChannelCatalogLocalizedAttributes,
  CheckoutBoundaryKeys
>;
type PushCatalogBoundaryViolations = Extract<
  | keyof ChannelPushCatalogField
  | keyof ChannelPushCatalogImage
  | keyof ChannelPushCatalogItem
  | keyof ChannelPushCatalogVariant
  | keyof ChannelPushCatalogPreviousField
  | keyof ChannelPushCatalogItemOutcome
  | keyof ChannelPushCatalogResult,
  CheckoutBoundaryKeys | "price" | "prices" | "amount" | "unitPrice" | "totalPrice"
>;
const checkoutBoundaryHolds: BoundaryViolations extends never ? true : never = true;
const pushCatalogBoundaryHolds: PushCatalogBoundaryViolations extends never ? true : never = true;

void localizedAttributesCoverSellableAttributeColumns;
void newItemFieldsAreOptional;
void newVariantFieldsAreOptional;
void fullCatalogItem;
void legacyCatalogItem;
void checkoutBoundaryHolds;
void pushCatalogItem;
void pushCatalogResult;
void pushCatalogBoundaryHolds;
