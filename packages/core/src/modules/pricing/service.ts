import { resolveOrgIdForCommerce } from "../../auth/org.js";
import type { Actor } from "../../auth/types.js";
import type { CommerceConfig } from "../../config/types.js";
import type { DatabaseAdapter } from "../../kernel/database/adapter.js";
import type { TxContext } from "../../kernel/database/tx-context.js";
import {
  CommerceNotFoundError,
  CommerceValidationError,
} from "../../kernel/errors.js";
import { runAfterHooks } from "../../kernel/hooks/executor.js";
import { createModuleHookContext } from "../../kernel/hooks/create-context.js";
import type { HookRegistry } from "../../kernel/hooks/registry.js";
import type { AfterHook } from "../../kernel/hooks/types.js";
import { Err, Ok, type Result } from "../../kernel/result.js";
import type {
  PricingRepository,
  Price,
  PriceModifier,
  PriceInsert,
  PriceModifierInsert,
  ResolvablePrice,
  ResolvableModifier,
} from "./repository/index.js";
import type { CatalogRepository, SellableEntity } from "../catalog/repository/index.js";

// Re-export PriceModifierType from schema for external use
export type PriceModifierType =
  | "percentage_discount"
  | "fixed_discount"
  | "markup"
  | "override";

interface PricingServiceDeps {
  repository: PricingRepository;
  catalogRepository: CatalogRepository;
  hooks: HookRegistry;
  config: CommerceConfig;
  services: Record<string, unknown>;
  database: DatabaseAdapter;
}


export interface PriceResolutionContext {
  entityId: string;
  variantId?: string;
  currency: string;
  quantity: number;
  customerGroupIds?: string[];
  timestamp?: Date;
}

/** Prices many (entity, variant) pairs at once; `variantIds: [null]` asks for the product-level price. */
export interface ResolveManyInput {
  items: Array<{ entityId: string; variantIds: Array<string | null> }>;
  currency: string;
  quantity: number;
  customerGroupIds?: string[];
  timestamp?: Date;
  /** Entities the caller already loaded; skips the entity read. Other organizations' entities are ignored. */
  entities?: ReadonlyMap<string, SellableEntity>;
}

export interface ResolvedPriceItem {
  entityId: string;
  variantId: string | null;
  price: Result<ResolvedPrice>;
}

export interface PriceBreakdownStep {
  label: string;
  amountBefore: number;
  delta: number;
  amountAfter: number;
  metadata?: Record<string, unknown>;
}

export interface ResolvedPrice {
  baseAmount: number;
  finalAmount: number;
  currency: string;
  appliedModifiers: Array<{
    id: string;
    name: string;
    type: PriceModifierType;
    delta: number;
    value: number;
    priority: number;
  }>;
  breakdown: PriceBreakdownStep[];
  basePriceId: string;
}

export type { SetBasePriceInput, CreatePriceModifierInput } from "./schemas.js";
import type { SetBasePriceInput, CreatePriceModifierInput } from "./schemas.js";
import { normalizeCurrency } from "../../utils/money.js";

function durationScore(
  validFrom: Date | null | undefined,
  validUntil: Date | null | undefined,
): number {
  if (validFrom && validUntil)
    return validUntil.getTime() - validFrom.getTime();
  if (validFrom || validUntil) return Number.MAX_SAFE_INTEGER - 1;
  return Number.MAX_SAFE_INTEGER;
}

function quantityRangeWidth(
  min: number | null | undefined,
  max: number | null | undefined,
): number {
  if (min != null && max != null) return Math.max(0, max - min);
  if (min != null || max != null) return Number.MAX_SAFE_INTEGER - 1;
  return Number.MAX_SAFE_INTEGER;
}

function sameNaturalKeyDate(a: Date | null | undefined, b: Date | null | undefined): boolean {
  if (a == null || b == null) return (a ?? null) === (b ?? null);
  return a.getTime() === b.getTime();
}

