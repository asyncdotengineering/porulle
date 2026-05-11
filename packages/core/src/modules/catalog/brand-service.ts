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
  CreateBrandInput,
  UpdateBrandInput,
} from "./service.js";
import type { Brand } from "./repository/index.js";
export class BrandService {
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

  async listBrands(ctx?: TxContext): Promise<Result<Brand[]>> {
    const allBrands = await this.repo.findAllBrands(resolveOrgId(ctx?.actor ?? null), ctx);
    return Ok(allBrands.sort((a, b) => a.displayName.localeCompare(b.displayName)));
  }

  async createBrand(input: CreateBrandInput, actor: Actor | null, ctx?: TxContext): Promise<Result<Brand>> {
    assertPermission(actor, "catalog:update");
    if (input.id) {
      const existingById = await this.repo.findBrandById(input.id, ctx);
      if (existingById) return Err(new CommerceConflictError(`Brand with id ${input.id} already exists.`));
    }
    const orgId = resolveOrgId(actor);
    const existingBySlug = await this.repo.findBrandBySlug(orgId, input.slug, ctx);
    if (existingBySlug) return Err(new CommerceConflictError(`Brand with slug ${input.slug} already exists.`));
    return Ok(await this.repo.createBrand({ organizationId: orgId, ...(input.id ? { id: input.id } : {}), slug: input.slug, displayName: input.displayName, metadata: input.metadata ?? {} }, ctx));
  }

  async updateBrand(id: string, input: UpdateBrandInput, actor: Actor | null, ctx?: TxContext): Promise<Result<Brand>> {
    assertPermission(actor, "catalog:update");
    const existing = await this.repo.findBrandById(id, ctx);
    if (!existing) return Err(new CommerceNotFoundError("Brand not found."));
    try { this.assertSameOrg(existing, actor); } catch (error) { return Err(toCommerceError(error)); }
    if (input.slug) {
      const existingBySlug = await this.repo.findBrandBySlug(resolveOrgId(actor), input.slug, ctx);
      if (existingBySlug && existingBySlug.id !== id) return Err(new CommerceConflictError(`Brand with slug ${input.slug} already exists.`));
    }
    const updated = await this.repo.updateBrand(id, { ...(input.slug !== undefined ? { slug: input.slug } : {}), ...(input.displayName !== undefined ? { displayName: input.displayName } : {}), ...(input.metadata !== undefined ? { metadata: input.metadata } : {}) }, ctx);
    if (!updated) return Err(new CommerceNotFoundError("Brand not found."));
    return Ok(updated);
  }

  async deleteBrand(id: string, actor: Actor | null, ctx?: TxContext): Promise<Result<void>> {
    assertPermission(actor, "catalog:update");
    const existing = await this.repo.findBrandById(id, ctx);
    if (!existing) return Err(new CommerceNotFoundError("Brand not found."));
    try { this.assertSameOrg(existing, actor); } catch (error) { return Err(toCommerceError(error)); }
    await this.repo.deleteEntityBrandsByBrandId(id, ctx);
    await this.repo.deleteBrand(id, ctx);
    return Ok(undefined);
  }

  async addToBrand(entityId: string, brandId: string, actor: Actor | null, ctx?: TxContext): Promise<Result<void>> {
    try { assertPermission(actor, "catalog:update"); } catch (error) { return Err(toCommerceError(error)); }
    const entity = await this.deps.repository.findEntityById(entityId, ctx);
    if (!entity) return Err(new CommerceNotFoundError("Entity not found."));
    try { this.assertSameOrg(entity, actor); } catch (error) { return Err(toCommerceError(error)); }
    const addBrandOrgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const isBrandUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(brandId);
    let brand = isBrandUuid ? await this.repo.findBrandById(brandId, ctx) : null;
    if (!brand) brand = await this.repo.findBrandBySlug(addBrandOrgId, brandId, ctx);
    if (!brand) {
      brand = await this.repo.createBrand({ organizationId: addBrandOrgId, slug: brandId, displayName: brandId, metadata: {} }, ctx);
    }
    await this.repo.addEntityToBrand(entityId, brand.id, 0, ctx);
    return Ok(undefined);
  }

  async removeFromBrand(entityId: string, brandId: string, actor: Actor | null, ctx?: TxContext): Promise<Result<void>> {
    try { assertPermission(actor, "catalog:update"); } catch (error) { return Err(toCommerceError(error)); }
    const entity = await this.deps.repository.findEntityById(entityId, ctx);
    if (!entity) return Err(new CommerceNotFoundError("Entity not found."));
    try { this.assertSameOrg(entity, actor); } catch (error) { return Err(toCommerceError(error)); }
    const isBrUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(brandId);
    let brand = isBrUuid ? await this.repo.findBrandById(brandId, ctx) : null;
    if (!brand) brand = await this.repo.findBrandBySlug(resolveOrgId(actor ?? ctx?.actor ?? null), brandId, ctx);
    const removed = await this.repo.removeEntityFromBrand(entityId, brand?.id ?? brandId, ctx);
    if (!removed) return Err(new CommerceNotFoundError("Brand assignment not found."));
    return Ok(undefined);
  }
}
