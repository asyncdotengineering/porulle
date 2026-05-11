import { eq, and, desc, gte, lte } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import type { DrizzleDatabase } from "../../kernel/database/drizzle-db.js";
import type { TxContext } from "../../kernel/database/tx-context.js";
import type { HookContext } from "../../kernel/hooks/types.js";
import { resolveOrgId } from "../../auth/org.js";
import { auditLog } from "./schema.js";

export type AuditEntry = InferSelectModel<typeof auditLog>;

export interface RecordArgs {
  entityType: string;
  entityId: string;
  event: string;
  payload?: Record<string, unknown>;
  ctx: HookContext;
}

export interface ListForEntityArgs {
  organizationId?: string;
  entityType: string;
  entityId: string;
  limit?: number;
  ctx?: TxContext;
}

export interface ListArgs {
  organizationId?: string | undefined;
  entityType?: string | undefined;
  entityId?: string | undefined;
  event?: string | undefined;
  actorId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  limit?: number | undefined;
}

export interface AuditService {
  record(args: RecordArgs): Promise<void>;
  listForEntity(args: ListForEntityArgs): Promise<AuditEntry[]>;
  list(args: ListArgs): Promise<AuditEntry[]>;
}

export function createNullAuditService(): AuditService {
  const entries: AuditEntry[] = [];
  return {
    async record(args) {
      entries.push({
        id: crypto.randomUUID(),
        organizationId: resolveOrgId(args.ctx.actor),
        entityType: args.entityType,
        entityId: args.entityId,
        event: args.event,
        payload: args.payload ?? {},
        actorId: args.ctx.actor?.userId ?? null,
        actorType: args.ctx.actor != null ? "user" : null,
        requestId: args.ctx.requestId,
        createdAt: new Date(),
      });
    },
    async listForEntity(args) {
      return entries
        .filter(
          (e) =>
            e.entityType === args.entityType && e.entityId === args.entityId,
        )
        .sort(
          (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
        )
        .slice(0, args.limit ?? 50);
    },
    async list(args) {
      let result = entries;
      if (args.entityType) result = result.filter((e) => e.entityType === args.entityType);
      if (args.entityId) result = result.filter((e) => e.entityId === args.entityId);
      if (args.event) result = result.filter((e) => e.event === args.event);
      if (args.actorId) result = result.filter((e) => e.actorId === args.actorId);
      if (args.from) result = result.filter((e) => e.createdAt >= args.from!);
      if (args.to) result = result.filter((e) => e.createdAt <= args.to!);
      return result
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, args.limit ?? 50);
    },
  };
}

export function createAuditService(db: DrizzleDatabase): AuditService {
  return {
    async record(args) {
      const { entityType, entityId, event, payload, ctx } = args;
      const dbOrTx =
        ctx.tx != null
          ? (ctx.tx as typeof db)
          : db;

      await dbOrTx.insert(auditLog).values({
        organizationId: resolveOrgId(ctx.actor),
        entityType,
        entityId,
        event,
        payload: payload ?? {},
        actorId: ctx.actor?.userId ?? null,
        actorType: ctx.actor != null ? "user" : null,
        requestId: ctx.requestId,
      });
    },

    async listForEntity(args) {
      const { organizationId, entityType, entityId, limit = 50, ctx } = args;
      const dbOrTx =
        ctx?.tx != null
          ? (ctx.tx as typeof db)
          : db;

      const conditions = [
        eq(auditLog.entityType, entityType),
        eq(auditLog.entityId, entityId),
      ];
      if (organizationId) {
        conditions.push(eq(auditLog.organizationId, organizationId));
      }

      return dbOrTx
        .select()
        .from(auditLog)
        .where(and(...conditions))
        .orderBy(desc(auditLog.createdAt))
        .limit(limit);
    },

    async list(args) {
      const conditions = [];
      if (args.organizationId) conditions.push(eq(auditLog.organizationId, args.organizationId));
      if (args.entityType) conditions.push(eq(auditLog.entityType, args.entityType));
      if (args.entityId) conditions.push(eq(auditLog.entityId, args.entityId));
      if (args.event) conditions.push(eq(auditLog.event, args.event));
      if (args.actorId) conditions.push(eq(auditLog.actorId, args.actorId));
      if (args.from) conditions.push(gte(auditLog.createdAt, args.from));
      if (args.to) conditions.push(lte(auditLog.createdAt, args.to));

      let query = db.select().from(auditLog).$dynamic();
      if (conditions.length > 0) {
        query = query.where(conditions.length === 1 ? conditions[0]! : and(...conditions));
      }

      return query
        .orderBy(desc(auditLog.createdAt))
        .limit(args.limit ?? 50);
    },
  };
}
