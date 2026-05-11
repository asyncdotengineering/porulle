import { eq, and } from "@porulle/core/drizzle";
import { Ok, Err } from "@porulle/core";
import type { PluginResult } from "@porulle/core";
import { posTerminals } from "../schema.js";
import type { Db, Terminal, TerminalInsert } from "../types.js";

export class TerminalService {
  constructor(private db: Db) {}

  async create(orgId: string, input: {
    name: string;
    code: string;
    type?: "register" | "tablet" | "mobile" | "kiosk";
    metadata?: Record<string, unknown>;
  }): Promise<PluginResult<Terminal>> {
    // Check for duplicate code in same org
    const existing = await this.db
      .select()
      .from(posTerminals)
      .where(and(eq(posTerminals.organizationId, orgId), eq(posTerminals.code, input.code)));

    if (existing.length > 0) {
      return Err(`Terminal with code '${input.code}' already exists`);
    }

    const rows = await this.db
      .insert(posTerminals)
      .values({
        organizationId: orgId,
        name: input.name,
        code: input.code,
        type: input.type ?? "register",
        metadata: input.metadata ?? {},
      } as TerminalInsert)
      .returning();

    return Ok(rows[0]!);
  }

  async list(orgId: string): Promise<PluginResult<Terminal[]>> {
    const rows = await this.db
      .select()
      .from(posTerminals)
      .where(eq(posTerminals.organizationId, orgId));
    return Ok(rows);
  }

  async getById(orgId: string, id: string): Promise<PluginResult<Terminal>> {
    const rows = await this.db
      .select()
      .from(posTerminals)
      .where(and(eq(posTerminals.id, id), eq(posTerminals.organizationId, orgId)));

    if (rows.length === 0) return Err("Terminal not found");
    return Ok(rows[0]!);
  }

  async update(orgId: string, id: string, input: {
    name?: string;
    isActive?: boolean;
    metadata?: Record<string, unknown>;
  }): Promise<PluginResult<Terminal>> {
    const rows = await this.db
      .update(posTerminals)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(posTerminals.id, id), eq(posTerminals.organizationId, orgId)))
      .returning();

    if (rows.length === 0) return Err("Terminal not found");
    return Ok(rows[0]!);
  }

  async deactivate(orgId: string, id: string): Promise<PluginResult<Terminal>> {
    return this.update(orgId, id, { isActive: false });
  }
}
