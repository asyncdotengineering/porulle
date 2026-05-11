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
  PromotionsRepository,
  Promotion,
  PromotionUsage,
} from "./repository/index.js";
import type { CatalogRepository } from "../catalog/repository/index.js";
import type { OrdersRepository } from "../orders/repository/index.js";
import { resolveOrgId } from "../../auth/org.js";
import type { Actor } from "../../auth/types.js";

// Re-export PromotionType for external use
export type PromotionType =
  | "percentage_off_order"
  | "fixed_off_order"
  | "percentage_off_item"
  | "fixed_off_item"
  | "free_shipping"
  | "buy_x_get_y";

/** Filter status for listing promotions. Used by the REST API and service layer. */
export type PromotionStatusFilter = "active" | "inactive" | "expired" | "scheduled";

interface PromotionServiceDeps {
  repository: PromotionsRepository;
  catalogRepository: CatalogRepository;
  ordersRepository: OrdersRepository;
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
    logger: createLogger("promotions"),
    services,
    context: { moduleName: "promotions" },
    database: { db: database.db as PluginDb },
  });
}

export interface PromotionLineItem {
  entityId: string;
  entityType: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}

export interface PromotionEvaluationContext {
  orgId?: string;
  cartId?: string;
  customerId?: string;
  customerGroupIds?: string[];
  currency: string;
  subtotal: number;
  lineItems: PromotionLineItem[];
  promotionCodes?: string[];
  timestamp?: Date;
}

export interface PromotionConditions {
  minimumOrderValue?: number;
  minimumQuantity?: number;
  entityTypes?: string[];
  categories?: string[];
  customerGroups?: string[];
  firstOrderOnly?: boolean;
}

export type { CreatePromotionInput } from "./schemas.js";
import type { CreatePromotionInput } from "./schemas.js";

export interface AppliedPromotion {
  promotionId: string;
  code?: string;
  type: PromotionType;
  discountAmount: number;
  freeShipping: boolean;
  description: string;
}

export interface PromotionApplicationResult {
  totalDiscount: number;
  freeShipping: boolean;
  applied: AppliedPromotion[];
  rejectedCodes: Array<{ code: string; reason: string }>;
}

function matchesWindow(promotion: Promotion, timestamp: Date): boolean {
  if (!promotion.isActive) return false;
  if (promotion.validFrom && timestamp < promotion.validFrom) return false;
  if (promotion.validUntil && timestamp > promotion.validUntil) return false;
  return true;
}

function toConditions(
  raw: Record<string, unknown> | null | undefined,
): PromotionConditions {
  if (!raw) return {};
  const conditions: PromotionConditions = {};
  if (typeof raw.minimumOrderValue === "number") {
    conditions.minimumOrderValue = raw.minimumOrderValue;
  }
  if (typeof raw.minimumQuantity === "number") {
    conditions.minimumQuantity = raw.minimumQuantity;
  }
  if (Array.isArray(raw.entityTypes)) {
    conditions.entityTypes = raw.entityTypes.filter(
      (item): item is string => typeof item === "string",
    );
  }
  if (Array.isArray(raw.categories)) {
    conditions.categories = raw.categories.filter(
      (item): item is string => typeof item === "string",
    );
  }
  if (Array.isArray(raw.customerGroups)) {
    conditions.customerGroups = raw.customerGroups.filter(
      (item): item is string => typeof item === "string",
    );
  }
  if (typeof raw.firstOrderOnly === "boolean") {
    conditions.firstOrderOnly = raw.firstOrderOnly;
  }
  return conditions;
}

function roundMoney(amount: number): number {
  return Math.max(0, Math.round(amount));
}

function totalQuantity(items: PromotionLineItem[]): number {
  return items.reduce((sum, item) => sum + item.quantity, 0);
}

function sortByPriority(promotions: Promotion[]): Promotion[] {
  return [...promotions].sort((a, b) => a.priority - b.priority);
}

export class PromotionService {
  private readonly repo: PromotionsRepository;
  private readonly catalogRepo: CatalogRepository;
  private readonly ordersRepo: OrdersRepository;

  constructor(private deps: PromotionServiceDeps) {
    this.repo = deps.repository;
    this.catalogRepo = deps.catalogRepository;
    this.ordersRepo = deps.ordersRepository;
  }

