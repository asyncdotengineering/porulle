import { resolveOrgId } from "../../auth/org.js";
import { assertPermission } from "../../auth/permissions.js";
import type { Actor } from "../../auth/types.js";
import {
  CommerceConflictError,
  CommerceNotFoundError,
  CommerceValidationError,
  toCommerceError,
} from "../../kernel/errors.js";
import {
  mergeHookReports,
  runAfterHooks,
  runBeforeHooks,
} from "../../kernel/hooks/executor.js";
import { createHookContext } from "../../kernel/hooks/create-context.js";
import type {
  AfterHook,
  BeforeHook,
  HookContext,
} from "../../kernel/hooks/types.js";
import { Err, Ok, type Result } from "../../kernel/result.js";
import { createLogger } from "../../utils/logger.js";
import { paginate } from "../../utils/pagination.js";
import type { PluginDb } from "../../kernel/database/plugin-types.js";
import type { TxContext } from "../../kernel/database/tx-context.js";
import type {
  CatalogServiceDeps,
  CatalogEntityHydrated,
  CatalogListResult,
  CreateEntityInput,
  GetOptions,
  ListParams,
  SetAttributesInput,
  UpdateEntityInput,
  VariantGenerationStrategy,
  CreateOptionTypeInput,
  CreateOptionValueInput,
  CreateVariantInput,
} from "./service.js";
import type {
  SellableEntity,
  SellableAttribute,
  SellableCustomField,
  SellableCustomFieldInsert,
  OptionType,
  OptionValue,
  Variant,
} from "./repository/index.js";

function hookDatabaseArg(database: CatalogServiceDeps["database"]): { database: { db: PluginDb } } {
  return { database: { db: database.db as PluginDb } };
}

type CatalogCreateBeforeHook = BeforeHook<CreateEntityInput>;
type CatalogCreateAfterHook = AfterHook<SellableEntity>;
type CatalogUpdateBeforeHook = BeforeHook<UpdateEntityInput>;
type CatalogUpdateAfterHook = AfterHook<SellableEntity>;
type CatalogReadHookInput = { id?: string; slug?: string; options?: GetOptions };
type CatalogReadBeforeHook = BeforeHook<CatalogReadHookInput>;
type CatalogReadAfterHook = AfterHook<CatalogEntityHydrated>;
type CatalogListBeforeHook = BeforeHook<ListParams>;
type CatalogListAfterHook = AfterHook<CatalogListResult>;

function cartesian<T>(arrays: T[][]): T[][] {
  return arrays.reduce<T[][]>((acc, values) => acc.flatMap((entry) => values.map((value) => [...entry, value])), [[]]);
}

function getCustomFieldValue(field: SellableCustomField): unknown {
  switch (field.fieldType) {
    case "text":
    case "relation":
      return field.textValue;
    case "number":
      return field.numberValue;
    case "boolean":
      return field.booleanValue;
    case "date":
      return field.dateValue;
    case "json":
      return field.jsonValue;
    default:
      return null;
  }
}

export class EntityService {
  constructor(private readonly deps: CatalogServiceDeps) {}

  private get repo() {
    return this.deps.repository;
  }

  private assertSameOrg(resource: { organizationId?: string | null } | undefined, actor: Actor | null): void {
    if (!resource) return;
    const orgId = resolveOrgId(actor);
    if (resource.organizationId && resource.organizationId !== orgId) {
      throw new CommerceNotFoundError("Entity not found.");
    }
  }

