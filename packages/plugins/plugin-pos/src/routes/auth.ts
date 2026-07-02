import { router } from "@porulle/core";
import { z } from "@hono/zod-openapi";
import type { PinService, PinAuthApi } from "../services/pin-service.js";
import type { PluginRouteRegistration } from "@porulle/core";

/**
 * PIN auth runtime (issue #51).
 *
 * - PUT /pos/auth/pin        — set/rotate an operator's PIN (pos:admin)
 * - POST /pos/auth/pin-login — operator PIN → short-lived per-shift API key.
 *   Authenticated by the terminal's device credential (pos:operate); the
 *   minted key is personal and carries pos:operate + shift/terminal metadata.
 * - POST /pos/auth/override  — manager PIN approves one elevated action.
 */
export function buildPinAuthRoutes(
  service: PinService,
  ctx: { services?: Record<string, unknown>; database?: { db: unknown }; auth?: unknown },
): PluginRouteRegistration[] {
  const r = router("POS Auth", "/pos/auth", ctx);

  r.put("/pin")
    .summary("Set or rotate an operator PIN")
    .permission("pos:admin")
    .input(z.object({
      operatorId: z.string().min(1),
      pin: z.string().regex(/^\d{4,8}$/, "PIN must be 4-8 digits"),
      canOverride: z.boolean().optional(),
    }))
    .handler(async ({ input, orgId }) => {
      const body = input as { operatorId: string; pin: string; canOverride?: boolean };
      const result = await service.setPin(orgId, body);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/pin-login")
    .summary("PIN login — mint a short-lived per-shift credential")
    .permission("pos:operate")
    .input(z.object({
      operatorId: z.string().min(1),
      pin: z.string().regex(/^\d{4,8}$/),
      shiftId: z.string().uuid().optional(),
    }))
    .handler(async ({ input, orgId }) => {
      const body = input as { operatorId: string; pin: string; shiftId?: string };
      const result = await service.pinLogin(orgId, body, ctx.auth as PinAuthApi | undefined);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/override")
    .summary("Manager override — approve one elevated action by PIN")
    .permission("pos:operate")
    .input(z.object({
      operatorId: z.string().min(1),
      pin: z.string().regex(/^\d{4,8}$/),
      action: z.string().min(1).max(200),
    }))
    .handler(async ({ input, orgId }) => {
      const body = input as { operatorId: string; pin: string; action: string };
      const result = await service.override(orgId, body);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  return r.routes();
}
