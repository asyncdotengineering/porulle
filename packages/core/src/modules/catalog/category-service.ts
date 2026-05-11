import { resolveOrgId } from "../../auth/org.js";
import { assertPermission } from "../../auth/permissions.js";
import type { Actor } from "../../auth/types.js";
import {
  CommerceConflictError,
  CommerceNotFoundError,
  toCommerceError,
} from "../../kernel/errors.js";
import { Err, Ok, type Result } from "../../kernel/result.js";
import type { TxContext } from "../../kernel/database/tx-context.js";
import type {
  CatalogServiceDeps,
  CategorySummary,
  CreateCategoryInput,
  UpdateCategoryInput,
} from "./service.js";
export class CategoryService {
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

  async listCategories(ctx?: TxContext): Promise<Result<CategorySummary[]>> {
    const allCategories = await this.repo.findAllCategories(resolveOrgId(ctx?.actor ?? null), ctx);
    const sorted = allCategories.sort((a, b) => a.sortOrder - b.sortOrder || a.slug.localeCompare(b.slug));
    return Ok(sorted.map((c) => ({ id: c.id, parentId: c.parentId, slug: c.slug, sortOrder: c.sortOrder, metadata: c.metadata ?? {} })));
  }

  async createCategory(input: CreateCategoryInput, actor: Actor | null, ctx?: TxContext): Promise<Result<CategorySummary>> {
    assertPermission(actor, "catalog:update");
    if (input.id) {
      const existingById = await this.repo.findCategoryById(input.id, ctx);
      if (existingById) return Err(new CommerceConflictError(`Category with id ${input.id} already exists.`));
    }
    const orgId = resolveOrgId(actor);
    const existingBySlug = await this.repo.findCategoryBySlug(orgId, input.slug, ctx);
    if (existingBySlug) return Err(new CommerceConflictError(`Category with slug ${input.slug} already exists.`));
    const category = await this.repo.createCategory({ organizationId: orgId, ...(input.id ? { id: input.id } : {}), slug: input.slug, sortOrder: input.sortOrder ?? 0, metadata: input.metadata ?? {}, ...(input.parentId !== undefined ? { parentId: input.parentId } : {}) }, ctx);
    return Ok({ id: category.id, parentId: category.parentId, slug: category.slug, sortOrder: category.sortOrder, metadata: category.metadata ?? {} });
  }

  async updateCategory(id: string, input: UpdateCategoryInput, actor: Actor | null, ctx?: TxContext): Promise<Result<CategorySummary>> {
    assertPermission(actor, "catalog:update");
    const existing = await this.repo.findCategoryById(id, ctx);
    if (!existing) return Err(new CommerceNotFoundError("Category not found."));
    try { this.assertSameOrg(existing, actor); } catch (error) { return Err(toCommerceError(error)); }
    if (input.slug) {
      const existingBySlug = await this.repo.findCategoryBySlug(resolveOrgId(actor), input.slug, ctx);
      if (existingBySlug && existingBySlug.id !== id) return Err(new CommerceConflictError(`Category with slug ${input.slug} already exists.`));
    }
    const updated = await this.repo.updateCategory(id, { ...(input.slug !== undefined ? { slug: input.slug } : {}), ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}), ...(input.metadata !== undefined ? { metadata: input.metadata } : {}), ...(input.parentId !== undefined ? { parentId: input.parentId } : {}) }, ctx);
    if (!updated) return Err(new CommerceNotFoundError("Category not found."));
    return Ok({ id: updated.id, parentId: updated.parentId, slug: updated.slug, sortOrder: updated.sortOrder, metadata: updated.metadata ?? {} });
  }

  async deleteCategory(id: string, actor: Actor | null, ctx?: TxContext): Promise<Result<void>> {
    assertPermission(actor, "catalog:update");
    const existing = await this.repo.findCategoryById(id, ctx);
    if (!existing) return Err(new CommerceNotFoundError("Category not found."));
    try { this.assertSameOrg(existing, actor); } catch (error) { return Err(toCommerceError(error)); }
    await this.repo.deleteEntityCategoriesByCategoryId(id, ctx);
    await this.repo.deleteCategory(id, ctx);
    return Ok(undefined);
  }

  async addToCategory(entityId: string, categoryId: string, actor: Actor | null, ctx?: TxContext): Promise<Result<void>> {
    try { assertPermission(actor, "catalog:update"); } catch (error) { return Err(toCommerceError(error)); }
    const entity = await this.deps.repository.findEntityById(entityId, ctx);
    if (!entity) return Err(new CommerceNotFoundError("Entity not found."));
    try { this.assertSameOrg(entity, actor); } catch (error) { return Err(toCommerceError(error)); }
    const addCatOrgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(categoryId);
    let category = isUuid ? await this.repo.findCategoryById(categoryId, ctx) : null;
    if (!category) category = await this.repo.findCategoryBySlug(addCatOrgId, categoryId, ctx);
    if (!category) {
      category = await this.repo.createCategory({ organizationId: addCatOrgId, slug: categoryId, sortOrder: 0, metadata: {} }, ctx);
    }
    await this.repo.addEntityToCategory(entityId, category.id, 0, ctx);
    return Ok(undefined);
  }

  async removeFromCategory(entityId: string, categoryId: string, actor: Actor | null, ctx?: TxContext): Promise<Result<void>> {
    try { assertPermission(actor, "catalog:update"); } catch (error) { return Err(toCommerceError(error)); }
    const entity = await this.deps.repository.findEntityById(entityId, ctx);
    if (!entity) return Err(new CommerceNotFoundError("Entity not found."));
    try { this.assertSameOrg(entity, actor); } catch (error) { return Err(toCommerceError(error)); }
    const isCatUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(categoryId);
    let category = isCatUuid ? await this.repo.findCategoryById(categoryId, ctx) : null;
    if (!category) category = await this.repo.findCategoryBySlug(resolveOrgId(actor ?? ctx?.actor ?? null), categoryId, ctx);
    const removed = await this.repo.removeEntityFromCategory(entityId, category?.id ?? categoryId, ctx);
    if (!removed) return Err(new CommerceNotFoundError("Category assignment not found."));
    return Ok(undefined);
  }
}