  async create(
    input: CreatePromotionInput,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<Promotion>> {
    if (!input.name) {
      return Err(new CommerceValidationError("Promotion name is required."));
    }
    if (input.value < 0) {
      return Err(
        new CommerceValidationError("Promotion value cannot be negative."),
      );
    }

    // Validate promotion type
    const validTypes: PromotionType[] = [
      "percentage_off_order",
      "fixed_off_order",
      "percentage_off_item",
      "fixed_off_item",
      "free_shipping",
      "buy_x_get_y",
    ];
    if (!validTypes.includes(input.type)) {
      return Err(
        new CommerceValidationError(
          `Invalid promotion type "${input.type}". Must be one of: ${validTypes.join(", ")}`,
        ),
      );
    }

    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);

    if (input.code) {
      const normalized = input.code.trim().toUpperCase();
      const existing = await this.repo.findByCode(orgId, normalized, ctx);
      if (existing) {
        return Err(
          new CommerceValidationError(
            `Promotion code ${normalized} already exists.`,
          ),
        );
      }
    }

    const promotion = await this.repo.create(
      {
        organizationId: orgId,
        name: input.name,
        type: input.type,
        value: roundMoney(input.value),
        isAutomatic: input.isAutomatic ?? false,
        isActive: input.isActive ?? true,
        priority: input.priority ?? 100,
        conditions: (input.conditions ?? {}) as Record<string, unknown>,
        metadata: input.metadata ?? {},
        code: input.code ? input.code.trim().toUpperCase() : null,
        buyQuantity: input.buyQuantity ?? null,
        getQuantity: input.getQuantity ?? null,
        usageLimitTotal: input.usageLimitTotal ?? null,
        usageLimitPerCustomer: input.usageLimitPerCustomer ?? null,
        validFrom: input.validFrom ?? null,
        validUntil: input.validUntil ?? null,
      },
      ctx,
    );

    const afterHooks = this.deps.hooks.resolve(
      "promotions.afterCreate",
    ) as AfterHook<Promotion>[];
    const hctx = hookContext(
      actor ?? ctx?.actor ?? null,
      this.deps.services,
      this.deps.database,
      ctx?.tx ?? null,
    );
    await runAfterHooks(afterHooks, null, promotion, "create", hctx);

    return Ok(promotion);
  }

  async deactivate(orgId: string, id: string, ctx?: TxContext): Promise<Result<Promotion>> {
    const promotion = await this.repo.findById(orgId, id, ctx);
    if (!promotion) {
      return Err(new CommerceNotFoundError("Promotion not found."));
    }

    const updated = await this.repo.update(id, { isActive: false }, ctx);
    if (!updated) {
      return Err(new CommerceNotFoundError("Promotion not found."));
    }

    const afterHooks = this.deps.hooks.resolve(
      "promotions.afterUpdate",
    ) as AfterHook<Promotion>[];
    const hctx = hookContext(null, this.deps.services, this.deps.database, ctx?.tx ?? null);
    await runAfterHooks(afterHooks, promotion, updated, "update", hctx);

    return Ok(updated);
  }

  async list(
    filter?: { status?: PromotionStatusFilter },
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<Promotion[]>> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const all = await this.repo.findAll(orgId, ctx);
    const now = new Date();

    if (!filter?.status) return Ok(sortByPriority(all));

    const filtered = all.filter((p) => {
      const isActive = p.isActive && matchesWindow(p, now);
      const isExpired = p.isActive && p.validUntil && new Date(p.validUntil) < now;
      const isScheduled = p.isActive && p.validFrom && new Date(p.validFrom) > now;
      const isInactive = !p.isActive;

      switch (filter.status) {
        case "active": return isActive;
        case "inactive": return isInactive;
        case "expired": return isExpired;
        case "scheduled": return isScheduled;
        default: return true;
      }
    });

    return Ok(sortByPriority(filtered));
  }

