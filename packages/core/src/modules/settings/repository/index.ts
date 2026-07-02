import { and, eq } from "drizzle-orm";
import type { TxContext } from "../../../kernel/database/tx-context.js";
import type {
  DrizzleDatabase,
  DbOrTx,
} from "../../../kernel/database/drizzle-db.js";
import { storeSettings } from "../schema.js";

export type StoreSetting = typeof storeSettings.$inferSelect;

/**
 * Persistence for org-scoped runtime settings (issue #49).
 */
export class SettingsRepository {
  constructor(private readonly db: DrizzleDatabase) {}

  private getDb(ctx?: TxContext): DbOrTx {
    return (ctx?.tx as DbOrTx | undefined) ?? this.db;
  }

  async findByGroup(
    orgId: string,
    group: string,
    ctx?: TxContext,
  ): Promise<StoreSetting | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(storeSettings)
      .where(and(eq(storeSettings.organizationId, orgId), eq(storeSettings.group, group)));
    return rows[0];
  }

  async findAll(orgId: string, ctx?: TxContext): Promise<StoreSetting[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(storeSettings)
      .where(eq(storeSettings.organizationId, orgId));
  }

  async upsert(
    orgId: string,
    group: string,
    value: Record<string, unknown>,
    ctx?: TxContext,
  ): Promise<StoreSetting> {
    const db = this.getDb(ctx);
    const rows = await db
      .insert(storeSettings)
      .values({ organizationId: orgId, group, value })
      .onConflictDoUpdate({
        target: [storeSettings.organizationId, storeSettings.group],
        set: { value, updatedAt: new Date() },
      })
      .returning();
    return rows[0]!;
  }
}
