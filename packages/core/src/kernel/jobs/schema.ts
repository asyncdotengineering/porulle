import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { organization } from "../../auth/auth-schema.js";

export const commerceJobs = pgTable("commerce_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  queue: text("queue").notNull().default("default"),
  taskSlug: text("task_slug").notNull(),
  input: jsonb("input").notNull().default("{}"),
  output: jsonb("output"),
  status: text("status", {
    enum: ["pending", "processing", "succeeded", "failed"],
  })
    .notNull()
    .default("pending"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(1),
  error: text("error"),
  waitUntil: timestamp("wait_until", { withTimezone: true }),
  concurrencyKey: text("concurrency_key"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  processingStartedAt: timestamp("processing_started_at", {
    withTimezone: true,
  }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => ({
  statusQueueIdx: index("idx_jobs_status_queue").on(table.status, table.queue),
  taskSlugIdx: index("idx_jobs_task_slug").on(table.taskSlug),
  waitUntilIdx: index("idx_jobs_wait_until").on(table.waitUntil),
  orgIdx: index("idx_jobs_org").on(table.organizationId),
}));