function compareBasePriceSpecificity(
  a: ResolvablePrice,
  b: ResolvablePrice,
  variantId: string | null,
): number {
  const aVariant = variantId !== null && a.variantId === variantId ? 1 : 0;
  const bVariant = variantId !== null && b.variantId === variantId ? 1 : 0;
  if (aVariant !== bVariant) return bVariant - aVariant;

  const hasGroupA = a.customerGroupId ? 1 : 0;
  const hasGroupB = b.customerGroupId ? 1 : 0;
  if (hasGroupA !== hasGroupB) return hasGroupB - hasGroupA;

  const aRange = quantityRangeWidth(a.minQuantity, a.maxQuantity);
  const bRange = quantityRangeWidth(b.minQuantity, b.maxQuantity);
  if (aRange !== bRange) return aRange - bRange;

  const aDuration = durationScore(a.validFrom, a.validUntil);
  const bDuration = durationScore(b.validFrom, b.validUntil);
  if (aDuration !== bDuration) return aDuration - bDuration;

  return b.createdAt.getTime() - a.createdAt.getTime();
}

function resolveModifierDelta(
  type: PriceModifierType,
  value: number,
  amountBefore: number,
): number {
  switch (type) {
    case "percentage_discount":
      return -Math.round((amountBefore * value) / 100);
    case "fixed_discount":
      return -value;
    case "markup":
      return value;
    case "override":
      return value - amountBefore;
    default:
      return 0;
  }
}

/**
 * Picks the price for ONE (entity, variant) pair from rows already filtered in SQL by organization,
 * currency, quantity window, validity window and customer group (see `findResolvablePrices` /
 * `findResolvableModifiers`). This is the only implementation of the selection rules.
 */
function resolvePair(
  entityId: string,
  variantId: string | null,
  entity: PricedEntity | undefined,
  input: { currency: string; quantity: number },
  prices: ResolvablePrice[],
  modifiers: ResolvableModifier[],
): Result<ResolvedPrice> {
  if (!entity) {
    return Err(new CommerceNotFoundError(`Entity ${entityId} not found.`));
  }
  if (input.quantity <= 0) {
    return Err(
      new CommerceValidationError(
        "Quantity must be greater than zero for price resolution.",
      ),
    );
  }
  const { currency } = input;

  const matchingPrices = prices.filter(
    (price) =>
      price.entityId === entityId &&
      (price.variantId === null || (variantId !== null && price.variantId === variantId)),
  );

  if (matchingPrices.length === 0) {
    const metadataPrice =
      typeof entity.metadata?.basePrice === "number"
        ? Math.round(entity.metadata.basePrice)
        : undefined;
    if (metadataPrice === undefined) {
      return Err(
        new CommerceNotFoundError(
          `No base price configured for ${entity.slug} (${currency}).`,
        ),
      );
    }
    return Ok({
      baseAmount: metadataPrice,
      finalAmount: metadataPrice,
      currency,
      basePriceId: "metadata:basePrice",
      appliedModifiers: [],
      breakdown: [
        {
          label: "Base price (entity metadata)",
          amountBefore: metadataPrice,
          delta: 0,
          amountAfter: metadataPrice,
        },
      ],
    });
  }

  const selectedBase = [...matchingPrices].sort((a, b) =>
    compareBasePriceSpecificity(a, b, variantId),
  )[0];
  if (!selectedBase) {
    return Err(
      new CommerceNotFoundError("No matching base price could be selected."),
    );
  }

  let runningAmount = selectedBase.amount;
  const breakdown: PriceBreakdownStep[] = [
    {
      label: "Base price",
      amountBefore: selectedBase.amount,
      delta: 0,
      amountAfter: selectedBase.amount,
      metadata: {
        priceId: selectedBase.id,
        customerGroupId: selectedBase.customerGroupId,
        minQuantity: selectedBase.minQuantity,
        maxQuantity: selectedBase.maxQuantity,
      },
    },
  ];

  const appliedModifiers: ResolvedPrice["appliedModifiers"] = [];

  const applicable = modifiers
    .filter((modifier) => {
      if (modifier.entityId !== null && modifier.entityId !== entityId) return false;
      if (modifier.variantId !== null && modifier.variantId !== variantId) return false;
      const conditions = modifier.conditions as Record<string, unknown> | null;
      const minSubtotal = conditions?.minSubtotal;
      if (typeof minSubtotal === "number" && runningAmount < minSubtotal)
        return false;
      return true;
    })
    .sort((a, b) => a.priority - b.priority);

  for (const modifier of applicable) {
    const amountBefore = runningAmount;
    const rawDelta = resolveModifierDelta(
      modifier.type as PriceModifierType,
      modifier.value,
      amountBefore,
    );
    const delta = Math.max(-amountBefore, rawDelta);
    runningAmount = Math.max(0, amountBefore + delta);

    appliedModifiers.push({
      id: modifier.id,
      name: modifier.name,
      type: modifier.type as PriceModifierType,
      delta,
      value: modifier.value,
      priority: modifier.priority,
    });

    breakdown.push({
      label: `Modifier: ${modifier.name}`,
      amountBefore,
      delta,
      amountAfter: runningAmount,
      metadata: {
        type: modifier.type,
        priority: modifier.priority,
      },
    });
  }

  return Ok({
    baseAmount: selectedBase.amount,
    finalAmount: runningAmount,
    currency,
    basePriceId: selectedBase.id,
    appliedModifiers,
    breakdown,
  });
}

