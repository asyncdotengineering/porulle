/**
 * Scoped DB Proxy
 *
 * Wraps a Drizzle PgDatabase instance so that INSERT operations on
 * org-scoped tables automatically include the actor's organizationId,
 * and SELECT / UPDATE / DELETE against org-scoped tables constrain rows to
 * that organization — including when the caller supplies no WHERE clause.
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

/**
 * Wrap a WHERE-able Drizzle builder so every `.where()` call AND-s `orgEq` in
 * AND re-wraps its result. Re-wrapping is what makes a chained
 * `.where(a).where(b)` safe: Drizzle's second `.where()` REPLACES the first, so
 * without re-wrapping the chained call would reach the raw builder and execute
 * with only the caller's condition — dropping the org predicate and leaking
 * across tenants. Every link in the chain re-injects `orgEq`.
 */
function wrapWhereable(builder: unknown, orgEq: SQL): unknown {
  return new Proxy(builder as Record<string, unknown>, {
    get(st, sp, sr) {
      const sv = Reflect.get(st, sp, sr);
      if (sp === "where" && typeof sv === "function") {
        return (condition?: unknown, ...wRest: unknown[]) => {
          const c = condition as SQL | undefined;
          const merged = c ? and(orgEq, c) : orgEq;
          const next = (sv as (...a: unknown[]) => unknown).call(st, merged, ...wRest);
          return wrapWhereable(next, orgEq);
        };
      }
      return typeof sv === "function" ? sv.bind(st) : sv;
    },
  });
}

/**
 * Pre-apply the org predicate to a WHERE-able builder (UPDATE/DELETE) and wrap
 * its `.where()` so a caller-supplied condition is AND-ed with the org filter
 * rather than replacing it. Pre-applying `orgEq` immediately means a builder
 * executed with NO caller `.where()` (e.g. `update(t).set(...)`) is still
 * constrained to the org — it can never touch another tenant's rows.
 */
function scopeWhereBuilder(
  builder: { where: (c: SQL | undefined) => unknown },
  orgEq: SQL,
): unknown {
  return wrapWhereable(builder.where(orgEq), orgEq);
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
                  return wrapWhereable(inner.where(orgEq), orgEq);
                };
              }
              return typeof sbVal === "function" ? sbVal.bind(sbTarget) : sbVal;
            },
          });
        };
      }

      if (prop === "update" && typeof value === "function") {
        return (table: PgTable) => {
          const builder = value.call(target, table);
          if (!tableHasOrganizationId(table)) return builder;
          const orgCol = getTableColumns(table).organizationId;
          if (!orgCol) return builder;
          const orgEq = eq(orgCol, resolveOrganizationId(orgSource));
          // The org filter lives after `.set()`, so wrap `.set()` and scope the
          // resulting WHERE-able builder.
          return new Proxy(builder as Record<string, unknown>, {
            get(t, p, r) {
              const v = Reflect.get(t, p, r);
              if (p === "set" && typeof v === "function") {
                return (data: unknown) => {
                  const setBuilder = (v as (...a: unknown[]) => unknown).call(t, data);
                  return scopeWhereBuilder(
                    setBuilder as { where: (c: SQL | undefined) => unknown },
                    orgEq,
                  );
                };
              }
              return typeof v === "function" ? v.bind(t) : v;
            },
          });
        };
      }

      if (prop === "delete" && typeof value === "function") {
        return (table: PgTable) => {
          const builder = value.call(target, table);
          if (!tableHasOrganizationId(table)) return builder;
          const orgCol = getTableColumns(table).organizationId;
          if (!orgCol) return builder;
          const orgEq = eq(orgCol, resolveOrganizationId(orgSource));
          return scopeWhereBuilder(
            builder as { where: (c: SQL | undefined) => unknown },
            orgEq,
          );
        };
      }

      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as TDb;
}