  async listActive(
    actor?: Actor | null,
    timestamp = new Date(),
    ctx?: TxContext,
  ): Promise<Result<Promotion[]>> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const active = await this.repo.findActive(orgId, ctx);
    // Further filter by timestamp in case repo returns slightly stale results
    const filtered = active.filter((p) => matchesWindow(p, timestamp));
    return Ok(sortByPriority(filtered));
  }

  async validate(
    code: string,
    context: PromotionEvaluationContext,
    ctx?: TxContext,
  ): Promise<Result<Promotion>> {
    const normalized = code.trim().toUpperCase();
    const evalOrgId = resolveOrgId(ctx?.actor ?? null, context.orgId);
    const promotion = await this.repo.findByCode(evalOrgId, normalized, ctx);
    if (!promotion) {
      return Err(
        new CommerceNotFoundError(`Promotion code ${normalized} not found.`),
      );
    }

    const validation = await this.validatePromotionForContext(
      promotion,
      context,
      context.timestamp ?? new Date(),
      ctx,
    );
    if (validation !== undefined) {
      return Err(new CommerceValidationError(validation));
    }
    return Ok(promotion);
  }

  async apply(
    code: string,
    context: PromotionEvaluationContext,
    ctx?: TxContext,
  ): Promise<Result<PromotionApplicationResult>> {
    const validation = await this.validate(code, context, ctx);
    if (!validation.ok) return validation;

    const evaluated = await this.evaluatePromotion(
      validation.value,
      context,
      ctx,
    );
    return Ok({
      totalDiscount: evaluated.discountAmount,
      freeShipping: evaluated.freeShipping,
      applied: [evaluated],
      rejectedCodes: [],
    });
  }

  async applyPromotions(
    context: PromotionEvaluationContext,
    ctx?: TxContext,
  ): Promise<Result<PromotionApplicationResult>> {
    const timestamp = context.timestamp ?? new Date();
    const applyOrgId = resolveOrgId(ctx?.actor ?? null, context.orgId);
    const result: PromotionApplicationResult = {
      totalDiscount: 0,
      freeShipping: false,
      applied: [],
      rejectedCodes: [],
    };

    const selectedPromotions: Promotion[] = [];

    // Process explicit promotion codes
    const codeSet = new Set(
      (context.promotionCodes ?? []).map((code) => code.trim().toUpperCase()),
    );
    if (codeSet.size > 0) {
      for (const code of codeSet) {
        const promotion = await this.repo.findByCode(applyOrgId, code, ctx);
        if (!promotion) {
          result.rejectedCodes.push({ code, reason: "Code not found." });
          continue;
        }
        const reason = await this.validatePromotionForContext(
          promotion,
          context,
          timestamp,
          ctx,
        );
        if (reason !== undefined) {
          result.rejectedCodes.push({ code, reason });
          continue;
        }
        selectedPromotions.push(promotion);
      }
    }

    // Process automatic promotions
    const automaticPromotions = await this.repo.findAutomatic(applyOrgId, ctx);
    for (const promotion of automaticPromotions) {
      const reason = await this.validatePromotionForContext(
        promotion,
        context,
        timestamp,
        ctx,
      );
      if (reason !== undefined) continue;
      selectedPromotions.push(promotion);
    }

    for (const promotion of sortByPriority(selectedPromotions)) {
      const evaluated = await this.evaluatePromotion(promotion, context, ctx);
      if (evaluated.discountAmount <= 0 && !evaluated.freeShipping) continue;
      result.totalDiscount += evaluated.discountAmount;
      result.freeShipping = result.freeShipping || evaluated.freeShipping;
      result.applied.push(evaluated);
    }

    result.totalDiscount = Math.min(
      roundMoney(result.totalDiscount),
      roundMoney(context.subtotal),
    );
    return Ok(result);
  }

  async recordUsage(
    input: {
      promotions: AppliedPromotion[];
      customerId?: string;
      orderId?: string;
    },
    ctx?: TxContext,
  ): Promise<Result<PromotionUsage[]>> {
    const usages: PromotionUsage[] = [];
    for (const applied of input.promotions) {
      const usage = await this.repo.createUsage(
        {
          promotionId: applied.promotionId,
          customerId: input.customerId ?? null,
          orderId: input.orderId ?? null,
        },
        ctx,
      );
      usages.push(usage);
    }
    return Ok(usages);
  }

  private async validatePromotionForContext(
    promotion: Promotion,
    context: PromotionEvaluationContext,
    timestamp: Date,
    ctx?: TxContext,
  ): Promise<string | undefined> {
    if (!matchesWindow(promotion, timestamp)) {
      return "Promotion is inactive or outside validity window.";
    }

    const conditions = toConditions(
      promotion.conditions as Record<string, unknown> | null,
    );
    if (
      conditions.minimumOrderValue !== undefined &&
      roundMoney(context.subtotal) < roundMoney(conditions.minimumOrderValue)
    ) {
      return `Requires minimum order value of ${conditions.minimumOrderValue}.`;
    }

    if (
      conditions.minimumQuantity !== undefined &&
      totalQuantity(context.lineItems) < conditions.minimumQuantity
    ) {
      return `Requires minimum quantity of ${conditions.minimumQuantity}.`;
    }

    if (conditions.customerGroups && conditions.customerGroups.length > 0) {
      const set = new Set(context.customerGroupIds ?? []);
      const matchesGroup = conditions.customerGroups.some((group) =>
        set.has(group),
      );
      if (!matchesGroup) {
        return "Customer group not eligible for this promotion.";
      }
    }

    if (conditions.entityTypes && conditions.entityTypes.length > 0) {
      const hasType = context.lineItems.some((lineItem) =>
        conditions.entityTypes!.includes(lineItem.entityType),
      );
      if (!hasType) return "Cart does not include required entity type.";
    }

    if (conditions.categories && conditions.categories.length > 0) {
      const categoryMatches = await this.checkCategoryMatch(
        context.lineItems,
        conditions.categories,
        ctx,
      );
      if (!categoryMatches) return "Cart does not include required category.";
    }

    if (conditions.firstOrderOnly) {
      if (!context.customerId) {
        return "First-order promotion requires authenticated customer.";
      }
      const orders = await this.ordersRepo.findByCustomerId(
        resolveOrgId(ctx?.actor ?? null, context.orgId),
        context.customerId,
        ctx,
      );
      if (orders.length > 0) {
        return "Promotion is valid for first order only.";
      }
    }

    // Check usage limits
    const usageCount = await this.repo.countUsages(promotion.id, ctx);
    if (
      promotion.usageLimitTotal !== null &&
      usageCount >= promotion.usageLimitTotal
    ) {
      return "Promotion usage limit reached.";
    }

    if (promotion.usageLimitPerCustomer !== null && context.customerId) {
      const customerUses = await this.repo.countUsagesByCustomer(
        promotion.id,
        context.customerId,
        ctx,
      );
      if (customerUses >= promotion.usageLimitPerCustomer) {
        return "Promotion per-customer usage limit reached.";
      }
    }

    return undefined;
  }

  private async checkCategoryMatch(
    lineItems: PromotionLineItem[],
    categorySlugs: string[],
    ctx?: TxContext,
  ): Promise<boolean> {
    for (const lineItem of lineItems) {
      const entityCategories = await this.catalogRepo.findEntityCategories(
        lineItem.entityId,
        ctx,
      );
      for (const link of entityCategories) {
        const category = await this.catalogRepo.findCategoryById(
          link.categoryId,
          ctx,
        );
        if (category && categorySlugs.includes(category.slug)) {
          return true;
        }
      }
    }
    return false;
  }

  private async evaluatePromotion(
    promotion: Promotion,
    context: PromotionEvaluationContext,
    ctx?: TxContext,
  ): Promise<AppliedPromotion> {
    const conditions = toConditions(
      promotion.conditions as Record<string, unknown> | null,
    );
    const eligibleItems = await this.filterEligibleLineItems(
      context.lineItems,
      conditions,
      ctx,
    );
    const eligibleSubtotal = eligibleItems.reduce(
      (sum, item) => sum + item.totalPrice,
      0,
    );

    let discountAmount = 0;
    let freeShipping = false;

    switch (promotion.type) {
      case "percentage_off_order":
        discountAmount = Math.round((context.subtotal * promotion.value) / 100);
        break;
      case "fixed_off_order":
        discountAmount = promotion.value;
        break;
      case "percentage_off_item":
        discountAmount = Math.round((eligibleSubtotal * promotion.value) / 100);
        break;
      case "fixed_off_item": {
        const totalUnits = eligibleItems.reduce(
          (sum, item) => sum + item.quantity,
          0,
        );
        discountAmount = totalUnits * promotion.value;
        break;
      }
      case "free_shipping":
        freeShipping = true;
        break;
      case "buy_x_get_y": {
        const buy = promotion.buyQuantity ?? 0;
        const get = promotion.getQuantity ?? 0;
        const totalUnits = eligibleItems.reduce(
          (sum, item) => sum + item.quantity,
          0,
        );
        if (buy > 0 && get > 0 && totalUnits > 0) {
          const groups = Math.floor(totalUnits / (buy + get));
          const freeUnits = groups * get;
          const minUnitPrice = eligibleItems.length
            ? Math.min(...eligibleItems.map((item) => item.unitPrice))
            : 0;
          discountAmount = freeUnits * minUnitPrice;
        }
        break;
      }
      default:
        discountAmount = 0;
    }

    return {
      promotionId: promotion.id,
      type: promotion.type as PromotionType,
      discountAmount: roundMoney(discountAmount),
      freeShipping,
      description: promotion.code
        ? `Promotion ${promotion.code}`
        : `Promotion ${promotion.name}`,
      ...(promotion.code !== null ? { code: promotion.code } : {}),
    };
  }

  private async filterEligibleLineItems(
    lineItems: PromotionLineItem[],
    conditions: PromotionConditions,
    ctx?: TxContext,
  ): Promise<PromotionLineItem[]> {
    const eligible: PromotionLineItem[] = [];

    for (const lineItem of lineItems) {
      if (conditions.entityTypes && conditions.entityTypes.length > 0) {
        if (!conditions.entityTypes.includes(lineItem.entityType)) continue;
      }
      if (conditions.categories && conditions.categories.length > 0) {
        const entityCats = await this.catalogRepo.findEntityCategories(
          lineItem.entityId,
          ctx,
        );
        const hasCategory = await (async () => {
          for (const link of entityCats) {
            const category = await this.catalogRepo.findCategoryById(
              link.categoryId,
              ctx,
            );
            if (category && conditions.categories!.includes(category.slug)) {
              return true;
            }
          }
          return false;
        })();
        if (!hasCategory) continue;
      }
      eligible.push(lineItem);
    }

    return eligible;
  }
}
