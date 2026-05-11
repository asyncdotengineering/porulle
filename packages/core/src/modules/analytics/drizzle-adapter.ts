import { sql, type SQL } from "drizzle-orm";
import type { DrizzleDatabase } from "../../kernel/database/drizzle-db.js";
import { CommerceValidationError } from "../../kernel/errors.js";
import { Err, Ok, type Result } from "../../kernel/result.js";
import type {
  AnalyticsAdapter,
  AnalyticsFilter,
  AnalyticsMeta,
  AnalyticsModel,
  AnalyticsModelDefinition,
  AnalyticsQueryParams,
  AnalyticsQueryResult,
  AnalyticsScope,
  AnalyticsTimeDimension,
} from "./types.js";

// ─── Date Range Parsing ──────────────────────────────────────────────────────

function parseDateRange(range: AnalyticsTimeDimension["dateRange"]): [Date, Date] | null {
  if (Array.isArray(range)) {
    const start = new Date(range[0]!);
    const end = new Date(range[1]!);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    return [start, end];
  }
  if (typeof range !== "string") return null;

  const now = new Date();
  const lower = range.toLowerCase();

  if (lower === "last month") {
    return [
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)),
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 59, 59, 999)),
    ];
  }
  if (lower === "this month") {
    return [
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999)),
    ];
  }

  const qMatch = range.match(/^Q([1-4])\s+(\d{4})$/i);
  if (qMatch) {
    const quarter = Number(qMatch[1]);
    const year = Number(qMatch[2]);
    const monthStart = (quarter - 1) * 3;
    return [
      new Date(Date.UTC(year, monthStart, 1)),
      new Date(Date.UTC(year, monthStart + 3, 0, 23, 59, 59, 999)),
    ];
  }

  return null;
}

function pickCube(params: AnalyticsQueryParams): string {
  const first = [
    ...(params.measures ?? []),
    ...(params.dimensions ?? []),
    ...(params.timeDimensions ?? []).map((td) => td.dimension),
    ...(params.filters ?? []).map((f) => f.member),
  ][0];
  if (!first) return "Orders";
  return first.split(".")[0] ?? "Orders";
}

// ─── Granularity to TO_CHAR format ───────────────────────────────────────────

const GRANULARITY_FORMAT: Record<string, string> = {
  day: "YYYY-MM-DD",
  week: "IYYY-\"W\"IW",
  month: "YYYY-MM",
  year: "YYYY",
};

// ─── SQL Compilation Helpers ─────────────────────────────────────────────────

function compileMeasure(cube: AnalyticsModel, measureName: string): SQL {
  const shortName = measureName.split(".")[1]!;
  const def = cube.measures[shortName];
  if (!def) return sql`0`;

  switch (def.type) {
    case "count":
      if (def.filter) {
        return sql.raw(`COUNT(CASE WHEN ${def.filter} THEN 1 END)`);
      }
      return sql`COUNT(*)`;
    case "sum":
      return sql.raw(`COALESCE(SUM(${def.sql!}), 0)`);
    case "avg":
      return sql.raw(`COALESCE(ROUND(AVG(${def.sql!})), 0)`);
    case "min":
      return sql.raw(`MIN(${def.sql!})`);
    case "max":
      return sql.raw(`MAX(${def.sql!})`);
    case "countDistinct":
      return sql.raw(`COUNT(DISTINCT ${def.sql!})`);
  }
}

function compileTimeDimensionSelect(cube: AnalyticsModel, td: AnalyticsTimeDimension): SQL {
  const shortName = td.dimension.split(".")[1]!;
  const dimDef = cube.dimensions[shortName];
  if (!dimDef) return sql`NULL`;

  const gran = td.granularity ?? "day";
  // Validate granularity against whitelist to prevent SQL injection
  if (!(gran in GRANULARITY_FORMAT)) {
    return sql`NULL`;
  }
  const format = GRANULARITY_FORMAT[gran]!;
  return sql.raw(`TO_CHAR(DATE_TRUNC('${gran}', ${dimDef.sql}), '${format}')`);
}

