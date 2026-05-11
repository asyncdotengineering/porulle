/**
 * AnalyticsService — thin delegation layer over AnalyticsAdapter.
 *
 * The service manages plugin model registration, custom schema loading,
 * and delegates all query execution to the configured adapter
 * (DrizzleAnalyticsAdapter — always on, built into core).
 */

import type { CommerceConfig } from "../../config/types.js";
import { CommerceValidationError } from "../../kernel/errors.js";
import { Err, Ok, type Result } from "../../kernel/result.js";
import type {
  AnalyticsAdapter,
  AnalyticsMeta,
  AnalyticsModel,
  AnalyticsModelDefinition,
  AnalyticsQueryParams,
  AnalyticsQueryResult,
  AnalyticsScope,
} from "./types.js";

// Re-export types for backwards compatibility
export type {
  AnalyticsTimeDimension,
  AnalyticsFilter,
  AnalyticsQueryParams,
  AnalyticsModelDefinition,
  AnalyticsMeta,
} from "./types.js";

export interface AnalyticsServiceDeps {
  adapter: AnalyticsAdapter;
  config: CommerceConfig;
}

export class AnalyticsService {
  private pluginModels: AnalyticsModelDefinition[] = [];
  private customSchemaModels: AnalyticsModelDefinition[] = [];
  private customModelsLoaded = false;

  constructor(private deps: AnalyticsServiceDeps) {}

  /**
   * Register a plugin-contributed analytics model.
   *
   * If the model includes a `table` field and structured measures/dimensions,
   * it is also registered as an AnalyticsModel on the adapter for SQL queries.
   * Otherwise, it appears in getMeta() but queries return zero-value rows.
   */
  registerModel(model: unknown): void {
    if (!model || typeof model !== "object") return;

    const raw = model as Record<string, unknown>;
    const name =
      typeof raw.name === "string"
        ? raw.name
        : `PluginModel_${this.pluginModels.length + 1}`;
    const measures = Array.isArray(raw.measures)
      ? raw.measures.filter((v): v is string => typeof v === "string")
      : [];
    const dimensions = Array.isArray(raw.dimensions)
      ? raw.dimensions.filter((v): v is string => typeof v === "string")
      : [];
    const segments = Array.isArray(raw.segments)
      ? raw.segments.filter((v): v is string => typeof v === "string")
      : [];

    this.pluginModels.push({
      name,
      source: "plugin",
      measures,
      dimensions,
      segments,
      raw: model,
    });

    // If the model provides a table + structured definitions, register on the adapter
    if (typeof raw.table === "string" && Array.isArray(raw.measures)) {
      this.tryRegisterModel(name, raw);
    }
  }

  /**
   * Query analytics with scope-based filtering.
   * Scope is REQUIRED — use buildAnalyticsScope(actor) to construct it.
   */
  async query(params: AnalyticsQueryParams, scope: AnalyticsScope): Promise<Result<AnalyticsQueryResult>> {
    return this.deps.adapter.query(params, scope);
  }

  async getDashboard(name: string, scope: AnalyticsScope): Promise<Result<AnalyticsQueryResult>> {
    const normalized = name.trim().toLowerCase();

    if (normalized === "revenue" || normalized === "revenue-overview") {
      return this.query({
        measures: ["Orders.revenue", "Orders.count"],
        timeDimensions: [{
          dimension: "Orders.placedAt",
          granularity: "month",
          dateRange: "this month",
        }],
        order: { "Orders.placedAt": "asc" },
      }, scope);
    }

    if (normalized === "inventory" || normalized === "inventory-health") {
      return this.query({
        measures: ["Inventory.totalAvailable", "Inventory.lowStockCount"],
        dimensions: ["Inventory.warehouseId"],
        order: { "Inventory.totalAvailable": "desc" },
      }, scope);
    }

    return Err(
      new CommerceValidationError(`Unknown analytics dashboard: ${name}`),
    );
  }

