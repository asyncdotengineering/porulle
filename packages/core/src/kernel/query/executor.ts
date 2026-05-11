import { CommerceNotFoundError } from "../errors.js";
import type {
  QueryRegistry,
  EntityDefinition,
  RelationDefinition,
} from "./registry.js";

export interface QueryInput {
  entity: string;
  id?: string;
  filters?: Record<string, unknown>;
  include?: string[];
  pagination?: { limit?: number; offset?: number };
}

export interface QueryResult<T = Record<string, unknown>> {
  data: T[];
  total?: number | undefined;
}

/**
 * Executes a query against the registry, resolving includes via
 * batched dataloader-style fetches (one WHERE IN per relation).
 */
export async function executeQuery<T = Record<string, unknown>>(
  registry: QueryRegistry,
  services: Record<string, unknown>,
  input: QueryInput,
): Promise<QueryResult<T>> {
  const definition = registry.get(input.entity);
  if (!definition) {
    throw new CommerceNotFoundError(
      `No entity registered with name "${input.entity}".`,
    );
  }

  const service = services[definition.service] as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;

  // 1. Fetch primary records
  let rows: Record<string, unknown>[];
  let total: number | undefined;

  if (input.id) {
    const result = (await service[definition.getByIdMethod]!(
      input.id,
    )) as { ok?: boolean; value?: unknown };
    const value = result?.value ?? result;
    rows = value != null ? [value as Record<string, unknown>] : [];
  } else {
    const result = (await service[definition.listMethod]!(
      input.filters ?? {},
      input.pagination,
    )) as {
      ok?: boolean;
      value?: { items?: unknown[]; total?: number };
    };
    const resolved = result?.value ?? result;
    if (resolved && typeof resolved === "object" && "items" in resolved) {
      rows = (resolved.items ?? []) as Record<string, unknown>[];
      total = resolved.total;
    } else if (Array.isArray(resolved)) {
      rows = resolved as Record<string, unknown>[];
    } else {
      rows = [];
    }
  }

  // 2. Resolve includes
  if (input.include?.length) {
    await resolveIncludes(rows, input.include, definition, services, registry);
  }

  return { data: rows as T[], total };
}

async function resolveIncludes(
  rows: Record<string, unknown>[],
  includes: string[],
  definition: EntityDefinition,
  services: Record<string, unknown>,
  registry: QueryRegistry,
): Promise<void> {
  // Group includes by top-level segment
  const topLevel = new Map<string, string[]>();
  for (const path of includes) {
    const dot = path.indexOf(".");
    if (dot === -1) {
      if (!topLevel.has(path)) topLevel.set(path, []);
    } else {
      const parent = path.substring(0, dot);
      const child = path.substring(dot + 1);
      const existing = topLevel.get(parent) ?? [];
      existing.push(child);
      topLevel.set(parent, existing);
    }
  }

  for (const [relationName, nestedIncludes] of topLevel) {
    const relation = definition.relations[relationName];
    if (!relation) continue;

    const targetService = services[relation.targetService] as
      | Record<string, (...args: unknown[]) => Promise<unknown>>
      | undefined;
    if (!targetService) continue;

    // Collect foreign key values (deduplicated)
    const ids = [
      ...new Set(
        rows
          .map((r) => r[relation.foreignKey])
          .filter((v): v is string => v != null && typeof v === "string"),
      ),
    ];
    if (ids.length === 0) continue;

    // One batched query
    const batchFn = targetService[relation.batchMethod];
    if (!batchFn) continue;

    const relatedResult = await batchFn(ids);
    const relatedRows = extractRows(relatedResult);

    // Build lookup
    const map = new Map<string, unknown>();
    for (const related of relatedRows) {
      const rec = related as Record<string, unknown>;
      if (relation.isList) {
        const key = rec[relation.foreignKey] as string;
        if (!map.has(key)) map.set(key, []);
        (map.get(key) as unknown[]).push(rec);
      } else {
        map.set(rec["id"] as string, rec);
      }
    }

    // Attach to parent rows
    for (const row of rows) {
      const fkValue = row[relation.foreignKey] as string | undefined;
      if (!fkValue) continue;
      row[relation.attachAs] =
        map.get(fkValue) ?? (relation.isList ? [] : null);
    }

    // Resolve nested includes
    if (nestedIncludes.length > 0) {
      const targetDef = registry.get(relation.targetService);
      if (targetDef) {
        const nestedRows = relation.isList
          ? rows.flatMap(
              (r) =>
                (r[relation.attachAs] as Record<string, unknown>[]) ?? [],
            )
          : rows
              .map((r) => r[relation.attachAs] as Record<string, unknown>)
              .filter(Boolean);
        await resolveIncludes(
          nestedRows,
          nestedIncludes,
          targetDef,
          services,
          registry,
        );
      }
    }
  }
}

function extractRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object") {
    const r = result as { ok?: boolean; value?: unknown };
    if (r.value != null) {
      if (Array.isArray(r.value)) return r.value;
      if (typeof r.value === "object" && "items" in r.value) {
        return (r.value as { items: unknown[] }).items;
      }
    }
  }
  return [];
}
