import { router } from "@porulle/core";
import { z } from "@hono/zod-openapi";
import type { ModifierService } from "../services/modifier-service.js";
import type { PluginRouteRegistration } from "@porulle/core";

export function buildModifierRoutes(
  service: ModifierService,
  ctx: { services?: Record<string, unknown>; database?: { db: unknown } },
): PluginRouteRegistration[] {
  const r = router("POS Restaurant Modifiers", "/pos/restaurant/modifier-groups", ctx);

  r.post("/")
    .summary("Create modifier group")
    .permission("pos-restaurant:admin")
    .input(z.object({
      name: z.string().min(1).max(200),
      entityId: z.string().uuid().optional(),
      itemGroup: z.string().optional(),
      isRequired: z.boolean().optional(),
      minSelect: z.number().int().min(0).optional(),
      maxSelect: z.number().int().min(1).optional(),
      sortOrder: z.number().int().optional(),
    }))
    .handler(async ({ input, orgId }) => {
      const body = input as { name: string; entityId?: string; itemGroup?: string; isRequired?: boolean; minSelect?: number; maxSelect?: number; sortOrder?: number };
      const result = await service.createGroup(orgId, body);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/")
    .summary("List modifier groups")
    .permission("pos:operate")
    .query(z.object({ entityId: z.string().uuid().optional() }))
    .handler(async ({ query, orgId }) => {
      const q = query as { entityId?: string };
      const result = await service.listGroups(orgId, q.entityId);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/{id}")
    .summary("Get modifier group with options")
    .permission("pos:operate")
    .handler(async ({ params, orgId }) => {
      const result = await service.getGroupWithOptions(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.patch("/{id}")
    .summary("Update modifier group")
    .permission("pos-restaurant:admin")
    .input(z.object({
      name: z.string().min(1).max(200).optional(),
      isRequired: z.boolean().optional(),
      minSelect: z.number().int().min(0).optional(),
      maxSelect: z.number().int().min(1).optional(),
      sortOrder: z.number().int().optional(),
    }))
    .handler(async ({ params, input, orgId }) => {
      const body = input as { name?: string; isRequired?: boolean; minSelect?: number; maxSelect?: number; sortOrder?: number };
      const result = await service.updateGroup(orgId, params.id!, body);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.delete("/{id}")
    .summary("Delete modifier group")
    .permission("pos-restaurant:admin")
    .handler(async ({ params, orgId }) => {
      const result = await service.deleteGroup(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/{id}/options")
    .summary("Add modifier option")
    .permission("pos-restaurant:admin")
    .input(z.object({
      name: z.string().min(1).max(200),
      priceAdjustment: z.number().int().optional(),
      isDefault: z.boolean().optional(),
      sortOrder: z.number().int().optional(),
    }))
    .handler(async ({ params, input }) => {
      const body = input as { name: string; priceAdjustment?: number; isDefault?: boolean; sortOrder?: number };
      const result = await service.addOption(params.id!, body);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  return r.routes();
}

export function buildModifierOptionRoutes(
  service: ModifierService,
  ctx: { services?: Record<string, unknown>; database?: { db: unknown } },
): PluginRouteRegistration[] {
  const r = router("POS Restaurant Modifier Options", "/pos/restaurant/modifier-options", ctx);

  r.patch("/{id}")
    .summary("Update modifier option")
    .permission("pos-restaurant:admin")
    .input(z.object({
      name: z.string().min(1).max(200).optional(),
      priceAdjustment: z.number().int().optional(),
      isDefault: z.boolean().optional(),
      isAvailable: z.boolean().optional(),
      sortOrder: z.number().int().optional(),
    }))
    .handler(async ({ params, input }) => {
      const body = input as { name?: string; priceAdjustment?: number; isDefault?: boolean; isAvailable?: boolean; sortOrder?: number };
      const result = await service.updateOption(params.id!, body);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.delete("/{id}")
    .summary("Delete modifier option")
    .permission("pos-restaurant:admin")
    .handler(async ({ params }) => {
      const result = await service.deleteOption(params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  return r.routes();
}
