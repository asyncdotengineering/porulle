import { router } from "@porulle/core";
import { z } from "@hono/zod-openapi";
import type { TerminalService } from "../services/terminal-service.js";
import type { PluginRouteRegistration } from "@porulle/core";

export function buildTerminalRoutes(
  service: TerminalService,
  ctx: { services?: Record<string, unknown>; database?: { db: unknown } },
): PluginRouteRegistration[] {
  const r = router("POS Terminals", "/pos/terminals", ctx);

  r.post("/")
    .summary("Register terminal")
    .permission("pos:admin")
    .input(z.object({
      name: z.string().min(1).max(100),
      code: z.string().min(1).max(20),
      type: z.enum(["register", "tablet", "mobile", "kiosk"]).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }))
    .handler(async ({ input, orgId }) => {
      const body = input as { name: string; code: string; type?: "register" | "tablet" | "mobile" | "kiosk"; metadata?: Record<string, unknown> };
      const result = await service.create(orgId, body);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/")
    .summary("List terminals")
    .permission("pos:admin")
    .handler(async ({ orgId }) => {
      const result = await service.list(orgId);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.patch("/{id}")
    .summary("Update terminal")
    .permission("pos:admin")
    .input(z.object({
      name: z.string().min(1).max(100).optional(),
      isActive: z.boolean().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }))
    .handler(async ({ params, input, orgId }) => {
      const body = input as { name?: string; isActive?: boolean; metadata?: Record<string, unknown> };
      const result = await service.update(orgId, params.id!, body);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.delete("/{id}")
    .summary("Deactivate terminal")
    .permission("pos:admin")
    .handler(async ({ params, orgId }) => {
      const result = await service.deactivate(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  return r.routes();
}
