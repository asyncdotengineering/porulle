import { OpenAPIHono } from "@hono/zod-openapi";
import type { Kernel } from "../../../../runtime/kernel.js";
import type { Actor } from "../../../../auth/types.js";
import { assertPermission } from "../../../../auth/permissions.js";
import { resolveOrgId } from "../../../../auth/org.js";
import { CommerceValidationError } from "../../../../kernel/errors.js";
import type { CompensationFailure } from "../../../../kernel/compensation/schema.js";
import {
  listCompensationFailuresRoute,
  resolveCompensationFailureRoute,
} from "../../schemas/compensation-failures.js";
import { type AppEnv, mapErrorToResponse, mapErrorToStatus } from "../../utils.js";

function toIso(d: Date | null | undefined): string | null {
  if (d == null) return null;
  return d.toISOString();
}

function digestFailure(row: CompensationFailure): {
  id: string;
  organizationId: string;
  correlationId: string;
  chainName: string;
  stepName: string;
  originalError: { message: string; code?: string };
  compensationError: { message: string };
  occurredAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNotes: string | null;
} {
  return {
    id: row.id,
    organizationId: row.organizationId,
    correlationId: row.correlationId,
    chainName: row.chainName,
    stepName: row.stepName,
    originalError: {
      message: row.originalError.message,
      ...(row.originalError.code != null
        ? { code: row.originalError.code }
        : {}),
    },
    compensationError: {
      message: row.compensationError.message,
    },
    occurredAt:
      row.occurredAt instanceof Date
        ? row.occurredAt.toISOString()
        : String(row.occurredAt ?? ""),
    resolvedAt: toIso(row.resolvedAt ?? null),
    resolvedBy: row.resolvedBy ?? null,
    resolutionNotes: row.resolutionNotes ?? null,
  };
}

function parseResolvedFilter(
  raw: string | undefined,
): { ok: true; value: boolean | undefined } | { ok: false } {
  const v = raw ?? "false";
  if (v === "all") return { ok: true, value: undefined };
  if (v === "true") return { ok: true, value: true };
  if (v === "false") return { ok: true, value: false };
  return { ok: false };
}

export function compensationFailureAdminRoutes(kernel: Kernel) {
  const router = new OpenAPIHono<AppEnv>();

  // @ts-expect-error -- openapi handler union return type
  router.openapi(listCompensationFailuresRoute, async (c) => {
    const actor = c.get("actor");
    assertPermission(actor, "compensation:admin");
    const orgId = resolveOrgId(actor);
    const resolvedParsed = parseResolvedFilter(c.req.query("resolved"));
    if (!resolvedParsed.ok) {
      return c.json(
        mapErrorToResponse(
          new CommerceValidationError(
            'Query "resolved" must be true, false, or all.',
          ),
        ),
        422,
      );
    }
    const limitRaw = c.req.query("limit");
    const offsetRaw = c.req.query("offset");
    const limitParsed = limitRaw != null ? Number(limitRaw) : 50;
    const offsetParsed = offsetRaw != null ? Number(offsetRaw) : 0;
    const limit = Math.min(
      200,
      Math.max(1, Number.isFinite(limitParsed) ? limitParsed : 50),
    );
    const offset = Math.max(0, Number.isFinite(offsetParsed) ? offsetParsed : 0);

    const listed = await kernel.services.compensationFailures.list({
      organizationId: orgId,
      limit,
      offset,
      ...(resolvedParsed.value !== undefined
        ? { resolved: resolvedParsed.value }
        : {}),
    });
    if (!listed.ok) {
      return c.json(mapErrorToResponse(listed.error), mapErrorToStatus(listed.error));
    }
    return c.json({
      items: listed.value.items.map(digestFailure),
      total: listed.value.total,
      limit,
      offset,
    });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(resolveCompensationFailureRoute, async (c) => {
    const actor = c.get("actor");
    assertPermission(actor, "compensation:admin");
    const orgId = resolveOrgId(actor);
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const found = await kernel.services.compensationFailures.findById(id);
    if (!found.ok) {
      return c.json(mapErrorToResponse(found.error), mapErrorToStatus(found.error));
    }
    const row = found.value;
    if (!row) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Compensation failure not found." } },
        404,
      );
    }
    if (row.organizationId !== orgId) {
      return c.json(
        { error: { code: "FORBIDDEN", message: "Compensation failure belongs to another organization." } },
        403,
      );
    }
    if (row.resolvedAt != null) {
      return c.json(
        { error: { code: "CONFLICT", message: "Compensation failure is already resolved." } },
        409,
      );
    }

    const resolved = await kernel.services.compensationFailures.markResolved({
      id,
      organizationId: orgId,
      resolvedBy: (actor as Actor).userId,
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
    });
    if (!resolved.ok) {
      return c.json(mapErrorToResponse(resolved.error), mapErrorToStatus(resolved.error));
    }
    return c.json({ failure: digestFailure(resolved.value) });
  });

  return router;
}
