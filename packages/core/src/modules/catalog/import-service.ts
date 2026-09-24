import { and, eq, inArray } from "drizzle-orm";
import type { Actor } from "../../auth/types.js";
import { resolveOrgIdForCommerce } from "../../auth/org.js";
import { assertPermission } from "../../auth/permissions.js";
import { Err, Ok, type Result } from "../../kernel/result.js";
import { toCommerceError } from "../../kernel/errors.js";
import type { PluginDb } from "../../kernel/database/plugin-types.js";
import { createTxContext, isWriteContextTransactional, resolveWriteContextHookContext, type CatalogWriteContext, type TxContext } from "../../kernel/database/tx-context.js";
import { runAfterHooks } from "../../kernel/hooks/executor.js";
import type { AfterHook } from "../../kernel/hooks/types.js";
import { isValidFieldPath, type FieldPath } from "./ownership.js";
import {
  brands,
  categories,
  catalogFieldOwnership,
  entityBrands,
  entityCategories,
  entityTags,
  optionTypes,
  optionValues,
  sellableAttributes,
  sellableEntities,
  sellableEntityRevisions,
  tags,
  variantOptionValues,
  variants,
  type SellableEntityRevisionReason,
  type SellableEntityRevisionSnapshot,
} from "./schema.js";
import { prices } from "../pricing/schema.js";
import { catalogHookContext } from "./entity-service.js";
import type { CatalogServiceDeps } from "./service.js";

/**
 * The import fast path: a PAGE of new products lands in one transaction.
 *
 * `create` + `createVariant` + `setAttributes` + … cost 564 statements for one 12-variant product
 * (measured 2026-09-22) because every call re-reads the entity, records a revision and writes one
 * row per statement. This path reads the page's state once, writes multi-row, isolates each item
 * behind a savepoint, records one revision per item and one audit row per page, and fires no
 * per-entity hook — the same split Vendure (`FastImporterService`), Saleor (`productBulkCreate`)
 * and Medusa (`createProducts([])`) make between the editor path and the importer path.
 *
 * It creates; it never updates. A caller that finds an item already present routes it through the
 * editor path, which is where ownership, conflict detection and revision diffing live.
 */

export interface ImportProductPrice {
  currency: string;
  amount: number;
  compareAtAmount?: number;
}

export interface ImportProductVariant {
  /** The caller's key for this variant; echoed in the row result so ids can be mapped back. */
  ref: string;
  sku?: string;
  barcode?: string;
  /** option name → option value, both as declared in `ImportProduct.options`. */
  options?: Record<string, string>;
  prices?: ImportProductPrice[];
  metadata?: Record<string, unknown>;
}

export interface ImportProductOption {
  name: string;
  displayName?: string;
  sortOrder?: number;
  values: Array<{ value: string; displayValue?: string; sortOrder?: number }>;
}

export interface ImportProductAttributes {
  locale: string;
  title: string;
  subtitle?: string;
  description?: string;
  richDescription?: unknown;
  seoTitle?: string;
  seoDescription?: string;
}

export interface ImportProduct {
  /** The caller's key for this item; echoed in the row result. Unique within the page. */
  ref: string;
  type?: string;
  slug: string;
  status?: "draft" | "active" | "archived" | "discontinued";
  isVisible?: boolean;
  taxClass?: string;
  metadata?: Record<string, unknown>;
  attributes: ImportProductAttributes[];
  options?: ImportProductOption[];
  variants: ImportProductVariant[];
  tags?: string[];
  brand?: string;
  categories?: string[];
  /** Field paths seeded as owned by the source store; an invalid path fails the row. */
  ownedFieldPaths?: string[];
}

/**
 * Saleor's `errorPolicy`, minus IGNORE_FAILED (a silently shrinking page is the failure mode a
 * page-level report exists to prevent).
 */
export type ImportErrorPolicy = "reject-failed-rows" | "reject-everything";

export interface ImportProductsOptions {
  sourceStoreId: string;
  errorPolicy?: ImportErrorPolicy;
  reason?: Extract<SellableEntityRevisionReason, "import" | "create">;
}

export type ImportRowFailureCode =
  | "duplicate-in-page"
  | "invalid"
  | "slug-conflict"
  | "conflict"
  | "write-failed"
  | "rejected-by-policy";

