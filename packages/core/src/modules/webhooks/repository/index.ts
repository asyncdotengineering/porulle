import { eq, and, lte, isNull, or, desc, sql } from "drizzle-orm";
import type { TxContext } from "../../../kernel/database/tx-context.js";
import type {
  DrizzleDatabase,
  DbOrTx,
} from "../../../kernel/database/drizzle-db.js";
import { webhookEndpoints, webhookDeliveries } from "../schema.js";

// Infer types from Drizzle schema
export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect;
export type WebhookEndpointInsert = typeof webhookEndpoints.$inferInsert;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type WebhookDeliveryInsert = typeof webhookDeliveries.$inferInsert;

/**
 * WebhooksRepository provides type-safe database operations for webhooks.
 *
 * This repository manages webhook endpoints and their delivery tracking.
 * All methods support an optional TxContext parameter for transaction participation.
 */
export class WebhooksRepository {
  constructor(private readonly db: DrizzleDatabase) {}

  private getDb(ctx?: TxContext): DbOrTx {
    return (ctx?.tx as DbOrTx | undefined) ?? this.db;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Webhook Endpoints
  // ─────────────────────────────────────────────────────────────────────────────

  // VAPT r2 (codex) finding: every read/delete on webhookEndpoints was
  // org-agnostic. A tenant could list/delete other tenants' endpoints
  // (HIGH cross-tenant), and event fan-out queried all endpoints in the
  // database — Tenant B's webhooks fired on Tenant A's events, leaking
  // payload across tenants. Org filtering is now mandatory.
  async findEndpointById(
    id: string,
    orgId: string,
    ctx?: TxContext,
  ): Promise<WebhookEndpoint | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.id, id),
          eq(webhookEndpoints.organizationId, orgId),
        ),
      );
    return rows[0];
  }

  async findAllEndpoints(
    orgId: string,
    ctx?: TxContext,
  ): Promise<WebhookEndpoint[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.organizationId, orgId));
  }

  async findActiveEndpoints(
    orgId: string,
    ctx?: TxContext,
  ): Promise<WebhookEndpoint[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.organizationId, orgId),
          eq(webhookEndpoints.isActive, true),
        ),
      );
  }

  async findEndpointsForEvent(
    eventName: string,
    orgId: string,
    ctx?: TxContext,
  ): Promise<WebhookEndpoint[]> {
    const active = await this.findActiveEndpoints(orgId, ctx);
    // Filter endpoints that subscribe to this event
    return active.filter((endpoint) => {
      const events = endpoint.events as string[];
      return events.includes(eventName) || events.includes("*");
    });
  }

  async createEndpoint(
    data: WebhookEndpointInsert,
    ctx?: TxContext,
  ): Promise<WebhookEndpoint> {
    const db = this.getDb(ctx);
    const rows = await db.insert(webhookEndpoints).values(data).returning();
    return rows[0]!;
  }

  async updateEndpoint(
    id: string,
    data: Partial<Omit<WebhookEndpointInsert, "id">>,
    ctx?: TxContext,
  ): Promise<WebhookEndpoint | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .update(webhookEndpoints)
      .set(data)
      .where(eq(webhookEndpoints.id, id))
      .returning();
    return rows[0];
  }

  async deleteEndpoint(id: string, ctx?: TxContext): Promise<boolean> {
    const db = this.getDb(ctx);
    const result = await db
      .delete(webhookEndpoints)
      .where(eq(webhookEndpoints.id, id))
      .returning();
    return result.length > 0;
  }

  async activateEndpoint(
    id: string,
    ctx?: TxContext,
  ): Promise<WebhookEndpoint | undefined> {
    return this.updateEndpoint(id, { isActive: true }, ctx);
  }

  async deactivateEndpoint(
    id: string,
    ctx?: TxContext,
  ): Promise<WebhookEndpoint | undefined> {
    return this.updateEndpoint(id, { isActive: false }, ctx);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Webhook Deliveries
  // ─────────────────────────────────────────────────────────────────────────────

  async findDeliveryById(
    id: string,
    ctx?: TxContext,
  ): Promise<WebhookDelivery | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, id));
    return rows[0];
  }

  async findDeliveriesByEndpointId(
    endpointId: string,
    options?: { limit?: number },
    ctx?: TxContext,
  ): Promise<WebhookDelivery[]> {
    const db = this.getDb(ctx);
    let query = db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, endpointId))
      .orderBy(desc(webhookDeliveries.createdAt))
      .$dynamic();

    if (options?.limit !== undefined) {
      query = query.limit(options.limit);
    }

    return query;
  }

  async findPendingDeliveries(ctx?: TxContext): Promise<WebhookDelivery[]> {
    const db = this.getDb(ctx);
    const now = new Date();

    return db
      .select()
      .from(webhookDeliveries)
      .where(
        and(
          isNull(webhookDeliveries.deliveredAt),
          isNull(webhookDeliveries.failedAt),
          or(
            isNull(webhookDeliveries.nextRetryAt),
            lte(webhookDeliveries.nextRetryAt, now),
          ),
        ),
      )
      .orderBy(webhookDeliveries.createdAt);
  }

  async findFailedDeliveries(
    endpointId?: string,
    ctx?: TxContext,
  ): Promise<WebhookDelivery[]> {
    const db = this.getDb(ctx);

    if (endpointId) {
      return db
        .select()
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.endpointId, endpointId),
            sql`${webhookDeliveries.failedAt} IS NOT NULL`,
          ),
        )
        .orderBy(desc(webhookDeliveries.failedAt));
    }

    return db
      .select()
      .from(webhookDeliveries)
      .where(sql`${webhookDeliveries.failedAt} IS NOT NULL`)
      .orderBy(desc(webhookDeliveries.failedAt));
  }

  async createDelivery(
    data: WebhookDeliveryInsert,
    ctx?: TxContext,
  ): Promise<WebhookDelivery> {
    const db = this.getDb(ctx);
    const rows = await db.insert(webhookDeliveries).values(data).returning();
    return rows[0]!;
  }

  async updateDelivery(
    id: string,
    data: Partial<Omit<WebhookDeliveryInsert, "id">>,
    ctx?: TxContext,
  ): Promise<WebhookDelivery | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .update(webhookDeliveries)
      .set(data)
      .where(eq(webhookDeliveries.id, id))
      .returning();
    return rows[0];
  }

  async markDelivered(
    id: string,
    statusCode: number,
    ctx?: TxContext,
  ): Promise<WebhookDelivery | undefined> {
    return this.updateDelivery(
      id,
      {
        statusCode,
        deliveredAt: new Date(),
        nextRetryAt: null,
      },
      ctx,
    );
  }

  async markFailed(
    id: string,
    statusCode: number | null,
    nextRetryAt?: Date,
    ctx?: TxContext,
  ): Promise<WebhookDelivery | undefined> {
    const delivery = await this.findDeliveryById(id, ctx);
    if (!delivery) return undefined;

    const data: Partial<WebhookDeliveryInsert> = {
      statusCode: statusCode ?? undefined,
      attemptCount: delivery.attemptCount + 1,
    };

    if (nextRetryAt) {
      data.nextRetryAt = nextRetryAt;
    } else {
      data.failedAt = new Date();
      data.nextRetryAt = null;
    }

    return this.updateDelivery(id, data, ctx);
  }

  async deleteDelivery(id: string, ctx?: TxContext): Promise<boolean> {
    const db = this.getDb(ctx);
    const result = await db
      .delete(webhookDeliveries)
      .where(eq(webhookDeliveries.id, id))
      .returning();
    return result.length > 0;
  }

  async deleteDeliveriesByEndpointId(
    endpointId: string,
    ctx?: TxContext,
  ): Promise<void> {
    const db = this.getDb(ctx);
    await db
      .delete(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, endpointId));
  }
}
