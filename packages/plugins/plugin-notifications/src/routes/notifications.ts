import { router } from "@porulle/core";
import { z } from "@hono/zod-openapi";
import type { NotificationService } from "../services/notification-service.js";
import type { PreferenceService } from "../services/preference-service.js";
import type { PrintService } from "../services/print-service.js";
import type { PluginRouteRegistration } from "@porulle/core";

export function buildNotificationRoutes(
  notifService: NotificationService,
  prefService: PreferenceService,
  printService: PrintService,
  ctx: { services?: Record<string, unknown>; database?: { db: unknown } },
): PluginRouteRegistration[] {
  // ── Template Routes ────────────────────────────────────────────────
  const tmpl = router("Notification Templates", "/notifications/templates", ctx);

  tmpl.post("/").summary("Create notification template").permission("notifications:admin")
    .input(z.object({
      event: z.string().min(1),
      channel: z.enum(["email", "sms", "push", "print"]),
      subject: z.string().optional(),
      bodyTemplate: z.string().min(1),
    }))
    .handler(async ({ input, orgId }) => {
      const body = input as { event: string; channel: "email" | "sms" | "push" | "print"; subject?: string; bodyTemplate: string };
      const result = await notifService.createTemplate(orgId, body);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  tmpl.get("/").summary("List notification templates").permission("notifications:admin")
    .query(z.object({
      event: z.string().optional(),
      channel: z.enum(["email", "sms", "push", "print"]).optional(),
    }))
    .handler(async ({ query, orgId }) => {
      const q = query as { event?: string; channel?: "email" | "sms" | "push" | "print" };
      const result = await notifService.listTemplates(orgId, q);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  tmpl.get("/{id}").summary("Get notification template").permission("notifications:admin")
    .handler(async ({ params, orgId }) => {
      const result = await notifService.getTemplate(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  tmpl.patch("/{id}").summary("Update notification template").permission("notifications:admin")
    .input(z.object({
      subject: z.string().optional(),
      bodyTemplate: z.string().optional(),
      isActive: z.boolean().optional(),
    }))
    .handler(async ({ params, input, orgId }) => {
      const body = input as { subject?: string; bodyTemplate?: string; isActive?: boolean };
      const result = await notifService.updateTemplate(orgId, params.id!, body);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  tmpl.delete("/{id}").summary("Soft-delete notification template").permission("notifications:admin")
    .handler(async ({ params, orgId }) => {
      const result = await notifService.deleteTemplate(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  // ── Send Route ─────────────────────────────────────────────────────
  const send = router("Notifications", "/notifications", ctx);

  send.post("/send").summary("Send notification").permission("notifications:admin")
    .input(z.object({
      event: z.string().min(1),
      recipient: z.string().min(1),
      channel: z.enum(["email", "sms", "push", "print"]),
      customerId: z.string().uuid().optional(),
      data: z.record(z.string(), z.unknown()).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }))
    .handler(async ({ input, orgId }) => {
      const body = input as {
        event: string; recipient: string; channel: "email" | "sms" | "push" | "print";
        customerId?: string; data?: Record<string, unknown>; metadata?: Record<string, unknown>;
      };
      const result = await notifService.send(orgId, body);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  // ── Log Route ──────────────────────────────────────────────────────
  send.get("/log").summary("Query notification log").permission("notifications:admin")
    .query(z.object({
      channel: z.string().optional(),
      event: z.string().optional(),
      status: z.enum(["queued", "sent", "delivered", "failed"]).optional(),
      limit: z.coerce.number().int().positive().optional(),
    }))
    .handler(async ({ query, orgId }) => {
      const q = query as { channel?: string; event?: string; status?: "queued" | "sent" | "delivered" | "failed"; limit?: number };
      const result = await notifService.listLog(orgId, q);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  // ── Preference Routes ──────────────────────────────────────────────
  const pref = router("Notification Preferences", "/notifications/preferences", ctx);

  pref.post("/").summary("Set customer notification preference").permission("notifications:write")
    .input(z.object({
      customerId: z.string().uuid(),
      channel: z.enum(["email", "sms", "push"]),
      isEnabled: z.boolean(),
      destination: z.string().optional(),
    }))
    .handler(async ({ input, orgId }) => {
      const body = input as { customerId: string; channel: "email" | "sms" | "push"; isEnabled: boolean; destination?: string };
      const result = await prefService.setPreference(
        orgId, body.customerId, body.channel, body.isEnabled, body.destination,
      );
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  pref.get("/{customerId}").summary("Get customer notification preferences").permission("notifications:read")
    .handler(async ({ params, orgId }) => {
      const result = await prefService.getPreferences(orgId, params.customerId!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  // ── Print Routes ───────────────────────────────────────────────────
  const print = router("Print Jobs", "/notifications/print", ctx);

  print.post("/").summary("Submit print job").permission("notifications:admin")
    .input(z.object({
      type: z.enum(["receipt", "label", "sticker", "kot"]),
      printerId: z.string().min(1),
      content: z.record(z.string(), z.unknown()),
      format: z.enum(["esc_pos", "star_line", "label"]).optional(),
    }))
    .handler(async ({ input, orgId }) => {
      const body = input as {
        type: "receipt" | "label" | "sticker" | "kot";
        printerId: string;
        content: Record<string, unknown>;
        format?: "esc_pos" | "star_line" | "label";
      };
      const result = await printService.submitJob(orgId, body);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  print.get("/{id}").summary("Get print job").permission("notifications:admin")
    .handler(async ({ params, orgId }) => {
      const result = await printService.getJob(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  print.get("/").summary("List print jobs").permission("notifications:admin")
    .query(z.object({
      status: z.enum(["queued", "printing", "printed", "failed"]).optional(),
      printerId: z.string().optional(),
      type: z.enum(["receipt", "label", "sticker", "kot"]).optional(),
      limit: z.coerce.number().int().positive().optional(),
    }))
    .handler(async ({ query, orgId }) => {
      const q = query as {
        status?: "queued" | "printing" | "printed" | "failed";
        printerId?: string;
        type?: "receipt" | "label" | "sticker" | "kot";
        limit?: number;
      };
      const result = await printService.listJobs(orgId, q);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  print.patch("/{id}/status").summary("Update print job status").permission("notifications:admin")
    .input(z.object({
      status: z.enum(["queued", "printing", "printed", "failed"]),
      error: z.string().optional(),
    }))
    .handler(async ({ params, input, orgId }) => {
      const body = input as { status: "queued" | "printing" | "printed" | "failed"; error?: string };
      const result = await printService.updateJobStatus(orgId, params.id!, body.status, body.error);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  return [
    ...tmpl.routes(),
    ...send.routes(),
    ...pref.routes(),
    ...print.routes(),
  ];
}
