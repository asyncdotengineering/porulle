import { eq, and } from "@porulle/core/drizzle";
import { customerNotificationPrefs } from "../schema.js";
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

}