export type ImportProductRowResult =
  | {
    ref: string;
    status: "created";
    entityId: string;
    /** variant ref → variant id. */
    variantIds: Record<string, string>;
    warnings: string[];
  }
  | { ref: string; status: "failed"; code: ImportRowFailureCode; error: string };

export interface ImportProductsReport extends Record<string, unknown> {
  sourceStoreId: string;
  created: number;
  failed: number;
  /** One per input item, in input order. */
  rows: ImportProductRowResult[];
}

type Writer = Pick<PluginDb, "insert" | "select">;

/** The drizzle handle a transaction context carries (typed `unknown` on the context). */
const writerOf = (txCtx: TxContext): PluginDb => txCtx.tx as PluginDb;

type Failure = { code: ImportRowFailureCode; error: string };

function failed(ref: string, code: ImportRowFailureCode, error: string): ImportProductRowResult {
  return { ref, status: "failed", code, error };
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { code?: unknown; cause?: unknown };
  if (value.code === "23505") return true;
  return isUniqueViolation(value.cause);
}

/**
 * A row's failure names the constraint, not the statement: Drizzle's message carries the whole
 * query with its parameters, which is merchant data in a report that travels.
 */
function describeWriteError(error: unknown): string {
  let cursor: unknown = error;
  for (let depth = 0; depth < 5 && typeof cursor === "object" && cursor !== null; depth += 1) {
    const value = cursor as { detail?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof value.detail === "string") return typeof value.constraint === "string" ? `${value.constraint}: ${value.detail}` : value.detail;
    cursor = value.cause;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n", 1)[0] ?? message;
}

function normaliseCurrency(currency: string): string {
  return currency.trim().toUpperCase();
}

/** Everything that can be known wrong without a database. */
function validateInMemory(page: ImportProduct[]): Map<number, Failure> {
  const failures = new Map<number, Failure>();
  const seenRefs = new Set<string>();
  const seenSlugs = new Set<string>();
  page.forEach((item, index) => {
    const fail = (error: string, code: ImportRowFailureCode = "invalid"): void => {
      if (!failures.has(index)) failures.set(index, { code, error });
    };
    if (seenRefs.has(item.ref)) fail(`Item ref "${item.ref}" appears twice in the page.`, "duplicate-in-page");
    seenRefs.add(item.ref);
    if (seenSlugs.has(item.slug)) fail(`Slug "${item.slug}" appears twice in the page.`, "duplicate-in-page");
    seenSlugs.add(item.slug);
    if (item.slug.trim().length === 0) fail("Slug is required.");
    if (item.attributes.length === 0) fail("At least one attributes row is required.");
    const locales = new Set<string>();
    for (const attributes of item.attributes) {
      if (attributes.title.trim().length === 0) fail(`Attributes for "${attributes.locale}" need a title.`);
      if (locales.has(attributes.locale)) fail(`Attributes for "${attributes.locale}" appear twice.`);
      locales.add(attributes.locale);
    }
    const declared = new Map<string, Set<string>>();
    for (const option of item.options ?? []) {
      if (declared.has(option.name)) fail(`Option "${option.name}" is declared twice.`);
      const values = new Set<string>();
      for (const value of option.values) {
        if (values.has(value.value)) fail(`Option "${option.name}" declares value "${value.value}" twice.`);
        values.add(value.value);
      }
      declared.set(option.name, values);
    }
    const variantRefs = new Set<string>();
    for (const variant of item.variants) {
      if (variantRefs.has(variant.ref)) fail(`Variant ref "${variant.ref}" appears twice.`);
      variantRefs.add(variant.ref);
      for (const [name, value] of Object.entries(variant.options ?? {})) {
        const values = declared.get(name);
        if (!values) fail(`Variant "${variant.ref}" references undeclared option "${name}".`);
        else if (!values.has(value)) fail(`Variant "${variant.ref}" references undeclared value "${value}" for option "${name}".`);
      }
      for (const price of variant.prices ?? []) {
        if (!Number.isInteger(price.amount) || price.amount < 0) fail(`Variant "${variant.ref}" has a non-integer or negative amount for ${price.currency}.`);
        if (normaliseCurrency(price.currency).length === 0) fail(`Variant "${variant.ref}" has a price with no currency.`);
      }
    }
    for (const path of item.ownedFieldPaths ?? []) {
      if (!isValidFieldPath(path)) fail(`Owned field path "${path}" is not a valid field path.`);
    }
  });
  return failures;
}

interface Taxonomy {
  categories: Map<string, { id: string; status: string }>;
  brands: Map<string, string>;
  tags: Map<string, string>;
}

/** Page-level: read what exists, create what is missing (racing a peer safely), read back. */
async function resolveTaxonomy(tx: Writer, orgId: string, page: ImportProduct[]): Promise<Taxonomy> {
  const categorySlugs = [...new Set(page.flatMap((item) => item.categories ?? []))];
  const brandSlugs = [...new Set(page.flatMap((item) => (item.brand ? [item.brand] : [])))];
  const tagSlugs = [...new Set(page.flatMap((item) => item.tags ?? []))];

  const readCategories = async (): Promise<Map<string, { id: string; status: string }>> => {
    if (categorySlugs.length === 0) return new Map();
    const rows = await tx.select({ id: categories.id, slug: categories.slug, status: categories.status }).from(categories)
      .where(and(eq(categories.organizationId, orgId), inArray(categories.slug, categorySlugs)));
    return new Map(rows.map((row) => [row.slug, { id: row.id, status: row.status }]));
  };
  const readBrands = async (): Promise<Map<string, string>> => {
    if (brandSlugs.length === 0) return new Map();
    const rows = await tx.select({ id: brands.id, slug: brands.slug }).from(brands)
      .where(and(eq(brands.organizationId, orgId), inArray(brands.slug, brandSlugs)));
    return new Map(rows.map((row) => [row.slug, row.id]));
  };
  const readTags = async (): Promise<Map<string, string>> => {
    if (tagSlugs.length === 0) return new Map();
    const rows = await tx.select({ id: tags.id, slug: tags.slug }).from(tags)
      .where(and(eq(tags.organizationId, orgId), inArray(tags.slug, tagSlugs)));
    return new Map(rows.map((row) => [row.slug, row.id]));
  };

  let categoryMap = await readCategories();
  const missingCategories = categorySlugs.filter((slug) => !categoryMap.has(slug));
  if (missingCategories.length > 0) {
    // ON CONFLICT DO NOTHING, then re-read: two consumers landing pages that share a vocabulary
    // both succeed, and whichever lost the race reads the winner's row. The find-then-insert the
    // editor path does raises 23505 for the loser.
    await tx.insert(categories).values(missingCategories.map((slug) => ({ organizationId: orgId, slug }))).onConflictDoNothing();
    categoryMap = await readCategories();
  }
  let brandMap = await readBrands();
  const missingBrands = brandSlugs.filter((slug) => !brandMap.has(slug));
  if (missingBrands.length > 0) {
    await tx.insert(brands).values(missingBrands.map((slug) => ({ organizationId: orgId, slug, displayName: slug }))).onConflictDoNothing();
    brandMap = await readBrands();
  }
  let tagMap = await readTags();
  const missingTags = tagSlugs.filter((slug) => !tagMap.has(slug));
  if (missingTags.length > 0) {
    await tx.insert(tags).values(missingTags.map((slug) => ({ organizationId: orgId, slug, displayName: slug }))).onConflictDoNothing();
    tagMap = await readTags();
  }
  return { categories: categoryMap, brands: brandMap, tags: tagMap };
}

type Snapshot = SellableEntityRevisionSnapshot;
type Row = Record<string, unknown>;
const asRows = (rows: object[]): Row[] => rows.map((row) => ({ ...row }));
const byKey = (key: string) => (a: Row, b: Row): number => String(a[key]).localeCompare(String(b[key]));

interface ItemWrite {
  entityId: string;
  variantIds: Record<string, string>;
  warnings: string[];
  snapshot: Snapshot;
}

/** One item, inside its own savepoint: eleven multi-row statements at most. */
async function writeItem(
  sp: Writer,
  orgId: string,
  sourceStoreId: string,
  item: ImportProduct,
  taxonomy: Taxonomy,
): Promise<ItemWrite> {
  const warnings: string[] = [];
  const [entity] = await sp.insert(sellableEntities).values({
    organizationId: orgId,
    sourceStoreId,
    type: item.type ?? "product",
    slug: item.slug,
    metadata: item.metadata ?? {},
    ...(item.status !== undefined ? { status: item.status } : {}),
    ...(item.isVisible !== undefined ? { isVisible: item.isVisible } : item.status !== undefined ? { isVisible: item.status === "active" } : {}),
    ...(item.taxClass !== undefined ? { taxClass: item.taxClass } : {}),
  }).returning();
  if (!entity) throw new Error("Entity insert returned no row.");
  const entityId = entity.id;

  const attributeRows = await sp.insert(sellableAttributes).values(item.attributes.map((attributes) => ({
    entityId,
    locale: attributes.locale,
    title: attributes.title,
    ...(attributes.subtitle !== undefined ? { subtitle: attributes.subtitle } : {}),
    ...(attributes.description !== undefined ? { description: attributes.description } : {}),
    ...(attributes.richDescription !== undefined ? { richDescription: attributes.richDescription } : {}),
    ...(attributes.seoTitle !== undefined ? { seoTitle: attributes.seoTitle } : {}),
    ...(attributes.seoDescription !== undefined ? { seoDescription: attributes.seoDescription } : {}),
  }))).returning();

  // Option types and values: two statements for the whole axis set, mapped back by name / value
  // rather than by row order, so the mapping does not depend on RETURNING preserving VALUES order.
  const optionTypeIds = new Map<string, string>();
  const optionValueIds = new Map<string, string>();
  const options = item.options ?? [];
  if (options.length > 0) {
    const typeRows = await sp.insert(optionTypes).values(options.map((option, index) => ({
      entityId,
      name: option.name,
      displayName: option.displayName ?? option.name,
      sortOrder: option.sortOrder ?? index,
    }))).returning({ id: optionTypes.id, name: optionTypes.name });
    for (const row of typeRows) optionTypeIds.set(row.name, row.id);
    const valueInputs = options.flatMap((option) => option.values.map((value, index) => ({
      optionTypeId: optionTypeIds.get(option.name) ?? "",
      value: value.value,
      displayValue: value.displayValue ?? value.value,
      sortOrder: value.sortOrder ?? index,
    })));
    if (valueInputs.length > 0) {
      const valueRows = await sp.insert(optionValues).values(valueInputs).returning({ id: optionValues.id, optionTypeId: optionValues.optionTypeId, value: optionValues.value });
      for (const row of valueRows) optionValueIds.set(`${row.optionTypeId}\u0000${row.value}`, row.id);
    }
  }

  const variantIds: Record<string, string> = {};
  if (item.variants.length > 0) {
    // `sortOrder` is the input index, which is also how the returned rows map back to their refs.
    const variantRows = await sp.insert(variants).values(item.variants.map((variant, index) => ({
      entityId,
      organizationId: orgId,
      sourceStoreId,
      sortOrder: index,
      metadata: variant.metadata ?? {},
      ...(variant.sku !== undefined ? { sku: variant.sku } : {}),
      ...(variant.barcode !== undefined ? { barcode: variant.barcode } : {}),
    }))).returning({ id: variants.id, sortOrder: variants.sortOrder });
    for (const row of variantRows) {
      const ref = item.variants[row.sortOrder]?.ref;
      if (ref === undefined) throw new Error(`Variant row ${row.sortOrder} has no input.`);
      variantIds[ref] = row.id;
    }
    const linkRows = item.variants.flatMap((variant) => Object.entries(variant.options ?? {}).map(([name, value]) => {
      const optionTypeId = optionTypeIds.get(name);
      const optionValueId = optionTypeId === undefined ? undefined : optionValueIds.get(`${optionTypeId}\u0000${value}`);
      const variantId = variantIds[variant.ref];
      if (optionValueId === undefined || variantId === undefined) throw new Error(`Variant "${variant.ref}" option "${name}=${value}" did not resolve after insert.`);
      return { variantId, optionValueId };
    }));
    if (linkRows.length > 0) await sp.insert(variantOptionValues).values(linkRows);
    const priceRows = item.variants.flatMap((variant) => (variant.prices ?? []).map((price) => {
      const variantId = variantIds[variant.ref];
      if (variantId === undefined) throw new Error(`Variant "${variant.ref}" did not resolve after insert.`);
      return {
        organizationId: orgId,
        entityId,
        variantId,
        currency: normaliseCurrency(price.currency),
        amount: price.amount,
        ...(price.compareAtAmount !== undefined ? { compareAtAmount: price.compareAtAmount } : {}),
      };
    }));
    if (priceRows.length > 0) await sp.insert(prices).values(priceRows);
  }

  const categoryLinks: Row[] = [];
  const categoryInputs = [...new Set(item.categories ?? [])].flatMap((slug, index) => {
    const category = taxonomy.categories.get(slug);
    if (!category) throw new Error(`Category "${slug}" was not resolved for the page.`);
    if (category.status === "archived") {
      warnings.push(`Skipped archived category "${slug}".`);
      return [];
    }
    return [{ entityId, categoryId: category.id, sortOrder: index }];
  });
  if (categoryInputs.length > 0) categoryLinks.push(...asRows(await sp.insert(entityCategories).values(categoryInputs).returning()));
  const brandLinks: Row[] = [];
  if (item.brand) {
    const brandId = taxonomy.brands.get(item.brand);
    if (brandId === undefined) throw new Error(`Brand "${item.brand}" was not resolved for the page.`);
    brandLinks.push(...asRows(await sp.insert(entityBrands).values([{ entityId, brandId, sortOrder: 0 }]).returning()));
  }
  const tagLinks: Row[] = [];
  const tagInputs = [...new Set(item.tags ?? [])].map((slug) => {
    const tagId = taxonomy.tags.get(slug);
    if (tagId === undefined) throw new Error(`Tag "${slug}" was not resolved for the page.`);
    return { entityId, tagId };
  });
  if (tagInputs.length > 0) tagLinks.push(...asRows(await sp.insert(entityTags).values(tagInputs).returning()));

  const ownedPaths = [...new Set(item.ownedFieldPaths ?? [])] as FieldPath[];
  if (ownedPaths.length > 0) {
    await sp.insert(catalogFieldOwnership).values(ownedPaths.map((fieldPath) => ({
      organizationId: orgId,
      entityId,
      storeId: sourceStoreId,
      fieldPath,
      owner: "store" as const,
    }))).onConflictDoNothing();
  }

  // The same shape `CatalogRepository.snapshotEntity` reads back with seven selects, built from the
  // rows this item just wrote. Media is empty by construction: the fast path attaches none.
  const snapshot: Snapshot = {
    entity: { ...entity },
    attributes: asRows(attributeRows).sort((a, b) => String(a.locale).localeCompare(String(b.locale)) || String(a.id).localeCompare(String(b.id))),
    customFields: [],
    media: [],
    categories: categoryLinks.sort(byKey("categoryId")),
    brands: brandLinks.sort(byKey("brandId")),
    tags: tagLinks.sort(byKey("tagId")),
  };
  return { entityId, variantIds, warnings, snapshot };
}

export class CatalogImportService {
  constructor(private readonly deps: CatalogServiceDeps) {}

  async importProducts(
    page: ImportProduct[],
    options: ImportProductsOptions,
    actor: Actor | null,
    ctx?: CatalogWriteContext,
  ): Promise<Result<ImportProductsReport>> {
    const errorPolicy = options.errorPolicy ?? "reject-failed-rows";
    const reason = options.reason ?? "import";
    let orgId: string;
    try {
      assertPermission(actor, "catalog:create");
      assertPermission(actor, "catalog:sync");
      orgId = resolveOrgIdForCommerce(actor, this.deps.config);
    } catch (error) {
      return Err(toCommerceError(error));
    }

    const rows: ImportProductRowResult[] = page.map((item) => failed(item.ref, "write-failed", "Not attempted."));
    const memoryFailures = validateInMemory(page);
    for (const [index, failure] of memoryFailures) {
      const item = page[index];
      if (item) rows[index] = failed(item.ref, failure.code, failure.error);
    }
    const rejectAll = (): ImportProductsReport => ({
      sourceStoreId: options.sourceStoreId,
      created: 0,
      failed: page.length,
      rows: rows.map((row) => (row.status === "failed" && row.code !== "write-failed" ? row : failed(row.ref, "rejected-by-policy", "Rejected: another row in the page failed."))),
    });
    if (errorPolicy === "reject-everything" && memoryFailures.size > 0) return Ok(rejectAll());

    try {
      const candidates = page.map((item, index) => ({ item, index })).filter(({ index }) => !memoryFailures.has(index));
      // The shared vocabulary is resolved in its OWN short transaction, never in the page's, and
      // never in a caller's (no ctx is passed on purpose). Inside the page transaction a newly
      // inserted tag's unique key stayed uncommitted for the whole page, so every other page naming
      // it — another store's, or this store's next one — waited on that index until this page
      // committed: 36.6 s behind one 89 s page on the sim, 2026-09-24. The cost is that a page
      // rejected afterwards can leave new vocabulary behind; it is organization-wide and reusable.
      const taxonomy = await this.withTransaction(actor, undefined, (txCtx) =>
        resolveTaxonomy(writerOf(txCtx), orgId, candidates.map(({ item }) => item)));

      const report = await this.withTransaction(actor, ctx, async (txCtx): Promise<ImportProductsReport> => {
        const tx = writerOf(txCtx);

        // Page-level reads: the slugs already taken, then the shared vocabulary.
        const slugs = candidates.map(({ item }) => item.slug);
        const taken = slugs.length === 0
          ? []
          : await tx.select({ slug: sellableEntities.slug }).from(sellableEntities)
            .where(and(eq(sellableEntities.organizationId, orgId), inArray(sellableEntities.slug, slugs)));
        const takenSlugs = new Set(taken.map((row) => row.slug));
        const writable: Array<{ item: ImportProduct; index: number }> = [];
        for (const candidate of candidates) {
          if (takenSlugs.has(candidate.item.slug)) {
            rows[candidate.index] = failed(candidate.item.ref, "slug-conflict", `Slug "${candidate.item.slug}" already exists in this organization.`);
          } else {
            writable.push(candidate);
          }
        }
        if (errorPolicy === "reject-everything" && writable.length < candidates.length) {
          throw new RejectEverything();
        }

        const written: Array<{ index: number; write: ItemWrite }> = [];
        for (const { item, index } of writable) {
          try {
            // Drizzle nests a transaction as a SAVEPOINT; a throw inside rolls back to it and the
            // page continues. That is what makes one poisoned item cost one item.
            const write = await tx.transaction((sp) => writeItem(sp, orgId, options.sourceStoreId, item, taxonomy));
            written.push({ index, write });
          } catch (error) {
            if (errorPolicy === "reject-everything") throw new RejectEverything();
            rows[index] = failed(item.ref, isUniqueViolation(error) ? "conflict" : "write-failed", describeWriteError(error));
          }
        }

        if (written.length > 0) {
          await tx.insert(sellableEntityRevisions).values(written.map(({ write }) => ({
            organizationId: orgId,
            entityId: write.entityId,
            revision: 1,
            pinned: true,
            snapshot: write.snapshot,
            reason,
            actorId: actor?.userId ?? null,
            actorType: actor?.type ?? null,
            requestId: txCtx.requestId,
          })));
        }
        for (const { index, write } of written) {
          const item = page[index];
          if (item) rows[index] = { ref: item.ref, status: "created", entityId: write.entityId, variantIds: write.variantIds, warnings: write.warnings };
        }
        const createdCount = written.length;
        return { sourceStoreId: options.sourceStoreId, created: createdCount, failed: page.length - createdCount, rows };
      });

      const afterHooks = this.deps.hooks.resolve("catalog.afterImport") as AfterHook<ImportProductsReport>[];
      if (afterHooks.length > 0) {
        const context = catalogHookContext(this.deps, actor, ctx, "import");
        await runAfterHooks(afterHooks, null, report, "custom", context, (hook) => this.deps.hooks.runsInTransaction(hook));
      }
      return Ok(report);
    } catch (error) {
      if (error instanceof RejectEverything) return Ok(rejectAll());
      return Err(toCommerceError(error));
    }
  }

  private async withTransaction<T>(
    actor: Actor | null,
    ctx: CatalogWriteContext | undefined,
    fn: (txCtx: TxContext) => Promise<T>,
  ): Promise<T> {
    if (isWriteContextTransactional(ctx)) return fn(ctx);
    const hookContext = resolveWriteContextHookContext(ctx);
    return this.deps.database.transaction(async (tx) => fn(createTxContext(tx, { actor, ...(hookContext ? { hookContext } : {}) })));
  }
}

/** Thrown inside the transaction to roll the whole page back under `reject-everything`. */
class RejectEverything extends Error {
  constructor() {
    super("Page rejected.");
    this.name = "RejectEverything";
  }
}
