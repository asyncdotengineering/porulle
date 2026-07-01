import { resolveOrgId } from "../../auth/org.js";
import type { Actor } from "../../auth/types.js";
import type { DatabaseAdapter } from "../../kernel/database/adapter.js";
import type { PluginDb } from "../../kernel/database/plugin-types.js";
import type { TxContext } from "../../kernel/database/tx-context.js";
import {
  CommerceNotFoundError,
  CommerceValidationError,
} from "../../kernel/errors.js";
import { runAfterHooks } from "../../kernel/hooks/executor.js";
import { createHookContext } from "../../kernel/hooks/create-context.js";
import type { HookRegistry } from "../../kernel/hooks/registry.js";
import type { AfterHook, HookContext } from "../../kernel/hooks/types.js";
import { Err, Ok, type Result } from "../../kernel/result.js";
import { createLogger } from "../../utils/logger.js";
import type {
  PricingRepository,
  Price,
  PriceModifier,
  PriceInsert,
  PriceModifierInsert,
} from "./repository/index.js";
import type { CatalogRepository } from "../catalog/repository/index.js";

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
  services: Record<string, unknown>;
  database: DatabaseAdapter;
}

function hookContext(
  actor: Actor | null,
  services: Record<string, unknown>,
  database: DatabaseAdapter,
  tx: unknown,
): HookContext {
  return createHookContext({
    actor,
    tx,
    logger: createLogger("pricing"),
    services,
    context: { moduleName: "pricing" },
    database: { db: database.db as PluginDb },
  });
}

export interface PriceResolutionContext {
  entityId: string;
  variantId?: string;
  currency: string;
  quantity: number;
  customerId?: string;
  customerGroupIds?: string[];
  timestamp?: Date;
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

function matchesQuantity(
  min: number | null | undefined,
  max: number | null | undefined,
  quantity: number,
): boolean {
  if (min != null && quantity < min) return false;
  if (max != null && quantity > max) return false;
  return true;
}

function matchesWindow(
  validFrom: Date | null | undefined,
  validUntil: Date | null | undefined,
  timestamp: Date,
): boolean {
  if (validFrom && timestamp < validFrom) return false;
  if (validUntil && timestamp > validUntil) return false;
  return true;
}

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
  a: Price,
  b: Price,
  context: PriceResolutionContext,
): number {
  const aVariant =
    context.variantId !== undefined && a.variantId === context.variantId
      ? 1
      : 0;
  const bVariant =
    context.variantId !== undefined && b.variantId === context.variantId
      ? 1
      : 0;
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

function toGroupSet(context: PriceResolutionContext): Set<string> {
  return new Set(context.customerGroupIds ?? []);
}

function normalizeCurrency(currency: string): string {
  return currency.trim().toUpperCase();
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

    const entity = await this.catalogRepo.findEntityById(input.entityId, ctx);
    if (!entity) {
      return Err(
        new CommerceNotFoundError("Entity not found for price assignment."),
      );
    }

    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);

    const priceData: PriceInsert = {
      organizationId: orgId,
      entityId: input.entityId,
      currency: normalizeCurrency(input.currency),
      amount: input.amount,
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
          { amount: priceData.amount, metadata: priceData.metadata },
          ctx,
        )) ?? existing
      : await this.repo.createPrice(priceData, ctx);

    const afterHooks = this.deps.hooks.resolve(
      "pricing.afterCreate",
    ) as AfterHook<Price>[];
    const hctx = hookContext(
      actor ?? ctx?.actor ?? null,
      this.deps.services,
      this.deps.database,
      ctx?.tx ?? null,
    );
    await runAfterHooks(afterHooks, null, record, "create", hctx);

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

    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);

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
    const hctx = hookContext(
      actor ?? ctx?.actor ?? null,
      this.deps.services,
      this.deps.database,
      ctx?.tx ?? null,
    );
    await runAfterHooks(afterHooks, null, modifier, "create", hctx);

    return Ok(modifier);
  }

  async listModifiers(
    filter?: { entityId?: string; active?: boolean; currency?: string },
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<PriceModifier[]>> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
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
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
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
    return Ok(updated!);
  }

  async deleteModifier(
    id: string,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<{ deleted: true }>> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const existing = await this.repo.findModifierById(orgId, id, ctx);
    if (!existing) {
      return Err(new CommerceNotFoundError("Price modifier not found."));
    }
    await this.repo.deleteModifier(id, ctx);
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
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
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

  async resolve(
    input: PriceResolutionContext,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<ResolvedPrice>> {
    const entity = await this.catalogRepo.findEntityById(input.entityId, ctx);
    if (!entity) {
      return Err(
        new CommerceNotFoundError(`Entity ${input.entityId} not found.`),
      );
    }

    if (input.quantity <= 0) {
      return Err(
        new CommerceValidationError(
          "Quantity must be greater than zero for price resolution.",
        ),
      );
    }

    const timestamp = input.timestamp ?? new Date();
    const currency = normalizeCurrency(input.currency);
    const groupSet = toGroupSet(input);

    // Get matching prices from repository
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const allPrices = await this.repo.findPricesByEntityId(
      orgId,
      input.entityId,
      ctx,
    );

    const matchingPrices = allPrices.filter((price) => {
      if (input.variantId !== undefined) {
        if (price.variantId !== null && price.variantId !== input.variantId)
          return false;
      } else if (price.variantId !== null) {
        return false;
      }
      if (price.currency !== currency) return false;
      if (
        !matchesQuantity(price.minQuantity, price.maxQuantity, input.quantity)
      )
        return false;
      if (!matchesWindow(price.validFrom, price.validUntil, timestamp))
        return false;
      if (
        price.customerGroupId !== null &&
        !groupSet.has(price.customerGroupId)
      )
        return false;
      return true;
    });

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
      const fallback: ResolvedPrice = {
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
      };
      return Ok(fallback);
    }

    const selectedBase = [...matchingPrices].sort((a, b) =>
      compareBasePriceSpecificity(a, b, input),
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

    // Get matching modifiers (includes both entity-specific and global)
    const firstGroupId = groupSet.size > 0 ? [...groupSet][0] : undefined;
    const activeModifiers = await this.repo.findActiveModifiers(
      orgId,
      input.entityId,
      input.variantId,
      firstGroupId,
      currency,
      input.quantity,
      ctx,
    );

    // Additional filtering for multiple customer groups and conditions
    const modifiers = activeModifiers
      .filter((modifier) => {
        // Re-check customer group for multi-group support
        if (
          modifier.customerGroupId !== null &&
          !groupSet.has(modifier.customerGroupId)
        )
          return false;

        const conditions = modifier.conditions as Record<
          string,
          unknown
        > | null;
        const minSubtotal = conditions?.minSubtotal;
        if (typeof minSubtotal === "number" && runningAmount < minSubtotal)
          return false;

        return true;
      })
      .sort((a, b) => a.priority - b.priority);

    for (const modifier of modifiers) {
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
}
