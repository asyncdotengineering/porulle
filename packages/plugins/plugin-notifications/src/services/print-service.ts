import { eq, and } from "@porulle/core/drizzle";
import { printJobs } from "../schema.js";
import type { Db, PrintJob, PrintJobStatus, PrintJobType, Result } from "../types.js";
import { Ok, Err } from "../types.js";
import type { PrintAdapter } from "../adapters/types.js";

export class PrintService {
  constructor(private db: Db, private adapter?: PrintAdapter) {}

  /** Submit a new print job. Dispatches to the print adapter if configured. */
  async submitJob(orgId: string, input: {
    type: PrintJobType;
    printerId: string;
    content: Record<string, unknown>;
    format?: "esc_pos" | "star_line" | "label";
  }): Promise<Result<PrintJob>> {
    const rows = await this.db.insert(printJobs).values({
      organizationId: orgId,
      type: input.type,
      printerId: input.printerId,
      content: input.content,
    }).returning();
    const job = rows[0]!;

    // Dispatch to adapter if available
    if (this.adapter) {
      const result = await this.adapter.print({
        printerId: input.printerId,
        content: input.content,
        format: input.format ?? "esc_pos",
      });
      if (!result.ok) {
        // Mark as failed
        const updated = await this.db.update(printJobs).set({
          status: "failed" as const,
          error: result.error,
          updatedAt: new Date(),
        }).where(eq(printJobs.id, job.id)).returning();
        return Ok(updated[0]!);
      }
    }

    return Ok(job);
  }

  /** Get a single print job by ID. */
  async getJob(orgId: string, id: string): Promise<Result<PrintJob>> {
    const rows = await this.db.select().from(printJobs)
      .where(and(eq(printJobs.organizationId, orgId), eq(printJobs.id, id)));
    if (rows.length === 0) return Err("Print job not found");
    return Ok(rows[0]!);
  }

  /** List print jobs with optional filters. */
  async listJobs(orgId: string, filters?: {
    status?: PrintJobStatus; printerId?: string; type?: PrintJobType; limit?: number;
  }): Promise<Result<PrintJob[]>> {
    const conditions = [eq(printJobs.organizationId, orgId)];
    if (filters?.status) conditions.push(eq(printJobs.status, filters.status));
    if (filters?.printerId) conditions.push(eq(printJobs.printerId, filters.printerId));
    if (filters?.type) conditions.push(eq(printJobs.type, filters.type));
    let query = this.db.select().from(printJobs).where(and(...conditions)).$dynamic();
    if (filters?.limit) query = query.limit(filters.limit);
    const rows = await query;
    return Ok(rows);
  }

  /**
   * Update the status of a print job.
   * Valid transitions:
   *   queued → printing → printed
   *   queued → failed
   *   printing → failed
   */
  async updateJobStatus(orgId: string, id: string, status: PrintJobStatus, error?: string): Promise<Result<PrintJob>> {
    const existing = await this.db.select().from(printJobs)
      .where(and(eq(printJobs.organizationId, orgId), eq(printJobs.id, id)));
    if (existing.length === 0) return Err("Print job not found");

    const current = existing[0]!.status;
    const validTransitions: Record<string, string[]> = {
      queued: ["printing", "failed"],
      printing: ["printed", "failed"],
      printed: [],
      failed: [],
    };

    if (!validTransitions[current]?.includes(status)) {
      return Err(`Cannot transition from '${current}' to '${status}'`);
    }

    const rows = await this.db.update(printJobs).set({
      status,
      ...(error !== undefined ? { error } : {}),
      updatedAt: new Date(),
    }).where(eq(printJobs.id, id)).returning();
    return Ok(rows[0]!);
  }
}