  private async validateAndCreateCustomFields(entityId: string, entityType: string, customFields: Record<string, unknown> | undefined, ctx?: TxContext): Promise<Result<void>> {
    if (!customFields) return Ok(undefined);
    const entityConfig = this.deps.config.entities?.[entityType];
    if (!entityConfig) return Ok(undefined);
    const definitionMap = new Map(entityConfig.fields.map((f) => [f.name, f]));
    for (const [name, value] of Object.entries(customFields)) {
      const def = definitionMap.get(name);
      if (!def) return Err(new CommerceValidationError(`Unknown custom field: ${name}`));
      const type = def.type;
      let valid = false;
      switch (type) {
        case "text":
        case "relation":
        case "select":
          valid = typeof value === "string";
          break;
        case "number":
          valid = typeof value === "number";
          break;
        case "boolean":
          valid = typeof value === "boolean";
          break;
        case "date":
          valid = typeof value === "string" || value instanceof Date;
          break;
        case "json":
          valid = typeof value === "object";
          break;
        default:
          valid = false;
      }
      if (!valid) return Err(new CommerceValidationError(`Custom field ${name} expected type ${type}.`));
      const fieldType = (type === "select" ? "text" : type) as SellableCustomField["fieldType"];
      const insertData: SellableCustomFieldInsert = { entityId, fieldName: name, fieldType };
      switch (fieldType) {
        case "text":
        case "relation":
          insertData.textValue = value as string;
          break;
        case "number":
          insertData.numberValue = value as number;
          break;
        case "boolean":
          insertData.booleanValue = value as boolean;
          break;
        case "date":
          insertData.dateValue = value instanceof Date ? value : new Date(value as string);
          break;
        case "json":
          insertData.jsonValue = value;
          break;
      }
      await this.repo.createCustomField(insertData, ctx);
    }
    return Ok(undefined);
  }

  private async hydrateEntity(entity: SellableEntity, options?: GetOptions, ctx?: TxContext): Promise<CatalogEntityHydrated> {
    const hydrated: CatalogEntityHydrated = { ...entity };
    if (options?.includeAttributes) {
      const attrs = await this.repo.findAttributesByEntityId(entity.id, ctx);
      if (typeof options.includeAttributes === "object") {
        hydrated.attributes = attrs.filter((a) => options.includeAttributes && typeof options.includeAttributes === "object" && options.includeAttributes.locales.includes(a.locale));
      } else {
        hydrated.attributes = attrs;
      }
    }
    if (options?.includeVariants) {
      const entityVariants = await this.repo.findVariantsByEntityId(entity.id, ctx);
      hydrated.variants = await Promise.all(entityVariants.map(async (variant) => {
        const optionValues = await this.repo.findVariantOptionValues(variant.id, ctx);
        return { ...variant, optionValueIds: optionValues.map((vov) => vov.optionValueId) };
      }));
    }
    if (options?.includeOptionTypes) {
      const entityOptionTypes = await this.repo.findOptionTypesByEntityId(entity.id, ctx);
      hydrated.optionTypes = await Promise.all(entityOptionTypes.map(async (ot) => {
        const values = await this.repo.findOptionValuesByTypeId(ot.id, ctx);
        return { ...ot, values };
      }));
    }
    if (options?.includeCategories) hydrated.categories = await this.repo.findEntityCategories(entity.id, ctx);
    if (options?.includeBrands) hydrated.brands = await this.repo.findEntityBrands(entity.id, ctx);
    if (options?.includeMedia) hydrated.media = [];
    if (options?.includePricing) {
      try {
        const pricingService = this.deps.services.pricing as { listPrices: (filter: { entityId: string }) => Promise<{ ok: boolean; value?: { prices: Array<{ currency: string; amount: number; compareAtAmount?: number | null }> } }> };
        const priceResult = await pricingService.listPrices({ entityId: entity.id });
        if (priceResult.ok && priceResult.value) {
          hydrated.pricing = priceResult.value.prices.map((p) => ({ currency: p.currency, amount: p.amount, compareAtAmount: p.compareAtAmount ?? null }));
        }
      } catch {}
    }
    return hydrated;
  }

