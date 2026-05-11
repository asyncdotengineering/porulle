/**
 * Supplier info routes — demonstrates querying extended core table columns.
 *
 * Uses the extendedSellableEntities table which adds supplier_code and
 * country_of_origin to sellable_entities alongside the core column set.
 *
 * SECURITY: PUT requires `catalog:update`; both PUT and GET are scoped to
 * the actor's organizationId. Without these guards (and without the org
 * filter on the WHERE clause), any tenant could write to any other
 * tenant's supplier metadata by entity UUID — same class as the catalog
 * cross-tenant CRITICAL-2 fix.
 */

import type { Hono } from "hono";
import { and, eq } from "@porulle/core/drizzle";
import { extendedSellableEntities } from "../plugins/extended-catalog-schema.js";
import type { PostgresJsDatabase } from "@porulle/core/drizzle";

interface RouteActor {
  type?: string;
  userId?: string;
  organizationId?: string | null;
  role?: string;
  permissions?: string[];
}

function db(raw: unknown): PostgresJsDatabase<Record<string, unknown>> {
  return raw as PostgresJsDatabase<Record<string, unknown>>;
}

function getActor(c: unknown): RouteActor | null {
  const ctx = c as { var?: { actor?: RouteActor | null } };
  return ctx.var?.actor ?? null;
}

function hasPerm(actor: RouteActor | null, required: string): boolean {
  if (!actor) return false;
  const perms = actor.permissions ?? [];
  if (perms.includes("*:*")) return true;
  const [resource] = required.split(":");
  if (resource && perms.includes(`${resource}:*`)) return true;
  return perms.includes(required);
}

export function supplierInfoRoutes(app: Hono, kernel: unknown) {
  const k = kernel as {
    database: { db: unknown };
    services: { catalog: unknown };
  };

  // PUT /api/catalog/entities/:id/supplier — set supplier info
  app.put("/api/catalog/entities/:id/supplier", async (c) => {
    const actor = getActor(c);
    if (!actor) {
      return c.json({ error: { code: "UNAUTHENTICATED", message: "Login required." } }, 401);
    }
    if (!hasPerm(actor, "catalog:update")) {
      return c.json({ error: { code: "FORBIDDEN", message: "Permission 'catalog:update' is required." } }, 403);
    }

    const entityId = c.req.param("id");
    const body = await c.req.json();
    const drizzle = db(k.database.db);
    const orgId = actor.organizationId;

    if (!orgId) {
      return c.json({ error: { code: "FORBIDDEN", message: "Actor has no organization." } }, 403);
    }

    const [updated] = await drizzle
      .update(extendedSellableEntities)
      .set({
        supplierCode: body.supplierCode ?? null,
        countryOfOrigin: body.countryOfOrigin ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(extendedSellableEntities.id, entityId),
          eq(extendedSellableEntities.organizationId, orgId),
        ),
      )
      .returning({
        id: extendedSellableEntities.id,
        slug: extendedSellableEntities.slug,
        supplierCode: extendedSellableEntities.supplierCode!,
        countryOfOrigin: extendedSellableEntities.countryOfOrigin!,
      });

    if (!updated) {
      return c.json({ error: { code: "NOT_FOUND", message: "Entity not found" } }, 404);
    }

    return c.json({ data: updated });
  });

  // GET /api/catalog/entities/:id/supplier — get supplier info (scoped to actor's org)
  app.get("/api/catalog/entities/:id/supplier", async (c) => {
    const actor = getActor(c);
    if (!actor) {
      return c.json({ error: { code: "UNAUTHENTICATED", message: "Login required." } }, 401);
    }
    if (!hasPerm(actor, "catalog:read")) {
      return c.json({ error: { code: "FORBIDDEN", message: "Permission 'catalog:read' is required." } }, 403);
    }

    const entityId = c.req.param("id");
    const drizzle = db(k.database.db);
    const orgId = actor.organizationId;

    if (!orgId) {
      return c.json({ error: { code: "FORBIDDEN", message: "Actor has no organization." } }, 403);
    }

    const [row] = await drizzle
      .select({
        id: extendedSellableEntities.id,
        slug: extendedSellableEntities.slug,
        supplierCode: extendedSellableEntities.supplierCode!,
        countryOfOrigin: extendedSellableEntities.countryOfOrigin!,
      })
      .from(extendedSellableEntities)
      .where(
        and(
          eq(extendedSellableEntities.id, entityId),
          eq(extendedSellableEntities.organizationId, orgId),
        ),
      );

    if (!row) {
      return c.json({ error: { code: "NOT_FOUND", message: "Entity not found" } }, 404);
    }

    return c.json({ data: row });
  });
}
