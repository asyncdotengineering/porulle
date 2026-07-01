import type { CommerceConfig } from "../../config/types.js";
import type { TxContext } from "../../kernel/database/tx-context.js";
import type { CatalogRepository } from "../catalog/repository/index.js";

export interface ShippingAddress {
  country: string;
  postalCode: string;
  state?: string;
  city?: string;
  line1?: string;
}

export interface ShippingLineItem {
  entityId: string;
  variantId?: string;
  quantity: number;
  resolvedTotal: number;
}

export type ShippingStrategy =
  | {
      type: "flat";
      flatRate: number;
      freeShippingThreshold?: number;
    }
  | {
      type: "weight_based";
      brackets: Array<{ upToGrams: number; cost: number }>;
      fallbackCost: number;
      freeShippingThreshold?: number;
    };

export interface ShippingCalculationInput {
  lineItems: ShippingLineItem[];
  subtotalAfterDiscount: number;
  currency: string;
  address?: ShippingAddress;
  isFreeShipping: boolean;
}

async function resolveWeightGrams(
  catalogRepo: CatalogRepository,
  entityId: string,
  variantId: string | undefined,
  ctx?: TxContext,
): Promise<number> {
  if (variantId !== undefined) {
    const variant = await catalogRepo.findVariantById(variantId, ctx);
    const weightFromVariant = (
      variant?.metadata as Record<string, unknown> | null
    )?.weightGrams;
    if (
      typeof weightFromVariant === "number" &&
      Number.isFinite(weightFromVariant)
    ) {
      return Math.max(0, Math.round(weightFromVariant));
    }
  }

  const entity = await catalogRepo.findEntityById(entityId, ctx);
  const weightFromEntity = (entity?.metadata as Record<string, unknown> | null)
    ?.weightGrams;
  if (
    typeof weightFromEntity === "number" &&
    Number.isFinite(weightFromEntity)
  ) {
    return Math.max(0, Math.round(weightFromEntity));
  }

  return 0;
}

async function isShippableEntity(
  config: CommerceConfig,
  catalogRepo: CatalogRepository,
  entityId: string,
  ctx?: TxContext,
): Promise<boolean> {
  const entity = await catalogRepo.findEntityById(entityId, ctx);
  if (!entity) return false;
  const fulfillment = config.entities?.[entity.type]?.fulfillment;
  return (
    fulfillment === "physical" ||
    fulfillment === "internal-transfer" ||
    fulfillment === undefined
  );
}

function resolveStrategy(config: CommerceConfig): ShippingStrategy {
  const shipping = config.shipping;
  if (!shipping) {
    return {
      type: "flat",
      flatRate: 0,
    };
  }

  if (shipping.type === "weight_based") {
    return {
      type: "weight_based",
      brackets: [...shipping.brackets].sort(
        (a, b) => a.upToGrams - b.upToGrams,
      ),
      fallbackCost: shipping.fallbackCost,
      ...(shipping.freeShippingThreshold !== undefined
        ? { freeShippingThreshold: shipping.freeShippingThreshold }
        : {}),
    };
  }

  return {
    type: "flat",
    flatRate: shipping.flatRate,
    ...(shipping.freeShippingThreshold !== undefined
      ? { freeShippingThreshold: shipping.freeShippingThreshold }
      : {}),
  };
}

/**
 * Total weight (grams) of the shippable line items — used by both the
 * code-config strategy and runtime zone rates with weight bands.
 */
export async function computeShippableWeightGrams(
  config: CommerceConfig,
  catalogRepo: CatalogRepository,
  lineItems: ShippingLineItem[],
  ctx?: TxContext,
): Promise<number> {
  const flags = await Promise.all(
    lineItems.map((lineItem) =>
      isShippableEntity(config, catalogRepo, lineItem.entityId, ctx),
    ),
  );
  const shippable = lineItems.filter((_, i) => flags[i]);
  const weights = await Promise.all(
    shippable.map((lineItem) =>
      resolveWeightGrams(catalogRepo, lineItem.entityId, lineItem.variantId, ctx),
    ),
  );
  return shippable.reduce(
    (sum, lineItem, i) => sum + (weights[i] ?? 0) * lineItem.quantity,
    0,
  );
}

export async function calculateShippingCost(
  config: CommerceConfig,
  catalogRepo: CatalogRepository,
  input: ShippingCalculationInput,
  ctx?: TxContext,
): Promise<{ amount: number; strategy: string; weightGrams: number }> {
  if (input.isFreeShipping) {
    return { amount: 0, strategy: "promotion:free_shipping", weightGrams: 0 };
  }

  const strategy = resolveStrategy(config);
  if (
    strategy.freeShippingThreshold !== undefined &&
    input.subtotalAfterDiscount >= strategy.freeShippingThreshold
  ) {
    return { amount: 0, strategy: "threshold:free_shipping", weightGrams: 0 };
  }

  // Filter to shippable items
  const shippableFlags = await Promise.all(
    input.lineItems.map((lineItem) =>
      isShippableEntity(config, catalogRepo, lineItem.entityId, ctx),
    ),
  );
  const shippableItems = input.lineItems.filter((_, i) => shippableFlags[i]);

  if (shippableItems.length === 0) {
    return {
      amount: 0,
      strategy: `${strategy.type}:digital_only`,
      weightGrams: 0,
    };
  }

  // Calculate total weight
  const weights = await Promise.all(
    shippableItems.map((lineItem) =>
      resolveWeightGrams(
        catalogRepo,
        lineItem.entityId,
        lineItem.variantId,
        ctx,
      ),
    ),
  );
  const weightGrams = shippableItems.reduce(
    (sum, lineItem, i) => sum + (weights[i] ?? 0) * lineItem.quantity,
    0,
  );

  if (strategy.type === "flat") {
    return {
      amount: Math.max(0, Math.round(strategy.flatRate)),
      strategy: "flat",
      weightGrams,
    };
  }

  const matchedBracket = strategy.brackets.find(
    (bracket) => weightGrams <= bracket.upToGrams,
  );
  return {
    amount: matchedBracket
      ? Math.max(0, Math.round(matchedBracket.cost))
      : Math.max(0, Math.round(strategy.fallbackCost)),
    strategy: "weight_based",
    weightGrams,
  };
}