/** What price selection reads off the entity: its slug (for the error) and its `metadata.basePrice` fallback. */
export type PricedEntity = Pick<SellableEntity, "slug" | "metadata">;

/** When and for whom a pair is priced. Modifiers are matched to the FIRST customer group only (the resolver's rule). */
export interface PriceSelectionInput {
  currency: string;
  quantity: number;
  customerGroupIds?: readonly string[];
  /** The moment base prices must be valid at. */
  at: Date;
  /** The moment modifiers must be valid at; defaults to `at`. `resolveMany` passes the wall clock here. */
  modifiersAt?: Date;
}

function withinBounds(min: number | null, max: number | null, quantity: number): boolean {
  return (min === null || min <= quantity) && (max === null || max >= quantity);
}

function validAt(from: Date | null, until: Date | null, at: Date): boolean {
  return (from === null || from.getTime() <= at.getTime()) && (until === null || until.getTime() >= at.getTime());
}

/**
 * The price of ONE (entity, variant) pair from candidate rows (`findPriceCandidates`, or rows `resolveMany` already
 * narrowed in SQL): keeps the rows in their quantity bounds, valid at the moment and for the customer groups, then applies
 * the selection rules. Pure, so a caller that stored the candidates can price them at read time; the only implementation
 * of the rules, which `resolveMany` uses too.
 */
export function resolvePriceAt(
  entityId: string,
  variantId: string | null,
  entity: PricedEntity | undefined,
  input: PriceSelectionInput,
  prices: readonly ResolvablePrice[],
  modifiers: readonly ResolvableModifier[],
): Result<ResolvedPrice> {
  const groups = input.customerGroupIds ?? [];
  const modifierGroup = groups[0];
  const modifiersAt = input.modifiersAt ?? input.at;
  const livePrices = prices.filter(
    (price) =>
      withinBounds(price.minQuantity, price.maxQuantity, input.quantity) &&
      validAt(price.validFrom, price.validUntil, input.at) &&
      (price.customerGroupId === null || groups.includes(price.customerGroupId)),
  );
  const liveModifiers = modifiers.filter(
    (modifier) =>
      withinBounds(modifier.minQuantity, modifier.maxQuantity, input.quantity) &&
      validAt(modifier.validFrom, modifier.validUntil, modifiersAt) &&
      (modifier.customerGroupId === null || modifier.customerGroupId === modifierGroup),
  );
  return resolvePair(entityId, variantId, entity, input, livePrices, liveModifiers);
}

export class PricingService {
  private readonly repo: PricingRepository;
  private readonly catalogRepo: CatalogRepository;

  constructor(private deps: PricingServiceDeps) {
    this.repo = deps.repository;
    this.catalogRepo = deps.catalogRepository;
  }

