/**
 * Scoped DB Proxy
 *
 * Wraps a Drizzle PgDatabase instance so that INSERT operations on
 * org-scoped tables automatically include the actor's organizationId,
 * and SELECT ... FROM org-scoped tables constrain rows to that organization.
 *
 * Plugin route handlers receive this scoped db via PluginContext.database.db
 * (organization resolved per operation from AsyncLocalStorage when used from
 * plugin routes) or a fixed string / getter from router() / tests.
 */

import { and, eq, getTableColumns } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

export type ScopedOrganizationId = string | (() => string);

function resolveOrganizationId(source: ScopedOrganizationId): string {
  return typeof source === "function" ? source() : source;
}

function tableHasOrganizationId(table: unknown): boolean {
  if (table == null || typeof table !== "object") return false;
  try {
    const columns = getTableColumns(table as PgTable);
    return "organizationId" in columns;
  } catch {
    return false;
  }
}

export function createScopedDb<TDb>(rawDb: TDb, orgSource: ScopedOrganizationId): TDb {
  if (!rawDb || typeof rawDb !== "object") return rawDb;

  return new Proxy(rawDb as Record<string, unknown>, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      if (prop === "insert" && typeof value === "function") {
        return (table: PgTable) => {
          const builder = value.call(target, table);
          if (!tableHasOrganizationId(table)) return builder;

          const originalValues = (builder as Record<string, unknown>).values;
          if (typeof originalValues !== "function") return builder;

          return new Proxy(builder as Record<string, unknown>, {
            get(t, p, r) {
              if (p === "values") {
                return (data: unknown) => {
                  const oid = resolveOrganizationId(orgSource);
                  const stamp = (row: Record<string, unknown>) => ({
                    ...row,
                    organizationId: oid,
                  });
                  const stamped = Array.isArray(data)
                    ? data.map(stamp)
                    : stamp(data as Record<string, unknown>);
                  return originalValues.call(t, stamped);
                };
              }
              const v = Reflect.get(t, p, r);
              return typeof v === "function" ? v.bind(t) : v;
            },
          });
        };
      }

      if (prop === "select" && typeof value === "function") {
        return (...args: unknown[]) => {
          const selectBuilder = value.apply(target, args);
          return new Proxy(selectBuilder as Record<string, unknown>, {
            get(sbTarget, sbProp, sbReceiver) {
              const sbVal = Reflect.get(sbTarget, sbProp, sbReceiver);
              if (sbProp === "from" && typeof sbVal === "function") {
                return (fromArg: unknown, ...fromRest: unknown[]) => {
                  const chain = sbVal.call(sbTarget, fromArg, ...fromRest);
                  if (!tableHasOrganizationId(fromArg)) return chain;

                  const columns = getTableColumns(fromArg as PgTable);
                  const orgCol = columns.organizationId;
                  if (!orgCol) return chain;

                  const orgEq = eq(orgCol, resolveOrganizationId(orgSource));
                  const inner = chain as { where: (c: SQL | undefined) => unknown };
                  const scoped = inner.where(orgEq);
                  return new Proxy(scoped as Record<string, unknown>, {
                    get(st, sp, sr) {
                      const sv = Reflect.get(st, sp, sr);
                      if (sp === "where" && typeof sv === "function") {
                        return (condition?: unknown, ...wRest: unknown[]) => {
                          const c = condition as SQL | undefined;
                          const merged = c ? and(orgEq, c) : orgEq;
                          return sv.call(st, merged, ...wRest);
                        };
                      }
                      return typeof sv === "function" ? sv.bind(st) : sv;
                    },
                  });
                };
              }
              return typeof sbVal === "function" ? sbVal.bind(sbTarget) : sbVal;
            },
          });
        };
      }

      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as TDb;
}
