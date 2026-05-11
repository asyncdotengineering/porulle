import { eq, and } from "@porulle/core/drizzle";
import { notificationTemplates, customerNotificationPrefs, notificationLog } from "../schema.js";
import type {
  Db, NotificationTemplate, NotificationLogEntry, Channel, NotificationStatus,
  Result,
} from "../types.js";
import { Ok, Err } from "../types.js";
import type { SMSAdapter, PushAdapter, NotificationAdapters } from "../adapters/types.js";

export class NotificationService {
  private smsAdapter: SMSAdapter | undefined;
  private pushAdapter: PushAdapter | undefined;

  constructor(private db: Db, adapters?: NotificationAdapters) {
    this.smsAdapter = adapters?.sms;
    this.pushAdapter = adapters?.push;
  }

  // ── Template CRUD ──────────────────────────────────────────────────

  async createTemplate(orgId: string, input: {
    event: string; channel: Channel; subject?: string; bodyTemplate: string;
  }): Promise<Result<NotificationTemplate>> {
    const existing = await this.db.select().from(notificationTemplates)
      .where(and(
        eq(notificationTemplates.organizationId, orgId),
        eq(notificationTemplates.event, input.event),
        eq(notificationTemplates.channel, input.channel),
      ));
    if (existing.length > 0) return Err(`Template for '${input.event}' on '${input.channel}' already exists`);
    const rows = await this.db.insert(notificationTemplates).values({
      organizationId: orgId,
      event: input.event,
      channel: input.channel,
      subject: input.subject,
      bodyTemplate: input.bodyTemplate,
    }).returning();
    return Ok(rows[0]!);
  }

  async listTemplates(orgId: string, filters?: {
    event?: string; channel?: Channel;
  }): Promise<Result<NotificationTemplate[]>> {
    const conditions = [eq(notificationTemplates.organizationId, orgId)];
    if (filters?.event) conditions.push(eq(notificationTemplates.event, filters.event));
    if (filters?.channel) conditions.push(eq(notificationTemplates.channel, filters.channel));
    const rows = await this.db.select().from(notificationTemplates).where(and(...conditions));
    return Ok(rows);
  }

  async getTemplate(orgId: string, id: string): Promise<Result<NotificationTemplate>> {
    const rows = await this.db.select().from(notificationTemplates)
      .where(and(eq(notificationTemplates.organizationId, orgId), eq(notificationTemplates.id, id)));
    if (rows.length === 0) return Err("Template not found");
    return Ok(rows[0]!);
  }

