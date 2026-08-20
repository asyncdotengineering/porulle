/**
 * Compares Porulle's Drizzle auth tables against better-auth's canonical
 * {@link getAuthTables} output so a dependency minor bump cannot add a column
 * the declared schema omits.
 */

import { getTableColumns, getTableName } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { getAuthTables } from "better-auth/db";
import type { BetterAuthOptions } from "better-auth";
import * as authSchema from "./auth-schema.js";

/** Mirrors the plugins enabled in {@link createAuth} that declare DB schema. */
export const AUTH_SCHEMA_GUARD_OPTIONS = {
  plugins: [],
  user: {
    additionalFields: {
      vendorId: { type: "string", required: false },
      posOperatorPin: { type: "string", required: false },
    },
  },
} satisfies BetterAuthOptions;

const GUARDED_MODELS = ["user", "session", "account", "verification"] as const;

type GuardedModel = (typeof GUARDED_MODELS)[number];

const drizzleTables: Record<GuardedModel, PgTable> = {
  user: authSchema.user,
  session: authSchema.session,
  account: authSchema.account,
  verification: authSchema.verification,
};

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
  model: GuardedModel;
  field: string;
  issue: string;
};

/**
 * Returns every mismatch between better-auth's expected auth tables and the
 * Drizzle definitions Porulle ships. An empty array means parity holds.
 */
export function findAuthSchemaParityMismatches(
  options: BetterAuthOptions = AUTH_SCHEMA_GUARD_OPTIONS,
): AuthSchemaParityMismatch[] {
  const mismatches: AuthSchemaParityMismatch[] = [];
  const authTables = getAuthTables(options);

  for (const model of GUARDED_MODELS) {
    const tableDef = authTables[model];
    const drizzleTable = drizzleTables[model];
    if (!tableDef || !drizzleTable) {
      mismatches.push({
        model,
        field: "*",
        issue: `missing ${!tableDef ? "better-auth" : "drizzle"} table definition`,
      });
      continue;
    }

    const expectedTableName = tableDef.modelName;
    const actualTableName = getTableName(drizzleTable);
    if (expectedTableName !== actualTableName) {
      mismatches.push({
        model,
        field: "*",
        issue: `table name "${actualTableName}" !== better-auth model "${expectedTableName}"`,
      });
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
): void {
  const mismatches = findAuthSchemaParityMismatches(options);
  if (mismatches.length === 0) return;

  const detail = mismatches
    .map((m) => `  ${m.model}.${m.field}: ${m.issue}`)
    .join("\n");
  throw new Error(
    `Porulle auth-schema.ts is out of sync with installed better-auth:\n${detail}`,
  );
}