function compileFilter(cube: AnalyticsModel, filter: AnalyticsFilter): SQL | null {
  const shortName = filter.member.split(".")[1]!;
  const dimDef = cube.dimensions[shortName];
  if (!dimDef) return null;

  const col = dimDef.sql;
  const values = filter.values ?? [];
  if (values.length === 0) return null;

  switch (filter.operator) {
    case "equals":
      return sql`${sql.raw(col)} = ${values[0]!}`;
    case "notEquals":
      return sql`${sql.raw(col)} != ${values[0]!}`;
    case "contains":
      return sql`${sql.raw(col)} ILIKE ${"%" + values[0]! + "%"}`;
    case "in":
      return sql`${sql.raw(col)} IN (${sql.join(values.map((v) => sql`${v}`), sql`, `)})`;
    case "notIn":
      return sql`${sql.raw(col)} NOT IN (${sql.join(values.map((v) => sql`${v}`), sql`, `)})`;
    case "gt":
      return sql`${sql.raw(col)} > ${Number(values[0]!)}`;
    case "gte":
      return sql`${sql.raw(col)} >= ${Number(values[0]!)}`;
    case "lt":
      return sql`${sql.raw(col)} < ${Number(values[0]!)}`;
    case "lte":
      return sql`${sql.raw(col)} <= ${Number(values[0]!)}`;
    case "beforeDate":
      return sql`${sql.raw(col)} <= ${values[0]!}::timestamptz`;
    case "afterDate":
      return sql`${sql.raw(col)} >= ${values[0]!}::timestamptz`;
    case "inDateRange":
      if (values.length >= 2) {
        return sql`${sql.raw(col)} BETWEEN ${values[0]!}::timestamptz AND ${values[1]!}::timestamptz`;
      }
      return null;
  }
}

// ─── DrizzleAnalyticsAdapter ─────────────────────────────────────────────────

export class DrizzleAnalyticsAdapter implements AnalyticsAdapter {
  private models = new Map<string, AnalyticsModel>();

  constructor(private db: DrizzleDatabase) {}

  registerModel(model: AnalyticsModel): void {
    this.models.set(model.name, model);
  }

  async query(params: AnalyticsQueryParams, scope: AnalyticsScope): Promise<Result<AnalyticsQueryResult>> {
    if (!params.measures || params.measures.length === 0) {
      return Err(new CommerceValidationError("analytics.query requires at least one measure."));
    }

    const cubeName = pickCube(params);

    // Validate all members are from the same cube
    const allMembers = [
      ...params.measures,
      ...(params.dimensions ?? []),
      ...(params.timeDimensions ?? []).map((td) => td.dimension),
    ];
    const wrongCube = allMembers.find((m) => m.split(".")[0] !== cubeName);
    if (wrongCube) {
      return Err(new CommerceValidationError(
        `analytics.query currently requires measures from a single cube. Found "${wrongCube}" in "${cubeName}" query.`,
      ));
    }

    const cube = this.models.get(cubeName);
    if (!cube) {
      const available = [...this.models.keys()].join(", ");
      return Err(new CommerceValidationError(
        `Unknown analytics cube: "${cubeName}". Available cubes: ${available}`,
      ));
    }

    // Validate that requested measures exist in the cube
    for (const measure of params.measures) {
      const shortName = measure.split(".")[1];
      if (shortName && !cube.measures[shortName]) {
        const available = Object.keys(cube.measures).map((m) => `${cubeName}.${m}`).join(", ");
        return Err(new CommerceValidationError(
          `Unknown measure: "${measure}". Available measures for ${cubeName}: ${available}`,
        ));
      }
    }

    // Validate that requested dimensions exist in the cube
    for (const dim of params.dimensions ?? []) {
      const shortName = dim.split(".")[1];
      if (shortName && !cube.dimensions[shortName]) {
        const available = Object.keys(cube.dimensions).map((d) => `${cubeName}.${d}`).join(", ");
        return Err(new CommerceValidationError(
          `Unknown dimension: "${dim}". Available dimensions for ${cubeName}: ${available}`,
        ));
      }
    }

    try {
      const rows = await this.executeQuery(cube, params, scope);
      return Ok({
        query: params,
        rows,
        source: cubeName,
      });
    } catch (error) {
      return Err(new CommerceValidationError(
        `Analytics query failed: ${error instanceof Error ? error.message : String(error)}`,
      ));
    }
  }