  async updateTemplate(orgId: string, id: string, input: {
    subject?: string; bodyTemplate?: string; isActive?: boolean;
  }): Promise<Result<NotificationTemplate>> {
    const existing = await this.db.select().from(notificationTemplates)
      .where(and(eq(notificationTemplates.organizationId, orgId), eq(notificationTemplates.id, id)));
    if (existing.length === 0) return Err("Template not found");
    const rows = await this.db.update(notificationTemplates).set({
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      ...(input.bodyTemplate !== undefined ? { bodyTemplate: input.bodyTemplate } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      updatedAt: new Date(),
    }).where(eq(notificationTemplates.id, id)).returning();
    return Ok(rows[0]!);
  }

  async deleteTemplate(orgId: string, id: string): Promise<Result<NotificationTemplate>> {
    const existing = await this.db.select().from(notificationTemplates)
      .where(and(eq(notificationTemplates.organizationId, orgId), eq(notificationTemplates.id, id)));
    if (existing.length === 0) return Err("Template not found");
    const rows = await this.db.update(notificationTemplates).set({
      isActive: false,
      updatedAt: new Date(),
    }).where(eq(notificationTemplates.id, id)).returning();
    return Ok(rows[0]!);
  }

  // ── Template Rendering ─────────────────────────────────────────────

  /**
   * Simple Handlebars-style template rendering.
   * Replaces {{key}} with values from the data object.
   * Supports nested keys via dot notation: {{order.id}}.
   */
  renderTemplate(template: string, data: Record<string, unknown>): string {
    return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, key: string) => {
      const parts = key.split(".");
      let value: unknown = data;
      for (const part of parts) {
        if (value == null || typeof value !== "object") return "";
        value = (value as Record<string, unknown>)[part];
      }
      return value != null ? String(value) : "";
    });
  }

  // ── Send Notification ──────────────────────────────────────────────

  /**
   * Unified send: resolves template, checks customer preferences,
   * dispatches to the correct channel adapter, and logs the result.
   */
  async send(orgId: string, input: {
    event: string;
    recipient: string;
    channel: Channel;
    customerId?: string;
    data?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): Promise<Result<NotificationLogEntry>> {
    // Check customer preference if customerId is provided and channel is not "print"
    if (input.customerId && input.channel !== "print") {
      const prefChannel = input.channel as "email" | "sms" | "push";
      const prefs = await this.db.select().from(customerNotificationPrefs)
        .where(and(
          eq(customerNotificationPrefs.organizationId, orgId),
          eq(customerNotificationPrefs.customerId, input.customerId),
          eq(customerNotificationPrefs.channel, prefChannel),
        ));
      if (prefs.length > 0 && !prefs[0]!.isEnabled) {
        return Err(`Customer has disabled ${input.channel} notifications`);
      }
    }

    // Resolve template if one exists for this event+channel
    let body = "";
    let subject: string | undefined;
    const templates = await this.db.select().from(notificationTemplates)
      .where(and(
        eq(notificationTemplates.organizationId, orgId),
        eq(notificationTemplates.event, input.event),
        eq(notificationTemplates.channel, input.channel),
        eq(notificationTemplates.isActive, true),
      ));

    if (templates.length > 0) {
      const tmpl = templates[0]!;
      body = this.renderTemplate(tmpl.bodyTemplate, input.data ?? {});
      if (tmpl.subject) {
        subject = this.renderTemplate(tmpl.subject, input.data ?? {});
      }
    }

    // Dispatch to adapter
    let adapterError: string | undefined;
    let adapterMessageId: string | undefined;

    if (input.channel === "sms" && this.smsAdapter) {
      const result = await this.smsAdapter.send({ to: input.recipient, body });
      if (!result.ok) {
        adapterError = result.error;
      } else {
        adapterMessageId = result.value.messageId;
      }
    } else if (input.channel === "push" && this.pushAdapter) {
      const result = await this.pushAdapter.send({
        deviceToken: input.recipient,
        title: subject ?? input.event,
        body,
        ...(input.data != null ? { data: input.data } : {}),
      });
      if (!result.ok) {
        adapterError = result.error;
      } else {
        adapterMessageId = result.value.messageId;
      }
    }

    // Log the result
    const status: NotificationStatus = adapterError ? "failed" : "sent";
    const logRows = await this.db.insert(notificationLog).values({
      organizationId: orgId,
      channel: input.channel,
      event: input.event,
      recipient: input.recipient,
      status,
      error: adapterError,
      metadata: {
        ...input.metadata,
        ...(adapterMessageId ? { adapterMessageId } : {}),
        ...(input.data ? { templateData: input.data } : {}),
      },
    }).returning();

    return Ok(logRows[0]!);
  }

  // ── Direct Channel Sends ───────────────────────────────────────────

  async sendSMS(orgId: string, to: string, body: string): Promise<Result<NotificationLogEntry>> {
    let adapterError: string | undefined;
    let adapterMessageId: string | undefined;

    if (this.smsAdapter) {
      const result = await this.smsAdapter.send({ to, body });
      if (!result.ok) {
        adapterError = result.error;
      } else {
        adapterMessageId = result.value.messageId;
      }
    }

    const status: NotificationStatus = adapterError ? "failed" : "sent";
    const rows = await this.db.insert(notificationLog).values({
      organizationId: orgId,
      channel: "sms",
      event: "direct.sms",
      recipient: to,
      status,
      error: adapterError,
      metadata: adapterMessageId ? { adapterMessageId } : {},
    }).returning();

    return Ok(rows[0]!);
  }

  async sendPush(
    orgId: string,
    deviceToken: string,
    title: string,
    body: string,
    data?: Record<string, unknown>,
  ): Promise<Result<NotificationLogEntry>> {
    let adapterError: string | undefined;
    let adapterMessageId: string | undefined;

    if (this.pushAdapter) {
      const result = await this.pushAdapter.send({ deviceToken, title, body, ...(data != null ? { data } : {}) });
      if (!result.ok) {
        adapterError = result.error;
      } else {
        adapterMessageId = result.value.messageId;
      }
    }

    const status: NotificationStatus = adapterError ? "failed" : "sent";
    const rows = await this.db.insert(notificationLog).values({
      organizationId: orgId,
      channel: "push",
      event: "direct.push",
      recipient: deviceToken,
      status,
      error: adapterError,
      metadata: adapterMessageId ? { adapterMessageId } : {},
    }).returning();

    return Ok(rows[0]!);
  }

  // ── Log Queries ────────────────────────────────────────────────────

  async listLog(orgId: string, filters?: {
    channel?: string; event?: string; status?: NotificationStatus; limit?: number;
  }): Promise<Result<NotificationLogEntry[]>> {
    const conditions = [eq(notificationLog.organizationId, orgId)];
    if (filters?.channel) conditions.push(eq(notificationLog.channel, filters.channel));
    if (filters?.event) conditions.push(eq(notificationLog.event, filters.event));
    if (filters?.status) conditions.push(eq(notificationLog.status, filters.status));
    let query = this.db.select().from(notificationLog).where(and(...conditions)).$dynamic();
    if (filters?.limit) query = query.limit(filters.limit);
    const rows = await query;
    return Ok(rows);
  }
}
