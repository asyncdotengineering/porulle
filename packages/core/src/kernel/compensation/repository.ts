import { eq, and, desc, isNull, isNotNull, sql } from "drizzle-orm";
import type { DrizzleDatabase, DbOrTx } from "../database/drizzle-db.js";
import type { TxContext } from "../database/tx-context.js";
import { CommerceNotFoundError } from "../errors.js";
import { Ok, Err, type Result } from "../result.js";
import { compensationFailures, type CompensationFailure } from "./schema.js";

export interface RecordFailureInput {
  organizationId: string;
  correlationId: string;
  chainName: string;
  stepName: string;
  originalError: { message: string; code?: string; details?: unknown };
  compensationError: { message: string; stack?: string; details?: unknown };
}

export interface ListFailuresInput {
  organizationId: string;
  resolved?: boolean;
  limit?: number;
  offset?: number;
}

export interface MarkResolvedInput {
  id: string;
  organizationId: string;
  resolvedBy: string;
  notes?: string;
}

export class CompensationFailuresRepository {
  constructor(private readonly db: DrizzleDatabase) {}

  private getDb(ctx?: TxContext): DbOrTx {
    return (ctx?.tx as DbOrTx | undefined) ?? this.db;
  }

  private clampLimit(limit?: number): number {
    const n = limit ?? 50;
    return Math.min(Math.max(n, 1), 200);
  }

  async record(
    input: RecordFailureInput,
    ctx?: TxContext,
  ): Promise<Result<CompensationFailure>> {
    const db = this.getDb(ctx);
    const rows = await db
      .insert(compensationFailures)
      .values({
        organizationId: input.organizationId,
        correlationId: input.correlationId,
        chainName: input.chainName,
        stepName: input.stepName,
        originalError: input.originalError,
        compensationError: input.compensationError,
      })
      .returning();
    return Ok(rows[0]!);
  }

  async list(
    input: ListFailuresInput,
    ctx?: TxContext,
  ): Promise<Result<{ items: CompensationFailure[]; total: number }>> {
    const db = this.getDb(ctx);
    const conditions = [
      eq(compensationFailures.organizationId, input.organizationId),
    ];
    if (input.resolved === true) {
      conditions.push(isNotNull(compensationFailures.resolvedAt));
    } else if (input.resolved === false) {
      conditions.push(isNull(compensationFailures.resolvedAt));
    }
    const whereClause =
      conditions.length === 1 ? conditions[0]! : and(...conditions);
    const limit = this.clampLimit(input.limit);
    const offset = input.offset ?? 0;

    const items = await db
      .select()
      .from(compensationFailures)
      .where(whereClause)
      .orderBy(desc(compensationFailures.occurredAt))
      .limit(limit)
      .offset(offset);

    const countRows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(compensationFailures)
      .where(whereClause);

    const total = countRows[0]?.count ?? 0;
    return Ok({ items, total });
  }

  async findById(
    id: string,
    ctx?: TxContext,
  ): Promise<Result<CompensationFailure | null>> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(compensationFailures)
      .where(eq(compensationFailures.id, id))
      .limit(1);
    return Ok(rows[0] ?? null);
  }

  async getById(
    id: string,
    organizationId: string,
    ctx?: TxContext,
  ): Promise<Result<CompensationFailure | null>> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(compensationFailures)
      .where(
        and(
          eq(compensationFailures.id, id),
          eq(compensationFailures.organizationId, organizationId),
        ),
      );
    return Ok(rows[0] ?? null);
  }

  async markResolved(
    input: MarkResolvedInput,
    ctx?: TxContext,
  ): Promise<Result<CompensationFailure>> {
    const db = this.getDb(ctx);
    const rows = await db
      .update(compensationFailures)
      .set({
        resolvedAt: new Date(),
        resolvedBy: input.resolvedBy,
        resolutionNotes: input.notes ?? null,
      })
      .where(
        and(
          eq(compensationFailures.id, input.id),
          eq(compensationFailures.organizationId, input.organizationId),
          isNull(compensationFailures.resolvedAt),
        ),
      )
      .returning();
    if (rows.length === 0) {
      return Err(
        new CommerceNotFoundError(
          "Compensation failure not found, already resolved, or wrong organization",
        ),
      );
    }
    return Ok(rows[0]!);
  }
}