  async getMeta(_scope: AnalyticsScope): Promise<Result<AnalyticsMeta>> {
    const models: AnalyticsModelDefinition[] = [];

    for (const cube of this.models.values()) {
      models.push({
        name: cube.name,
        source: "builtin",
        measures: Object.keys(cube.measures).map((m) => `${cube.name}.${m}`),
        dimensions: Object.keys(cube.dimensions).map((d) => `${cube.name}.${d}`),
        segments: cube.segments
          ? Object.keys(cube.segments).map((s) => `${cube.name}.${s}`)
          : [],
      });
    }

    return Ok({
      models,
      measures: models.flatMap((m) => m.measures),
      dimensions: models.flatMap((m) => m.dimensions),
      segments: models.flatMap((m) => m.segments ?? []),
    });
  }

  // ─── SQL Query Builder ───────────────────────────────────────────────────

  private async executeQuery(
    cube: AnalyticsModel,
    params: AnalyticsQueryParams,
    scope: AnalyticsScope,
  ): Promise<Record<string, unknown>[]> {
    const selectParts: SQL[] = [];
    const groupByParts: SQL[] = [];
    const whereParts: SQL[] = [];

    // ── Scope-based filtering (always applied) ───────────────────────
    //
    // Security model (hardened by default):
    //   admin/staff → no filter (full access)
    //   vendor/customer → MUST have a matching scopeRule, or blocked
    //   public → always blocked
    //
    // Scope is REQUIRED — there is no unscoped code path.
    {
      if (scope.role === "public") {
        whereParts.push(sql.raw("1 = 0"));
      } else if (scope.role !== "admin" && scope.role !== "staff") {
        // Vendor or customer: look for a matching scope rule
        let scopeApplied = false;

        if (cube.scopeRules) {
          for (const rule of cube.scopeRules) {
            if (rule.role === scope.role) {
              // Use parameterized SQL for scope values to prevent injection.
              // The filter template uses :vendorId / :customerId placeholders.
              // We split the filter on placeholders and build a parameterized
              // sql`` template instead of using sql.raw() with string interpolation.
              let filterSql = rule.filter;
              if (scope.vendorId && filterSql.includes(":vendorId")) {
                // Replace placeholder with parameterized value
                const parts = filterSql.split(":vendorId");
                const fragments = parts.map((part, i) =>
                  i < parts.length - 1
                    ? sql`${sql.raw(part)}${scope.vendorId!}`
                    : sql.raw(part),
                );
                whereParts.push(sql.join(fragments, sql``));
                scopeApplied = true;
                continue;
              }
              if (scope.customerId && filterSql.includes(":customerId")) {
                const parts = filterSql.split(":customerId");
                const fragments = parts.map((part, i) =>
                  i < parts.length - 1
                    ? sql`${sql.raw(part)}${scope.customerId!}`
                    : sql.raw(part),
                );
                whereParts.push(sql.join(fragments, sql``));
                scopeApplied = true;
                continue;
              }
              // No placeholder found — use raw (trusted scope rule SQL)
              whereParts.push(sql.raw(filterSql));
              scopeApplied = true;
            }
          }
        }

        // Deny-by-default: if no scope rule matched, block access
        if (!scopeApplied) {
          whereParts.push(sql.raw("1 = 0"));
        }
      }
      // admin/staff: no filter applied — full access
    }

    // Dimensions → SELECT + GROUP BY
    for (const dim of params.dimensions ?? []) {
      const shortName = dim.split(".")[1]!;
      const dimDef = cube.dimensions[shortName];
      if (!dimDef) continue;
      selectParts.push(sql.raw(`${dimDef.sql} AS "${dim}"`));
      groupByParts.push(sql.raw(dimDef.sql));
    }

    // Time dimensions → SELECT + GROUP BY + WHERE (dateRange)
    for (const td of params.timeDimensions ?? []) {
      const selectExpr = compileTimeDimensionSelect(cube, td);
      selectParts.push(sql`${selectExpr} AS ${sql.raw(`"${td.dimension}"`)}`);
      groupByParts.push(selectExpr);

      // Date range filter
      if (td.dateRange) {
        const range = parseDateRange(td.dateRange);
        if (range) {
          const shortName = td.dimension.split(".")[1]!;
          const dimDef = cube.dimensions[shortName];
          if (dimDef) {
            whereParts.push(
              sql`${sql.raw(dimDef.sql)} >= ${range[0].toISOString()}::timestamptz AND ${sql.raw(dimDef.sql)} < ${range[1].toISOString()}::timestamptz`,
            );
          }
        }
      }
    }

    // Measures → SELECT
    for (const measure of params.measures) {
      selectParts.push(sql`${compileMeasure(cube, measure)} AS ${sql.raw(`"${measure}"`)}`);
    }

    // If no select parts (shouldn't happen with validation), bail
    if (selectParts.length === 0) {
      return [];
    }

    // FROM + JOINs
    let fromFragment = sql.raw(cube.table);
    for (const join of cube.joins ?? []) {
      const joinType = join.type === "inner" ? "INNER JOIN" : "LEFT JOIN";
      fromFragment = sql`${fromFragment} ${sql.raw(joinType)} ${sql.raw(join.table)} ON ${sql.raw(join.on)}`;
    }

    // Filters → WHERE
    for (const filter of params.filters ?? []) {
      const compiled = compileFilter(cube, filter);
      if (compiled) whereParts.push(compiled);
    }

    // ORDER BY — validate member names against the cube's registered measures/dimensions
    const validMeasures = new Set(Object.keys(cube.measures).map((m) => `${cube.name}.${m}`));
    const validDimensions = new Set(Object.keys(cube.dimensions).map((d) => `${cube.name}.${d}`));
    const orderParts: SQL[] = [];
    for (const [member, dir] of Object.entries(params.order ?? {})) {
      if (!validMeasures.has(member) && !validDimensions.has(member)) {
        continue; // skip unknown members to prevent SQL injection via sql.raw()
      }
      const normalizedDir = dir.toUpperCase() === "DESC" ? "DESC" : "ASC";
      orderParts.push(sql.raw(`"${member}" ${normalizedDir}`));
    }

    // LIMIT
    const limit = Math.max(1, Math.min(params.limit ?? 100, 1000));

    // Assemble the full query
    const selectClause = sql.join(selectParts, sql`, `);
    const whereClause = whereParts.length > 0
      ? sql`WHERE ${sql.join(whereParts, sql` AND `)}`
      : sql``;
    const groupByClause = groupByParts.length > 0
      ? sql`GROUP BY ${sql.join(groupByParts, sql`, `)}`
      : sql``;
    const orderClause = orderParts.length > 0
      ? sql`ORDER BY ${sql.join(orderParts, sql`, `)}`
      : sql``;

    const fullQuery = sql`SELECT ${selectClause} FROM ${fromFragment} ${whereClause} ${groupByClause} ${orderClause} LIMIT ${limit}`;

    const result = await this.db.execute(fullQuery);

    // Map results: convert bigint to number, preserve column aliases
    // db.execute() returns different shapes per driver — normalize to array of rows
    const rawRows: Record<string, unknown>[] = Array.isArray(result)
      ? result
      : (result as { rows?: Record<string, unknown>[] }).rows ?? [];

    return rawRows.map((row: Record<string, unknown>) => {
      const mapped: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        mapped[key] = typeof value === "bigint" ? Number(value) : value;
      }
      return mapped;
    });
  }
}