  async getMeta(): Promise<Result<AnalyticsMeta>> {
    await this.ensureCustomSchemaModelsLoaded();

    // Meta returns model definitions, not data — always use admin scope
    const adapterMeta = await this.deps.adapter.getMeta({ role: "admin" });
    if (!adapterMeta.ok) return adapterMeta;

    // Merge with plugin and custom schema models
    const allModels = [
      ...adapterMeta.value.models,
      ...this.pluginModels,
      ...this.customSchemaModels,
    ];

    return Ok({
      models: allModels,
      measures: allModels.flatMap((m) => m.measures),
      dimensions: allModels.flatMap((m) => m.dimensions),
      segments: allModels.flatMap((m) => m.segments ?? []),
    });
  }

  async meta(): Promise<Result<{ measures: string[]; dimensions: string[]; segments: string[] }>> {
    const meta = await this.getMeta();
    if (!meta.ok) return meta;
    return Ok({
      measures: meta.value.measures,
      dimensions: meta.value.dimensions,
      segments: meta.value.segments,
    });
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private tryRegisterModel(name: string, raw: Record<string, unknown>): void {
    try {
      const table = raw.table as string;
      const measuresArray = raw.measures as Array<Record<string, unknown>>;
      const dimensionsArray = (raw.dimensions ?? []) as Array<Record<string, unknown>>;

      const modelDef: AnalyticsModel = {
        name,
        table,
        measures: {},
        dimensions: {},
      };

      for (const m of measuresArray) {
        if (typeof m === "string") continue;
        if (typeof m.name === "string" && typeof m.type === "string") {
          modelDef.measures[m.name] = {
            type: m.type as AnalyticsModel["measures"][string]["type"],
            sql: typeof m.sql === "string" ? m.sql : undefined,
            filter: typeof m.filter === "string" ? m.filter : undefined,
          };
        }
      }

      for (const d of dimensionsArray) {
        if (typeof d === "string") continue;
        if (typeof d.name === "string" && typeof d.sql === "string") {
          modelDef.dimensions[d.name] = {
            sql: d.sql,
            type: (typeof d.type === "string" ? d.type : "string") as AnalyticsModel["dimensions"][string]["type"],
          };
        }
      }

      if (Object.keys(modelDef.measures).length > 0) {
        this.deps.adapter.registerModel(modelDef);
      }
    } catch {
      // Silently skip malformed plugin models
    }
  }

  private async ensureCustomSchemaModelsLoaded(): Promise<void> {
    if (this.customModelsLoaded) return;
    this.customModelsLoaded = true;

    const customSchemaPath = this.deps.config.analytics?.customSchemaPath;
    if (!customSchemaPath) return;

    try {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const entries = await fs.readdir(customSchemaPath);

      for (const entry of entries) {
        if (!entry.endsWith(".js")) continue;
        const filePath = path.join(customSchemaPath, entry);
        const content = await fs.readFile(filePath, "utf8");

        const nameMatch = content.match(/cube\s*\(\s*["'`]([\w-]+)["'`]/);
        const name = nameMatch?.[1] ?? entry.replace(/\.js$/, "");

        const measures = [
          ...content.matchAll(/measures\s*:\s*{([\s\S]*?)}\s*,/g),
        ].flatMap((match) => {
          const block = match[1] ?? "";
          return [...block.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*{/g)].map(
            (x) => `${name}.${x[1]}`,
          );
        });

        const dimensions = [
          ...content.matchAll(/dimensions\s*:\s*{([\s\S]*?)}\s*,/g),
        ].flatMap((match) => {
          const block = match[1] ?? "";
          return [...block.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*{/g)].map(
            (x) => `${name}.${x[1]}`,
          );
        });

        this.customSchemaModels.push({
          name,
          source: "custom-schema",
          measures,
          dimensions,
          raw: { path: filePath },
        });
      }
    } catch {
      // Optional extension path: ignore file-system issues
    }
  }
}