  async create(input: CreateEntityInput, actor: Actor | null, ctx?: TxContext): Promise<Result<CatalogEntityHydrated>> { try {
    assertPermission(actor, "catalog:create");
    const orgId = resolveOrgId(actor);
    const existingBySlug = await this.repo.findEntityBySlug(orgId, input.slug, ctx);
    if (existingBySlug) return Err(new CommerceConflictError(`Entity with slug ${input.slug} already exists.`));
    const beforeHooks = this.deps.hooks.resolve("catalog.beforeCreate") as CatalogCreateBeforeHook[];
    const afterHooks = this.deps.hooks.resolve("catalog.afterCreate") as CatalogCreateAfterHook[];
    const context: HookContext = createHookContext({ actor, tx: ctx?.tx ?? null, logger: createLogger("catalog.create"), services: this.deps.services, context: { moduleName: "catalog" }, ...hookDatabaseArg(this.deps.database) });
    const processedInput = await runBeforeHooks(beforeHooks, input, "create", context);
    const entity = await this.repo.createEntity({ organizationId: orgId, type: processedInput.type, slug: processedInput.slug, status: "draft", isVisible: false, metadata: processedInput.metadata ?? {} }, ctx);
    if (processedInput.attributes) {
      await this.repo.createAttribute({ entityId: entity.id, locale: processedInput.attributes.locale ?? "en", title: processedInput.attributes.title, subtitle: processedInput.attributes.subtitle, description: processedInput.attributes.description, richDescription: processedInput.attributes.richDescription, seoTitle: processedInput.attributes.seoTitle, seoDescription: processedInput.attributes.seoDescription }, ctx);
    }
    const customFieldsResult = await this.validateAndCreateCustomFields(entity.id, entity.type, processedInput.customFields, ctx);
    if (!customFieldsResult.ok) return customFieldsResult;
    const hookReport = await runAfterHooks(afterHooks, null, entity, "create", context);
    const hydrated = await this.hydrateEntity(entity, undefined, ctx);
    return Ok(hydrated, hookReport.hasErrors ? { hookErrors: hookReport.errors } : undefined);
  } catch (error) { return Err(toCommerceError(error)); } }

  async update(id: string, input: UpdateEntityInput, actor: Actor | null, ctx?: TxContext): Promise<Result<CatalogEntityHydrated>> { try {
    assertPermission(actor, "catalog:update");
    const existing = await this.repo.findEntityById(id, ctx);
    if (!existing) return Err(new CommerceNotFoundError("Entity not found."));
    this.assertSameOrg(existing, actor);
    const beforeHooks = this.deps.hooks.resolve("catalog.beforeUpdate") as CatalogUpdateBeforeHook[];
    const afterHooks = this.deps.hooks.resolve("catalog.afterUpdate") as CatalogUpdateAfterHook[];
    const context: HookContext = createHookContext({ actor, tx: ctx?.tx ?? null, logger: createLogger("catalog.update"), services: this.deps.services, context: { moduleName: "catalog" }, ...hookDatabaseArg(this.deps.database) });
    const processed = await runBeforeHooks(beforeHooks, input, "update", context);
    const updated = await this.repo.updateEntity(id, { ...(processed.slug !== undefined ? { slug: processed.slug } : {}), ...(processed.status !== undefined ? { status: processed.status as SellableEntity["status"] } : {}), ...(processed.metadata !== undefined ? { metadata: processed.metadata } : {}), ...(processed.isVisible !== undefined ? { isVisible: processed.isVisible } : {}) }, ctx);
    if (!updated) return Err(new CommerceNotFoundError("Entity not found."));
    const hookReport = await runAfterHooks(afterHooks, existing, updated, "update", context);
    const hydrated = await this.hydrateEntity(updated, undefined, ctx);
    return Ok(hydrated, hookReport.hasErrors ? { hookErrors: hookReport.errors } : undefined);
  } catch (error) { return Err(toCommerceError(error)); } }

  async delete(id: string, actor: Actor | null, ctx?: TxContext): Promise<Result<void>> { try {
    assertPermission(actor, "catalog:delete");
    const existing = await this.repo.findEntityById(id, ctx);
    if (!existing) return Err(new CommerceNotFoundError("Entity not found."));
    this.assertSameOrg(existing, actor);
    await this.repo.deleteAttributesByEntityId(id, ctx);
    await this.repo.deleteCustomFieldsByEntityId(id, ctx);
    await this.repo.deleteEntityCategoriesByEntityId(id, ctx);
    await this.repo.deleteEntityBrandsByEntityId(id, ctx);
    await this.repo.deleteVariantOptionValuesByEntityId(id, ctx);
    await this.repo.deleteVariantsByEntityId(id, ctx);
    await this.repo.deleteEntity(id, ctx);
    return Ok(undefined);
  } catch (error) { return Err(toCommerceError(error)); } }

