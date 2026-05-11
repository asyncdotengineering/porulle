/**
 * Operational routes: checklists, alerts, recipes, combos, menu availability,
 * analytics, customer favorites.
 */

import { router } from "@porulle/core";
import { z } from "@hono/zod-openapi";
import type { ChecklistService } from "../services/checklist-service.js";
import type { AlertService } from "../services/alert-service.js";
import type { RecipeService } from "../services/recipe-service.js";
import type { RestaurantAnalyticsService } from "../services/analytics-service.js";
import type { PluginRouteRegistration } from "@porulle/core";

export function buildChecklistRoutes(
  service: ChecklistService,
  ctx: { services?: Record<string, unknown>; database?: { db: unknown } },
): PluginRouteRegistration[] {
  const r = router("POS Restaurant Checklists", "/pos/restaurant/checklists", ctx);

  r.post("/")
    .summary("Create checklist")
    .permission("pos-restaurant:admin")
    .input(z.object({
      name: z.string().min(1),
      type: z.enum(["pre_billing", "shift_open", "shift_close"]),
      items: z.array(z.object({ label: z.string().min(1), isRequired: z.boolean().optional() })).min(1),
    }))
    .handler(async ({ input, orgId }) => {
      const body = input as { name: string; type: "pre_billing" | "shift_open" | "shift_close"; items: Array<{ label: string; isRequired?: boolean }> };
      const result = await service.createChecklist(orgId, body);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/")
    .summary("List checklists")
    .permission("pos:operate")
    .query(z.object({ type: z.enum(["pre_billing", "shift_open", "shift_close"]).optional() }))
    .handler(async ({ query, orgId }) => {
      const q = query as { type?: "pre_billing" | "shift_open" | "shift_close" };
      const result = await service.listChecklists(orgId, q.type);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/{id}")
    .summary("Get checklist with items")
    .permission("pos:operate")
    .handler(async ({ params, orgId }) => {
      const result = await service.getChecklistWithItems(params.id!, orgId);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/{id}/complete")
    .summary("Complete a checklist")
    .permission("pos:operate")
    .input(z.object({
      referenceType: z.enum(["transaction", "shift"]),
      referenceId: z.string().uuid(),
      completedItems: z.array(z.object({
        itemId: z.string().uuid(),
        checked: z.boolean(),
        note: z.string().optional(),
      })),
    }))
    .handler(async ({ params, input, actor }) => {
      const body = input as { referenceType: "transaction" | "shift"; referenceId: string; completedItems: Array<{ itemId: string; checked: boolean; note?: string }> };
      const result = await service.completeChecklist({
        checklistId: params.id!,
        ...body,
        operatorId: actor!.userId,
      });

      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  return r.routes();
}

export function buildAlertRoutes(
  service: AlertService,
  ctx: { services?: Record<string, unknown>; database?: { db: unknown } },
): PluginRouteRegistration[] {
  const r = router("POS Restaurant Alerts", "/pos/restaurant/alerts", ctx);

  r.get("/")
    .summary("List active alerts")
    .permission("pos:operate")
    .query(z.object({
      type: z.string().optional(),
      unresolvedOnly: z.string().optional(),
    }))
    .handler(async ({ query, orgId }) => {
      const q = query as { type?: string; unresolvedOnly?: string };
      const result = await service.listAlerts(orgId, {
        type: q.type as Parameters<typeof service.listAlerts>[1] extends { type?: infer T } ? T : never,
        unresolvedOnly: q.unresolvedOnly === "true",
      });
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/detect")
    .summary("Run alert detection scan")
    .permission("pos-restaurant:admin")
    .handler(async ({ orgId }) => {
      const result = await service.runAllDetections(orgId);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/{id}/resolve")
    .summary("Resolve an alert")
    .permission("pos:operate")
    .handler(async ({ params, actor }) => {
      const result = await service.resolveAlert(params.id!, actor!.userId);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/config")
    .summary("Set alert threshold")
    .permission("pos-restaurant:admin")
    .input(z.object({
      alertType: z.string().min(1),
      thresholdMinutes: z.number().int().min(1),
      notifyRoles: z.array(z.string()).optional(),
    }))
    .handler(async ({ input, orgId }) => {
      const body = input as { alertType: string; thresholdMinutes: number; notifyRoles?: string[] };
      const result = await service.setThreshold(orgId, body.alertType, body.thresholdMinutes, body.notifyRoles);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/config")
    .summary("Get alert configuration")
    .permission("pos-restaurant:admin")
    .handler(async ({ orgId }) => {
      const result = await service.getConfig(orgId);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  return r.routes();
}

export function buildRecipeRoutes(
  service: RecipeService,
  ctx: { services?: Record<string, unknown>; database?: { db: unknown } },
): PluginRouteRegistration[] {
  const r = router("POS Restaurant Recipes", "/pos/restaurant/recipes", ctx);

  r.post("/")
    .summary("Create recipe (BOM)")
    .permission("pos-restaurant:admin")
    .input(z.object({
      entityId: z.string().uuid(),
      name: z.string().min(1),
      yieldQuantity: z.number().int().min(1).optional(),
      ingredients: z.array(z.object({
        ingredientName: z.string().min(1),
        quantity: z.number().int().positive(),
        unit: z.string().min(1),
        costPerUnit: z.number().int().min(0),
      })).min(1),
    }))
    .handler(async ({ input, orgId }) => {
      const body = input as { entityId: string; name: string; yieldQuantity?: number; ingredients: Array<{ ingredientName: string; quantity: number; unit: string; costPerUnit: number }> };
      const result = await service.createRecipe(orgId, body);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/")
    .summary("List recipes")
    .permission("pos-restaurant:admin")
    .handler(async ({ orgId }) => {
      const result = await service.listRecipes(orgId);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/{id}")
    .summary("Get recipe with ingredients")
    .permission("pos-restaurant:admin")
    .handler(async ({ params }) => {
      const result = await service.getRecipeWithIngredients(params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  return r.routes();
}

export function buildAnalyticsRoutes(
  service: RestaurantAnalyticsService,
  ctx: { services?: Record<string, unknown>; database?: { db: unknown } },
): PluginRouteRegistration[] {
  const r = router("POS Restaurant Analytics", "/pos/restaurant/analytics", ctx);

  r.post("/daily-pnl")
    .summary("Create daily P&L")
    .permission("pos-restaurant:admin")
    .input(z.object({
      date: z.string(),
      grossSales: z.number().int(),
      netSales: z.number().int(),
      costOfGoods: z.number().int(),
      directExpenses: z.number().int(),
      indirectExpenses: z.number().int(),
      employeeCosts: z.number().int(),
      transactionCount: z.number().int(),
      expenses: z.array(z.object({
        category: z.enum(["cogs", "direct", "indirect", "employee"]),
        name: z.string(),
        amount: z.number().int(),
        percentage: z.number().int().optional(),
      })).optional(),
    }))
    .handler(async ({ input, orgId }) => {
      const body = input as { date: string; grossSales: number; netSales: number; costOfGoods: number; directExpenses: number; indirectExpenses: number; employeeCosts: number; transactionCount: number; expenses?: Array<{ category: "cogs" | "direct" | "indirect" | "employee"; name: string; amount: number; percentage?: number }> };
      const result = await service.createDailyPnl(orgId, {
        ...body,
        date: new Date(body.date),
      });
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/daily-pnl")
    .summary("List daily P&L records")
    .permission("pos-restaurant:admin")
    .handler(async ({ orgId }) => {
      const result = await service.listDailyPnl(orgId);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/station-performance/{id}")
    .summary("Station performance metrics")
    .permission("pos-restaurant:admin")
    .query(z.object({ from: z.string(), to: z.string() }))
    .handler(async ({ params, query, orgId }) => {
      const q = query as { from: string; to: string };
      const result = await service.getStationPerformance(orgId, params.id!, new Date(q.from), new Date(q.to));
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/course-performance")
    .summary("Course-wise performance")
    .permission("pos-restaurant:admin")
    .query(z.object({ from: z.string(), to: z.string() }))
    .handler(async ({ query, orgId }) => {
      const q = query as { from: string; to: string };
      const result = await service.getCoursePerformance(orgId, new Date(q.from), new Date(q.to));
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/operator-performance")
    .summary("Staff/captain performance")
    .permission("pos-restaurant:admin")
    .query(z.object({ from: z.string(), to: z.string() }))
    .handler(async ({ query, orgId }) => {
      const q = query as { from: string; to: string };
      const result = await service.getOperatorPerformance(orgId, new Date(q.from), new Date(q.to));
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  return r.routes();
}
