/**
 * Compares Porulle's Drizzle auth tables against better-auth's canonical
 * {@link getAuthTables} output so a dependency minor bump cannot add a column
 * the declared schema omits.
 */

import { getTableColumns, getTableName } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { getAuthTables } from "better-auth/db";
import type { BetterAuthOptions } from "better-auth";
import { apiKey } from "@better-auth/api-key";
import { organization, twoFactor, phoneNumber, jwt, bearer } from "better-auth/plugins";
import type { AuthConfig } from "../config/types.js";
import * as authSchema from "./auth-schema.js";

/**
 * Every plugin {@link createAuth} can enable, not only the ones it enables by
 * default. The shipped schema has to satisfy any configuration a merchant
 * chooses, so the guard compares against the maximal table set: a column that
 * only `twoFactor` needs is still a column this package must declare.
 */
const AUTH_SCHEMA_GUARD_USER = {
  additionalFields: {
    vendorId: { type: "string", required: false },
    posOperatorPin: { type: "string", required: false },
    dateOfBirth: { type: "string", required: false },
  },
} satisfies BetterAuthOptions["user"];

/**
 * Better Auth options for schema parity checks when a consumer enables extra
 * plugins (for example `@better-auth/mcp`) and supplies matching Drizzle tables
 * in `auth.extraAuthSchema`.
 */
export function buildAuthSchemaGuardOptions(
  auth?: Pick<AuthConfig, "jwt" | "extraAuthPlugins">,
): BetterAuthOptions {
  return {
    plugins: [
      organization({ roles: {} }),
      bearer(),
      jwt(auth?.jwt ?? {}),
      twoFactor({ issuer: "porulle-auth-schema-guard" }),
      apiKey(),
      phoneNumber(),
      ...((auth?.extraAuthPlugins ?? []) as NonNullable<
        BetterAuthOptions["plugins"]
      >),
    ],
    user: AUTH_SCHEMA_GUARD_USER,
  };
}

/** Default guard options — core plugins only, no consumer extensions. */
export const AUTH_SCHEMA_GUARD_OPTIONS =
  buildAuthSchemaGuardOptions() satisfies BetterAuthOptions;

/**
 * Drizzle tables keyed by the SQL table name they declare, so the guard walks
 * whatever models better-auth reports rather than a list someone has to
 * remember to extend. A hand-maintained model list is how `jwks.alg` shipped
 * missing while this guard passed.
 */
function drizzleTablesByName(
  extraAuthSchema?: Record<string, unknown>,
): Map<string, PgTable> {
  const byName = new Map<string, PgTable>();
  const modules = [authSchema, extraAuthSchema ?? {}] as const;
  for (const module of modules) {
    for (const [exportKey, value] of Object.entries(module)) {
      try {
        const table = value as PgTable;
        byName.set(getTableName(table), table);
        byName.set(exportKey, table);
      } catch {
        // Not a Drizzle table — skip.
      }
    }
  }
  return byName;
}

function drizzleColumnForField(
  table: PgTable,
  fieldKey: string,
  fieldName: string,
): PgColumn | undefined {
  const columns = getTableColumns(table);
  if (fieldKey in columns) {
    return columns[fieldKey] as PgColumn;
  }
  for (const column of Object.values(columns)) {
    if (column.name === fieldName) {
      return column as PgColumn;
    }
  }
  return undefined;
}

export type AuthSchemaParityMismatch = {
  model: string;
  field: string;
  issue: string;
};

/**
 * Returns every mismatch between better-auth's expected auth tables and the
 * Drizzle definitions Porulle ships. An empty array means parity holds.
 */
export function findAuthSchemaParityMismatches(
  options: BetterAuthOptions = AUTH_SCHEMA_GUARD_OPTIONS,
  extraAuthSchema?: Record<string, unknown>,
): AuthSchemaParityMismatch[] {
  const mismatches: AuthSchemaParityMismatch[] = [];
  const authTables = getAuthTables(options);
  const byName = drizzleTablesByName(extraAuthSchema);

  for (const [model, tableDef] of Object.entries(authTables)) {
    if (!tableDef) continue;
    const drizzleTable = byName.get(tableDef.modelName);
    if (!drizzleTable) {
      mismatches.push({
        model,
        field: "*",
        issue: `no drizzle table declares better-auth model "${tableDef.modelName}"`,
      });
      continue;
    }

    for (const [fieldKey, fieldAttr] of Object.entries(tableDef.fields)) {
      const column = drizzleColumnForField(
        drizzleTable,
        fieldKey,
        fieldAttr.fieldName ?? fieldKey,
      );
      if (!column) {
        mismatches.push({
          model,
          field: fieldKey,
          issue: `drizzle column missing for better-auth field "${fieldKey}"`,
        });
        continue;
      }

      const required = fieldAttr.required !== false;
      if (required && !column.notNull) {
        mismatches.push({
          model,
          field: fieldKey,
          issue: `column "${column.name}" must be NOT NULL (better-auth required)`,
        });
      }
    }
  }

  return mismatches;
}

export function assertAuthSchemaParity(
  options: BetterAuthOptions = AUTH_SCHEMA_GUARD_OPTIONS,
  extraAuthSchema?: Record<string, unknown>,
): void {
  const mismatches = findAuthSchemaParityMismatches(options, extraAuthSchema);
  if (mismatches.length === 0) return;

  const detail = mismatches
    .map((m) => `  ${m.model}.${m.field}: ${m.issue}`)
    .join("\n");
  throw new Error(
    `Porulle auth-schema.ts is out of sync with installed better-auth:\n${detail}`,
  );
}