  async getById(id: string, options?: GetOptions, actor?: Actor | null, ctx?: TxContext): Promise<Result<CatalogEntityHydrated>> {
    const context: HookContext = createHookContext({ actor: actor ?? null, tx: ctx?.tx ?? null, logger: createLogger("catalog.read"), services: this.deps.services, context: { moduleName: "catalog" }, ...hookDatabaseArg(this.deps.database) });
    const globalBeforeHooks = this.deps.hooks.resolve("catalog.beforeRead") as CatalogReadBeforeHook[];
    const globalAfterHooks = this.deps.hooks.resolve("catalog.afterRead") as CatalogReadAfterHook[];
    let processed = await runBeforeHooks(globalBeforeHooks, { id, ...(options !== undefined ? { options } : {}) }, "read", context);
    let entity = await this.repo.findEntityById(processed.id ?? id, ctx);
    if (!entity) return Err(new CommerceNotFoundError("Entity not found."));
    const entityBeforeHooks = this.deps.hooks.resolve(`catalog.${entity.type}.beforeRead`) as CatalogReadBeforeHook[];
    if (entityBeforeHooks.length > 0) {
      processed = await runBeforeHooks(entityBeforeHooks, { ...processed, id: entity.id }, "read", context);
      const resolvedId = processed.id ?? entity.id;
      if (resolvedId !== entity.id) {
        const refetched = await this.repo.findEntityById(resolvedId, ctx);
        if (!refetched) return Err(new CommerceNotFoundError("Entity not found."));
        entity = refetched;
      }
    }
    if (actor && entity.organizationId && entity.organizationId !== resolveOrgId(actor)) return Err(new CommerceNotFoundError("Entity not found."));
    const result = await this.hydrateEntity(entity, processed.options ?? options, ctx);
    const entityAfterHooks = this.deps.hooks.resolve(`catalog.${entity.type}.afterRead`) as CatalogReadAfterHook[];
    const report = mergeHookReports(await runAfterHooks(globalAfterHooks, null, result, "read", context), await runAfterHooks(entityAfterHooks, null, result, "read", context));
    return Ok(result, report.hasErrors ? { hookErrors: report.errors } : undefined);
  }

  async getBySlug(slug: string, options?: GetOptions, actor?: Actor | null, ctx?: TxContext): Promise<Result<CatalogEntityHydrated>> {
    const context: HookContext = createHookContext({ actor: actor ?? null, tx: ctx?.tx ?? null, logger: createLogger("catalog.read"), services: this.deps.services, context: { moduleName: "catalog" }, ...hookDatabaseArg(this.deps.database) });
    const globalBeforeHooks = this.deps.hooks.resolve("catalog.beforeRead") as CatalogReadBeforeHook[];
    const globalAfterHooks = this.deps.hooks.resolve("catalog.afterRead") as CatalogReadAfterHook[];
    let processed = await runBeforeHooks(globalBeforeHooks, { slug, ...(options !== undefined ? { options } : {}) }, "read", context);
    let resolvedSlug = processed.slug ?? slug;
    const orgId = resolveOrgId(actor ?? null);
    let entity = await this.repo.findEntityBySlug(orgId, resolvedSlug, ctx);
    if (!entity) return Err(new CommerceNotFoundError("Entity not found."));
    const entityBeforeHooks = this.deps.hooks.resolve(`catalog.${entity.type}.beforeRead`) as CatalogReadBeforeHook[];
    if (entityBeforeHooks.length > 0) {
      processed = await runBeforeHooks(entityBeforeHooks, { ...processed, id: entity.id }, "read", context);
      const nextId = processed.id ?? entity.id;
      const nextSlug = processed.slug ?? resolvedSlug;
      if (nextId !== entity.id) {
        const refetched = await this.repo.findEntityById(nextId, ctx);
        if (!refetched) return Err(new CommerceNotFoundError("Entity not found."));
        entity = refetched;
        resolvedSlug = nextSlug;
      } else if (nextSlug !== resolvedSlug) {
        const refetched = await this.repo.findEntityBySlug(orgId, nextSlug, ctx);
        if (!refetched) return Err(new CommerceNotFoundError("Entity not found."));
        entity = refetched;
      }
    }
    const result = await this.hydrateEntity(entity, processed.options ?? options, ctx);
    const entityAfterHooks = this.deps.hooks.resolve(`catalog.${entity.type}.afterRead`) as CatalogReadAfterHook[];
    const report = mergeHookReports(await runAfterHooks(globalAfterHooks, null, result, "read", context), await runAfterHooks(entityAfterHooks, null, result, "read", context));
    return Ok(result, report.hasErrors ? { hookErrors: report.errors } : undefined);
  }

