import { randomUUID } from "node:crypto";
import { sql, desc } from "drizzle-orm";
import {
  pgTable,
  text,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export const compensationFailures = pgTable(
  "compensation_failures",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id").notNull(),
    correlationId: text("correlation_id").notNull(),
    chainName: text("chain_name").notNull(),
    stepName: text("step_name").notNull(),
    originalError: jsonb("original_error")
      .$type<{ message: string; code?: string; details?: unknown }>()
      .notNull(),
    compensationError: jsonb("compensation_error")
      .$type<{ message: string; stack?: string; details?: unknown }>()
      .notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
    resolutionNotes: text("resolution_notes"),
  },
  (table) => ({
    orgUnresolvedIdx: index("idx_compensation_failures_org_unresolved")
      .on(table.organizationId, desc(table.occurredAt))
      .where(sql`${table.resolvedAt} IS NULL`),
    correlationIdx: index("idx_compensation_failures_correlation").on(
      table.correlationId,
    ),
  }),
);

export type CompensationFailure = typeof compensationFailures.$inferSelect;
export type NewCompensationFailure = typeof compensationFailures.$inferInsert;