  async setBasePrice(
    input: SetBasePriceInput,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<Price>> {
    if (input.amount < 0) {
      return Err(
        new CommerceValidationError("Base price amount cannot be negative."),
      );
    }

    const orgId = resolveOrgIdForCommerce(actor ?? ctx?.actor ?? null, this.deps.config);
    const entity = await this.catalogRepo.findEntityById(input.entityId, ctx, orgId);
    if (!entity) {
      return Err(
        new CommerceNotFoundError("Entity not found for price assignment."),
      );
    }

    const priceData: PriceInsert = {
      organizationId: orgId,
      entityId: input.entityId,
      currency: normalizeCurrency(input.currency),
      amount: input.amount,
      ...(input.compareAtAmount !== undefined ? { compareAtAmount: input.compareAtAmount } : {}),
      metadata: input.metadata ?? {},
      variantId: input.variantId ?? null,
      customerGroupId: input.customerGroupId ?? null,
      minQuantity: input.minQuantity ?? null,
      maxQuantity: input.maxQuantity ?? null,
      validFrom: input.validFrom ?? null,
      validUntil: input.validUntil ?? null,
    };

    // Upsert on the natural key. "Set base price" is idempotent per
    // (org, entity, variant, currency, customerGroup, qty range, validity):
    // a repeat call replaces the existing row's amount instead of appending a
    // shadow row that the resolver would then tie-break on createdAt.
    const existing = (
      await this.repo.findPricesByEntityId(orgId, input.entityId, ctx)
    ).find(
      (p) =>
        p.currency === priceData.currency &&
        p.variantId === (priceData.variantId ?? null) &&
        p.customerGroupId === (priceData.customerGroupId ?? null) &&
        p.minQuantity === (priceData.minQuantity ?? null) &&
        p.maxQuantity === (priceData.maxQuantity ?? null) &&
        sameNaturalKeyDate(p.validFrom, priceData.validFrom ?? null) &&
        sameNaturalKeyDate(p.validUntil, priceData.validUntil ?? null),
    );

    const record = existing
      ? (await this.repo.updatePrice(
        existing.id,
          {
            amount: priceData.amount,
            ...(priceData.compareAtAmount !== undefined ? { compareAtAmount: priceData.compareAtAmount } : {}),
            metadata: priceData.metadata,
          },
          ctx,
        )) ?? existing
      : await this.repo.createPrice(priceData, ctx);

    const afterHooks = this.deps.hooks.resolve(
      "pricing.afterCreate",
    ) as AfterHook<Price>[];
    const hctx = createModuleHookContext("pricing", this.deps, actor ?? ctx?.actor ?? null, ctx?.tx ?? null);
    await runAfterHooks(afterHooks, null, record, "create", hctx, (hook) => this.deps.hooks.runsInTransaction(hook));

    return Ok(record);
  }

  async createModifier(
    input: CreatePriceModifierInput,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<PriceModifier>> {
    if (!input.name) {
      return Err(new CommerceValidationError("Modifier name is required."));
    }

    // Validate modifier type
    const validTypes: PriceModifierType[] = [
      "percentage_discount",
      "fixed_discount",
      "markup",
      "override",
    ];
    if (!validTypes.includes(input.type)) {
      return Err(
        new CommerceValidationError(
          `Invalid modifier type "${input.type}". Must be one of: ${validTypes.join(", ")}`,
        ),
      );
    }

    const orgId = resolveOrgIdForCommerce(actor ?? ctx?.actor ?? null, this.deps.config);

    const modifierData: PriceModifierInsert = {
      organizationId: orgId,
      name: input.name,
      type: input.type,
      value: input.value,
      priority: input.priority ?? 100,
      conditions: input.conditions ?? {},
      metadata: input.metadata ?? {},
      entityId: input.entityId ?? null,
      variantId: input.variantId ?? null,
      customerGroupId: input.customerGroupId ?? null,
      currency: input.currency ? normalizeCurrency(input.currency) : null,
      minQuantity: input.minQuantity ?? null,
      maxQuantity: input.maxQuantity ?? null,
      validFrom: input.validFrom ?? null,
      validUntil: input.validUntil ?? null,
    };

    const modifier = await this.repo.createModifier(modifierData, ctx);

    const afterHooks = this.deps.hooks.resolve(
      "pricing.afterCreate",
    ) as AfterHook<PriceModifier>[];
    const hctx = createModuleHookContext("pricing", this.deps, actor ?? ctx?.actor ?? null, ctx?.tx ?? null);
    await runAfterHooks(afterHooks, null, modifier, "create", hctx, (hook) => this.deps.hooks.runsInTransaction(hook));

    return Ok(modifier);
  }

  async listModifiers(
    filter?: { entityId?: string; active?: boolean; currency?: string },
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<PriceModifier[]>> {
    const orgId = resolveOrgIdForCommerce(actor ?? ctx?.actor ?? null, this.deps.config);
    const rows = await this.repo.findModifiers(
      orgId,
      {
        ...(filter?.entityId !== undefined ? { entityId: filter.entityId } : {}),
        ...(filter?.currency !== undefined
          ? { currency: normalizeCurrency(filter.currency) }
          : {}),
        ...(filter?.active ? { activeAt: new Date() } : {}),
      },
      ctx,
    );
    return Ok(rows);
  }

  async updateModifier(
    id: string,
    patch: {
      name?: string | undefined;
      value?: number | undefined;
      priority?: number | undefined;
      validFrom?: Date | null | undefined;
      validUntil?: Date | null | undefined;
      minQuantity?: number | null | undefined;
      maxQuantity?: number | null | undefined;
      metadata?: Record<string, unknown> | undefined;
    },
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<PriceModifier>> {
    const orgId = resolveOrgIdForCommerce(actor ?? ctx?.actor ?? null, this.deps.config);
    const existing = await this.repo.findModifierById(orgId, id, ctx);
    if (!existing) {
      return Err(new CommerceNotFoundError("Price modifier not found."));
    }
    const updated = await this.repo.updateModifier(
      id,
      {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.value !== undefined ? { value: patch.value } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.validFrom !== undefined ? { validFrom: patch.validFrom } : {}),
        ...(patch.validUntil !== undefined ? { validUntil: patch.validUntil } : {}),
        ...(patch.minQuantity !== undefined ? { minQuantity: patch.minQuantity } : {}),
        ...(patch.maxQuantity !== undefined ? { maxQuantity: patch.maxQuantity } : {}),
        ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
      },
      ctx,
    );

    const afterHooks = this.deps.hooks.resolve(
      "pricing.afterUpdate",
    ) as AfterHook<PriceModifier>[];
    const hctx = createModuleHookContext("pricing", this.deps, actor ?? ctx?.actor ?? null, ctx?.tx ?? null);
    await runAfterHooks(afterHooks, existing, updated!, "update", hctx, (hook) => this.deps.hooks.runsInTransaction(hook));

    return Ok(updated!);
  }

  async deleteModifier(
    id: string,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<{ deleted: true }>> {
    const orgId = resolveOrgIdForCommerce(actor ?? ctx?.actor ?? null, this.deps.config);
    const existing = await this.repo.findModifierById(orgId, id, ctx);
    if (!existing) {
      return Err(new CommerceNotFoundError("Price modifier not found."));
    }
    await this.repo.deleteModifier(id, ctx);

    const afterHooks = this.deps.hooks.resolve(
      "pricing.afterDelete",
    ) as AfterHook<PriceModifier>[];
    const hctx = createModuleHookContext("pricing", this.deps, actor ?? ctx?.actor ?? null, ctx?.tx ?? null);
    await runAfterHooks(afterHooks, existing, existing, "delete", hctx, (hook) => this.deps.hooks.runsInTransaction(hook));

    return Ok({ deleted: true });
  }

  async listPrices(
    filter?: {
      entityId?: string;
      variantId?: string;
      currency?: string;
      customerGroupId?: string;
    },
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<{ prices: Price[]; modifiers: PriceModifier[] }>> {
    const orgId = resolveOrgIdForCommerce(actor ?? ctx?.actor ?? null, this.deps.config);
    // Get all prices for the entity if specified, or filter after retrieval
    let prices: Price[] = [];
    if (filter?.entityId) {
      prices = await this.repo.findPricesByEntityId(orgId, filter.entityId, ctx);
    }
    // Note: For full list without entityId, we'd need a findAll method
    // For now, entityId is typically required for practical use

    // Apply additional filters
    if (filter?.variantId !== undefined) {
      prices = prices.filter((p) => p.variantId === filter.variantId);
    }
    if (filter?.currency !== undefined) {
      const normalizedCurrency = normalizeCurrency(filter.currency);
      prices = prices.filter((p) => p.currency === normalizedCurrency);
    }
    if (filter?.customerGroupId !== undefined) {
      prices = prices.filter(
        (p) => p.customerGroupId === filter.customerGroupId,
      );
    }

    // Get modifiers for the entity
    let modifiers: PriceModifier[] = [];
    if (filter?.entityId) {
      modifiers = await this.repo.findModifiersByEntityId(
        orgId,
        filter.entityId,
        ctx,
      );
    }

    // Apply additional filters
    if (filter?.variantId !== undefined) {
      modifiers = modifiers.filter((m) => m.variantId === filter.variantId);
    }
    if (filter?.currency !== undefined) {
      const normalizedCurrency = normalizeCurrency(filter.currency);
      modifiers = modifiers.filter(
        (m) => m.currency === null || m.currency === normalizedCurrency,
      );
    }
    if (filter?.customerGroupId !== undefined) {
      modifiers = modifiers.filter(
        (m) =>
          m.customerGroupId === null ||
          m.customerGroupId === filter.customerGroupId,
      );
    }

    return Ok({ prices, modifiers });
  }

  /**
   * Every price row and modifier that can ever apply to `entityIds` in `currency`, windows and bounds unfiltered — what a
   * caller stores to price later with `resolvePriceAt`. Two reads whatever the number of products.
   */
  async priceCandidates(
    input: { entityIds: string[]; currency: string; customerGroupIds?: string[] },
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<{ prices: ResolvablePrice[]; modifiers: ResolvableModifier[] }>> {
    const orgId = resolveOrgIdForCommerce(actor ?? ctx?.actor ?? null, this.deps.config);
    return Ok(
      await this.repo.findPriceCandidates(
        orgId,
        {
          entityIds: [...new Set(input.entityIds)],
          currency: normalizeCurrency(input.currency),
          customerGroupIds: [...new Set(input.customerGroupIds ?? [])],
        },
        ctx,
      ),
    );
  }

  /** One pair through `resolveMany`: there is a single pricing path. */
  async resolve(
    input: PriceResolutionContext,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<ResolvedPrice>> {
    const result = await this.resolveMany(
      {
        items: [{ entityId: input.entityId, variantIds: [input.variantId ?? null] }],
        currency: input.currency,
        quantity: input.quantity,
        ...(input.customerGroupIds !== undefined ? { customerGroupIds: input.customerGroupIds } : {}),
        ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
      },
      actor ?? null,
      ctx,
    );
    if (!result.ok) return result;
    return result.value[0]!.price;
  }

  /**
   * Prices every (entity, variant) pair in `input.items` with at most three reads whatever their
   * number: the entities (skipped when `input.entities` is given), the candidate prices and the
   * candidate modifiers. A pair with no price gets its own error; the batch never fails for it.
   */
  async resolveMany(
    input: ResolveManyInput,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<ResolvedPriceItem[]>> {
    const orgId = resolveOrgIdForCommerce(actor ?? ctx?.actor ?? null, this.deps.config);
    const pairs = input.items.flatMap((item) =>
      item.variantIds.map((variantId) => ({ entityId: item.entityId, variantId })),
    );
    if (pairs.length === 0) return Ok([]);

    const requestedIds = [...new Set(pairs.map((p) => p.entityId))];
    const entities = new Map<string, SellableEntity>();
    if (input.entities) {
      // A caller-supplied entity counts only inside the caller's organization.
      for (const id of requestedIds) {
        const entity = input.entities.get(id);
        if (entity && entity.organizationId === orgId) entities.set(id, entity);
      }
    } else {
      for (const entity of await this.catalogRepo.findEntitiesByIds(requestedIds, orgId, ctx)) {
        entities.set(entity.id, entity);
      }
    }

    const timestamp = input.timestamp ?? new Date();
    const currency = normalizeCurrency(input.currency);
    const groupIds = [...new Set(input.customerGroupIds ?? [])];
    const entityIds = input.quantity > 0 ? requestedIds.filter((id) => entities.has(id)) : [];
    const variantIds = [
      ...new Set(
        pairs
          .filter((p) => entities.has(p.entityId))
          .flatMap((p) => (p.variantId === null ? [] : [p.variantId])),
      ),
    ];

    // Read once, so the SQL filter and the in-memory one see the same moment.
    const modifiersAt = new Date();
    const [prices, modifiers] = await Promise.all([
      this.repo.findResolvablePrices(
        orgId,
        { entityIds, variantIds, currency, quantity: input.quantity, customerGroupIds: groupIds, at: timestamp },
        ctx,
      ),
      // Modifiers match the FIRST customer group only and are active at the wall clock, not at
      // `timestamp`: both are the resolver's rules as they stand.
      this.repo.findResolvableModifiers(
        orgId,
        { entityIds, variantIds, currency, quantity: input.quantity, customerGroupId: groupIds[0], at: modifiersAt },
        ctx,
      ),
    ]);

    return Ok(
      pairs.map(({ entityId, variantId }) => ({
        entityId,
        variantId,
        price: resolvePriceAt(
          entityId,
          variantId,
          entities.get(entityId),
          { currency, quantity: input.quantity, customerGroupIds: groupIds, at: timestamp, modifiersAt },
          prices,
          modifiers,
        ),
      })),
    );
  }
}