  async list(params: ListParams, actor?: Actor | null, ctx?: TxContext): Promise<Result<CatalogListResult>> {
    const resolvedActor = actor ?? ctx?.actor ?? null;
    const context: HookContext = createHookContext({ actor: resolvedActor, tx: ctx?.tx ?? null, logger: createLogger("catalog.list"), services: this.deps.services, context: { moduleName: "catalog" }, ...hookDatabaseArg(this.deps.database) });
    const globalBeforeHooks = this.deps.hooks.resolve("catalog.beforeList") as CatalogListBeforeHook[];
    const globalAfterHooks = this.deps.hooks.resolve("catalog.afterList") as CatalogListAfterHook[];
    let processed = await runBeforeHooks(globalBeforeHooks, params, "list", context);
    const initialTypeFilter = processed.filter?.type;
    if (initialTypeFilter) {
      const entityBeforeHooks = this.deps.hooks.resolve(`catalog.${initialTypeFilter}.beforeList`) as CatalogListBeforeHook[];
      if (entityBeforeHooks.length > 0) processed = await runBeforeHooks(entityBeforeHooks, processed, "list", context);
    }
    const listOrgId = resolveOrgId(resolvedActor);
    let entities = await this.repo.findEntities(listOrgId, { ...(processed.filter?.type ? { type: processed.filter.type } : {}), ...(processed.filter?.status ? { status: processed.filter.status } : {}) }, ctx);
    if (processed.filter?.category) {
      const catInput = processed.filter.category;
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      let category = await this.repo.findCategoryBySlug(listOrgId, catInput, ctx);
      if (!category && isUUID.test(catInput)) category = await this.repo.findCategoryById(catInput, ctx);
      if (!category) return Err(new CommerceValidationError(`Category not found: "${catInput}".`));
      const entityIds = await this.repo.findEntitiesByCategory(category.id, ctx);
      entities = entities.filter((e) => new Set(entityIds).has(e.id));
    }
    if (processed.filter?.brand) {
      let brand = await this.repo.findBrandBySlug(listOrgId, processed.filter.brand, ctx);
      if (!brand) brand = await this.repo.findBrandById(processed.filter.brand, ctx);
      if (brand) {
        const brandEntityIds: string[] = [];
        for (const entity of entities) {
          const entityBrands = await this.repo.findEntityBrands(entity.id, ctx);
          if (entityBrands.some((eb) => eb.brandId === brand!.id)) brandEntityIds.push(entity.id);
        }
        entities = entities.filter((e) => new Set(brandEntityIds).has(e.id));
      }
    }
    if (processed.filter?.customField) {
      const filteredIds: string[] = [];
      for (const entity of entities) {
        const fields = await this.repo.findCustomFieldsByEntityId(entity.id, ctx);
        const matches = fields.some((field) => field.fieldName === processed.filter?.customField?.fieldName && getCustomFieldValue(field) === processed.filter.customField.value);
        if (matches) filteredIds.push(entity.id);
      }
      entities = entities.filter((e) => new Set(filteredIds).has(e.id));
    }
    if (processed.sort) {
      const direction = processed.sort.direction === "asc" ? 1 : -1;
      entities.sort((a, b) => {
        const first = a[processed.sort!.field];
        const second = b[processed.sort!.field];
        if (first instanceof Date && second instanceof Date) return (first.getTime() - second.getTime()) * direction;
        return String(first).localeCompare(String(second)) * direction;
      });
    }
    const page = processed.pagination?.page ?? 1;
    const limit = processed.pagination?.limit ?? 20;
    const paged = paginate(entities, page, limit);
    const hydratedItems = await Promise.all(paged.items.map((entity) => this.hydrateEntity(entity, undefined, ctx)));
    const result = { items: hydratedItems, pagination: paged.pagination };
    const listTypeFilter = processed.filter?.type;
    const entityAfterHooks = listTypeFilter ? (this.deps.hooks.resolve(`catalog.${listTypeFilter}.afterList`) as CatalogListAfterHook[]) : [];
    const report = mergeHookReports(await runAfterHooks(globalAfterHooks, null, result, "list", context), await runAfterHooks(entityAfterHooks, null, result, "list", context));
    return Ok(result, report.hasErrors ? { hookErrors: report.errors } : undefined);
  }

