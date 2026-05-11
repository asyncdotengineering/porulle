import { eq, and } from "@porulle/core/drizzle";
import { customerNotificationPrefs, notificationTemplates } from "../schema.js";
import type { Db, CustomerNotificationPref, PrefChannel, Result } from "../types.js";
import { Ok } from "../types.js";

export class PreferenceService {
  constructor(private db: Db) {}

  /**
   * Upsert a customer notification preference for a specific channel.
   * If a preference already exists for this org+customer+channel, it is updated.
   */
  async setPreference(orgId: string, customerId: string, channel: PrefChannel, isEnabled: boolean, destination?: string): Promise<Result<CustomerNotificationPref>> {
    const existing = await this.db.select().from(customerNotificationPrefs)
      .where(and(
        eq(customerNotificationPrefs.organizationId, orgId),
        eq(customerNotificationPrefs.customerId, customerId),
        eq(customerNotificationPrefs.channel, channel),
      ));

    if (existing.length > 0) {
      const rows = await this.db.update(customerNotificationPrefs).set({
        isEnabled,
        ...(destination !== undefined ? { destination } : {}),
        updatedAt: new Date(),
      }).where(eq(customerNotificationPrefs.id, existing[0]!.id)).returning();
      return Ok(rows[0]!);
    }

    const rows = await this.db.insert(customerNotificationPrefs).values({
      organizationId: orgId,
      customerId,
      channel,
      isEnabled,
      destination,
    }).returning();
    return Ok(rows[0]!);
  }

  /** Get all notification preferences for a customer. */
  async getPreferences(orgId: string, customerId: string): Promise<Result<CustomerNotificationPref[]>> {
    const rows = await this.db.select().from(customerNotificationPrefs)
      .where(and(
        eq(customerNotificationPrefs.organizationId, orgId),
        eq(customerNotificationPrefs.customerId, customerId),
      ));
    return Ok(rows);
  }

  /**
   * Determine which channels should fire for a given customer+event.
   *
   * Logic:
   * 1. Find all active templates for the event.
   * 2. For each template channel (email/sms/push), check customer preferences.
   * 3. If no preference exists, the channel is considered enabled (opt-out model).
   * 4. Returns channels that have an active template AND are not disabled by the customer.
   */
  async getActiveChannels(orgId: string, customerId: string, event: string): Promise<Result<PrefChannel[]>> {
    // Find active templates for this event (email, sms, push only — not print)
    const templates = await this.db.select().from(notificationTemplates)
      .where(and(
        eq(notificationTemplates.organizationId, orgId),
        eq(notificationTemplates.event, event),
        eq(notificationTemplates.isActive, true),
      ));

    const templateChannels = templates
      .map((t) => t.channel)
      .filter((ch): ch is PrefChannel => ch === "email" || ch === "sms" || ch === "push");

    if (templateChannels.length === 0) return Ok([]);

    // Get customer preferences
    const prefs = await this.db.select().from(customerNotificationPrefs)
      .where(and(
        eq(customerNotificationPrefs.organizationId, orgId),
        eq(customerNotificationPrefs.customerId, customerId),
      ));

    const prefMap = new Map(prefs.map((p) => [p.channel, p.isEnabled]));

    // Filter: include channel if no preference (opt-out model) or explicitly enabled
    const active = templateChannels.filter((ch) => {
      const enabled = prefMap.get(ch);
      return enabled !== false; // undefined (no pref) → allowed; true → allowed; false → blocked
    });

    // Deduplicate
    return Ok([...new Set(active)]);
  }
}
