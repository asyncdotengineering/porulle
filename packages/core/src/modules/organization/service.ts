/**
 * OrganizationService — wraps Better Auth's server-side organization API.
 *
 * When auth.api is available (server context), uses Better Auth's
 * createOrganization which properly creates org + member records.
 *
 * When auth is not available (kernel-only scripts), falls back to
 * direct Drizzle insert into the organization table.
 */

import { eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { organization, member } from "../../auth/auth-schema.js";
import type { AuthInstance } from "../../auth/setup.js";

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

interface Result<T> { ok: true; value: T }
interface ResultErr { ok: false; error: string }
function Ok<T>(value: T): Result<T> { return { ok: true, value }; }
function Err(error: string): ResultErr { return { ok: false, error }; }

export interface Organization {
  id: string;
  name: string;
  slug: string;
  logo?: string | null;
  metadata?: string | null;
  createdAt: Date;
}

export interface OrganizationCreateInput {
  id?: string;
  name: string;
  slug: string;
  userId?: string;
  logo?: string;
  metadata?: Record<string, unknown>;
}

export class OrganizationService {
  private auth: AuthInstance | null;
  private db: DrizzleDb;

  constructor(db: unknown, auth?: AuthInstance | null) {
    this.db = db as DrizzleDb;
    this.auth = auth ?? null;
  }

  /**
   * Create an organization.
   *
   * If auth.api is available, uses Better Auth's createOrganization
   * which creates both the org and a member record for the creator.
   *
   * If auth is not available, falls back to direct Drizzle insert
   * and manually creates a member record if userId is provided.
   */
  async create(input: OrganizationCreateInput): Promise<Result<Organization> | ResultErr> {
    // Try Better Auth server-side API first
    if (this.auth) {
      try {
        const api = this.auth.api as Record<string, unknown>;
        if (typeof api.createOrganization === "function") {
          const result = await (api.createOrganization as (opts: unknown) => Promise<unknown>)({
            body: {
              name: input.name,
              slug: input.slug,
              logo: input.logo,
              metadata: input.metadata ? JSON.stringify(input.metadata) : undefined,
              ...(input.userId ? { userId: input.userId } : {}),
            },
          });

          const org = result as Record<string, unknown>;
          return Ok({
            id: String(org.id ?? ""),
            name: String(org.name ?? ""),
            slug: String(org.slug ?? ""),
            logo: org.logo as string | null,
            metadata: org.metadata as string | null,
            createdAt: org.createdAt instanceof Date ? org.createdAt : new Date(),
          });
        }
      } catch (err) {
        // If Better Auth throws (e.g., slug conflict), handle gracefully
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("already exists") || message.includes("UNIQUE")) {
          return Err(`Organization with slug "${input.slug}" already exists`);
        }
        // Fall through to Drizzle fallback
      }
    }

    // Fallback: direct Drizzle insert
    const orgId = input.id ?? crypto.randomUUID().replace(/-/g, "").slice(0, 32);

    // Check if already exists
    const existing = await this.db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, orgId));

    if (existing.length > 0) {
      return Ok({
        id: existing[0]!.id,
        name: input.name,
        slug: input.slug,
        logo: null,
        metadata: null,
        createdAt: new Date(),
      });
    }

    const existingSlug = await this.db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.slug, input.slug));

    if (existingSlug.length > 0) {
      return Ok({
        id: existingSlug[0]!.id,
        name: input.name,
        slug: input.slug,
        logo: null,
        metadata: null,
        createdAt: new Date(),
      });
    }

    await this.db.insert(organization).values({
      id: orgId,
      name: input.name,
      slug: input.slug,
      logo: input.logo,
      metadata: input.metadata ? JSON.stringify(input.metadata) : undefined,
      createdAt: new Date(),
    });

    // Create member record for the creator
    if (input.userId) {
      await this.db.insert(member).values({
        id: crypto.randomUUID().replace(/-/g, "").slice(0, 32),
        organizationId: orgId,
        userId: input.userId,
        role: "owner",
        createdAt: new Date(),
      });
    }

    return Ok({
      id: orgId,
      name: input.name,
      slug: input.slug,
      logo: input.logo ?? null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      createdAt: new Date(),
    });
  }

  async getById(id: string): Promise<Result<Organization> | ResultErr> {
    const rows = await this.db
      .select()
      .from(organization)
      .where(eq(organization.id, id));

    if (rows.length === 0) return Err("Organization not found");

    const org = rows[0]!;
    return Ok({
      id: org.id,
      name: org.name,
      slug: org.slug,
      logo: org.logo,
      metadata: org.metadata,
      createdAt: org.createdAt,
    });
  }

  async list(): Promise<Result<Organization[]>> {
    const rows = await this.db.select().from(organization);
    return Ok(rows.map(org => ({
      id: org.id,
      name: org.name,
      slug: org.slug,
      logo: org.logo,
      metadata: org.metadata,
      createdAt: org.createdAt,
    })));
  }
}