  private async changeStatus(id: string, status: SellableEntity["status"], actor: Actor | null, ctx?: TxContext): Promise<Result<CatalogEntityHydrated>> {
    try { assertPermission(actor, "catalog:update"); } catch (error) { return Err(toCommerceError(error)); }
    const entity = await this.repo.findEntityById(id, ctx);
    if (!entity) return Err(new CommerceNotFoundError("Entity not found."));
    try { this.assertSameOrg(entity, actor); } catch (error) { return Err(toCommerceError(error)); }
    const updateData: Partial<SellableEntity> = { status };
    if (status === "active") { updateData.publishedAt = new Date(); updateData.isVisible = true; }
    const updated = await this.repo.updateEntity(id, updateData, ctx);
    if (!updated) return Err(new CommerceNotFoundError("Entity not found."));
    return Ok(await this.hydrateEntity(updated, undefined, ctx));
  }

  publish(id: string, actor: Actor | null, ctx?: TxContext): Promise<Result<CatalogEntityHydrated>> { return this.changeStatus(id, "active", actor, ctx); }
  archive(id: string, actor: Actor | null, ctx?: TxContext): Promise<Result<CatalogEntityHydrated>> { return this.changeStatus(id, "archived", actor, ctx); }
  discontinue(id: string, actor: Actor | null, ctx?: TxContext): Promise<Result<CatalogEntityHydrated>> { return this.changeStatus(id, "discontinued", actor, ctx); }

  async setAttributes(entityId: string, locale: string, attrs: SetAttributesInput, actor: Actor | null, ctx?: TxContext): Promise<Result<void>> {
    try { assertPermission(actor, "catalog:update"); } catch (error) { return Err(toCommerceError(error)); }
    const entity = await this.repo.findEntityById(entityId, ctx);
    if (!entity) return Err(new CommerceNotFoundError("Entity not found."));
    try { this.assertSameOrg(entity, actor); } catch (error) { return Err(toCommerceError(error)); }
    await this.repo.upsertAttribute(entityId, locale, { title: attrs.title, subtitle: attrs.subtitle, description: attrs.description, richDescription: attrs.richDescription, seoTitle: attrs.seoTitle, seoDescription: attrs.seoDescription }, ctx);
    return Ok(undefined);
  }

  async getAttributes(entityId: string, locale: string, ctx?: TxContext): Promise<Result<SellableAttribute>> {
    const attr = await this.repo.findAttributeByLocale(entityId, locale, ctx);
    if (!attr) return Err(new CommerceNotFoundError(`Attributes for locale ${locale} not found.`));
    return Ok(attr);
  }

  async createOptionType(input: CreateOptionTypeInput, actor: Actor | null, ctx?: TxContext): Promise<Result<OptionType>> {
    assertPermission(actor, "catalog:update");
    const entity = await this.repo.findEntityById(input.entityId, ctx);
    if (!entity) return Err(new CommerceNotFoundError("Entity not found."));
    const optionType = await this.repo.createOptionType({ entityId: input.entityId, name: input.name, displayName: input.name, sortOrder: 0 }, ctx);
    if (input.values) {
      for (const value of input.values) {
        await this.repo.createOptionValue({ optionTypeId: optionType.id, value, displayValue: value, sortOrder: 0, metadata: {} }, ctx);
      }
    }
    return Ok(optionType);
  }

  async createOptionValue(input: CreateOptionValueInput, actor: Actor | null, ctx?: TxContext): Promise<Result<OptionValue>> {
    assertPermission(actor, "catalog:update");
    const optionType = await this.repo.findOptionTypeById(input.optionTypeId, ctx);
    if (!optionType) return Err(new CommerceNotFoundError("Option type not found."));
    return Ok(await this.repo.createOptionValue({ optionTypeId: input.optionTypeId, value: input.value, displayValue: input.value, sortOrder: 0, metadata: {} }, ctx));
  }

  async createVariant(input: CreateVariantInput, actor: Actor | null, ctx?: TxContext): Promise<Result<Variant>> {
    assertPermission(actor, "catalog:update");
    const entity = await this.repo.findEntityById(input.entityId, ctx);
    if (!entity) return Err(new CommerceNotFoundError("Entity not found."));
    const entityOptionTypes = await this.repo.findOptionTypesByEntityId(input.entityId, ctx);
    const optionValueIds: string[] = [];
    for (const [optName, optVal] of Object.entries(input.options)) {
      const ot = entityOptionTypes.find((t) => t.name === optName);
      if (!ot) return Err(new CommerceValidationError(`Option type "${optName}" does not exist on this entity.`));
      const typeValues = await this.repo.findOptionValuesByTypeId(ot.id, ctx);
      const ov = typeValues.find((v) => v.value === optVal);
      if (!ov) return Err(new CommerceValidationError(`Option value "${optVal}" does not exist for option type "${optName}".`));
      optionValueIds.push(ov.id);
    }
    const variant = await this.repo.createVariant({ entityId: input.entityId, status: "active", sortOrder: 0, metadata: {}, ...(input.sku !== undefined ? { sku: input.sku } : {}) }, ctx);
    await this.repo.createVariantOptionValues(optionValueIds.map((optionValueId) => ({ variantId: variant.id, optionValueId })), ctx);
    return Ok(variant);
  }

  async generateVariants(entityId: string, strategy: VariantGenerationStrategy, actor: Actor | null, ctx?: TxContext): Promise<Result<Variant[]>> {
    assertPermission(actor, "catalog:update");
    const entity = await this.repo.findEntityById(entityId, ctx);
    if (!entity) return Err(new CommerceNotFoundError("Entity not found."));
    const entityOptionTypes = await this.repo.findOptionTypesByEntityId(entityId, ctx);
    const sortedOptionTypes = entityOptionTypes.sort((a, b) => a.sortOrder - b.sortOrder);
    const optionValueGroups: string[][] = [];
    for (const optionType of sortedOptionTypes) {
      const values = await this.repo.findOptionValuesByTypeId(optionType.id, ctx);
      optionValueGroups.push(values.sort((a, b) => a.sortOrder - b.sortOrder).map((v) => v.id));
    }
    let combinations: string[][] = [];
    if (strategy.mode === "all") combinations = cartesian(optionValueGroups);
    else if (strategy.mode === "manual") combinations = strategy.combinations;
    else {
      const base = cartesian(optionValueGroups);
      const include = strategy.matrix.include;
      const exclude = strategy.matrix.exclude;
      combinations = base.filter((combo) => {
        const isExcluded = (exclude ?? []).some((pattern) => pattern.every((val) => combo.includes(val)));
        if (isExcluded) return false;
        if (!include || include.length === 0) return true;
        return include.some((pattern) => pattern.every((val) => combo.includes(val)));
      });
    }
    const created: Variant[] = [];
    for (const combo of combinations) {
      const variant = await this.repo.createVariant({ entityId, status: "active", sortOrder: 0, metadata: { generatedBy: strategy.mode } }, ctx);
      await this.repo.createVariantOptionValues(combo.map((optionValueId) => ({ variantId: variant.id, optionValueId })), ctx);
      created.push(variant);
    }
    return Ok(created);
  }
}
