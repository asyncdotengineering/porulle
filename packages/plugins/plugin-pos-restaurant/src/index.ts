/**
 * POS Restaurant Extension — Complete Feature Set
 *
 * Extends @porulle/plugin-pos with all restaurant-specific features
 * informed by URY Restaurant ERP (ury-erp/ury) production patterns.
 *
 * Feature coverage (maps to URY FEATURES.md):
 *
 * POS & Billing:
 * - Pre-billing checklists (compliance enforcement)
 * - Table service, QSR, and takeaway (order types)
 * - Multi-cashier handling (via Tier 0 terminals)
 * - Shift opening/closing with cash reconciliation (via Tier 0)
 *
 * Menu & Recipe Management:
 * - Item modifiers (groups, options, required/optional, price adjustments)
 * - Recipe/BOM mapping for COGS calculation
 * - Combos and item bundles
 * - Menu availability per outlet (86'd items)
 *
 * Table Order Management:
 * - Table management with zones, floor plan, status lifecycle
 * - Server section assignment
 * - Table/captain transfer
 * - Customer favorites (top ordered items)
 *
 * Kitchen Display & KOT Management:
 * - Multi-station KDS with item-group routing
 * - 4-state ticket flow (pending -> preparing -> ready -> served)
 * - Item-level completion tracking (persistent, not localStorage)
 * - Course sequencing with priority-based ordering
 * - Delay and modification tracking
 * - KOT reprint support
 *
 * Operational Red Flags & Alerts:
 * - Delayed order alerts
 * - KOT not started alerts
 * - Prolonged table occupancy alerts
 * - Excessive cancellation tracking
 * - Configurable thresholds per alert type
 *
 * Reports & Analytics:
 * - Daily Profit & Loss (gross sales, COGS, expenses, net profit)
 * - Station performance (prep time, throughput)
 * - Course-wise performance
 * - Staff/captain performance
 * - P&L expense breakdown
 */

import { defineCommercePlugin } from "@porulle/core";
import {
  posModifierGroups,
  posModifierOptions,
  posTables,
  posTableAssignments,
  kdsStations,
  kdsStationItemGroups,
  kdsTickets,
  kdsTicketItems,
  posChecklists,
  posChecklistItems,
  posChecklistCompletions,
  posRestaurantAlerts,
  posAlertConfig,
  posRecipes,
  posRecipeIngredients,
  posCombos,
  posComboGroups,
  posComboItems,
  posMenuAvailability,
  posDailyPnl,
  posPnlExpenses,
  posCustomerFavorites,
} from "./schema.js";
import { ModifierService } from "./services/modifier-service.js";
import { TableService } from "./services/table-service.js";
import { KDSService } from "./services/kds-service.js";
import { ChecklistService } from "./services/checklist-service.js";
import { AlertService } from "./services/alert-service.js";
import { RecipeService } from "./services/recipe-service.js";
import { RestaurantAnalyticsService } from "./services/analytics-service.js";
import { buildModifierRoutes, buildModifierOptionRoutes } from "./routes/modifiers.js";
import { buildTableRoutes } from "./routes/tables.js";
import { buildKDSRoutes } from "./routes/kds.js";
import {
  buildChecklistRoutes,
  buildAlertRoutes,
  buildRecipeRoutes,
  buildAnalyticsRoutes,
} from "./routes/operations.js";
import { buildModifierValidationHook } from "./hooks/modifier-validation.js";
import { buildTableClearOnCompleteHook } from "./hooks/table-lifecycle.js";
import type { POSRestaurantPluginOptions, Db } from "./types.js";
import { DEFAULT_RESTAURANT_OPTIONS } from "./types.js";

export type { POSRestaurantPluginOptions, Db } from "./types.js";
export { ModifierService } from "./services/modifier-service.js";
export { TableService } from "./services/table-service.js";
export { KDSService } from "./services/kds-service.js";
export { ChecklistService } from "./services/checklist-service.js";
export { AlertService } from "./services/alert-service.js";
export { RecipeService } from "./services/recipe-service.js";
export { RestaurantAnalyticsService } from "./services/analytics-service.js";
export { RecipeDeductionService } from "./services/recipe-deduction-service.js";

export function posRestaurantPlugin(userOptions: POSRestaurantPluginOptions = {}) {
  const options: Required<POSRestaurantPluginOptions> = {
    ...DEFAULT_RESTAURANT_OPTIONS,
    ...userOptions,
  };

  const dbRef: { current: Db | null } = { current: null };
  const modifierServiceRef: { current: ModifierService | null } = { current: null };

  return defineCommercePlugin({
    id: "pos-restaurant",
    version: "1.0.0",
    requires: ["pos"],

    permissions: [
      {
        scope: "pos-restaurant:admin",
        description: "Create/edit modifier groups, tables, KDS stations, checklists, recipes, alert config, analytics, floor plan layout.",
      },
    ],

    schema: () => ({
      // Core restaurant tables
      posModifierGroups,
      posModifierOptions,
      posTables,
      posTableAssignments,
      kdsStations,
      kdsStationItemGroups,
      kdsTickets,
      kdsTicketItems,
      // Operational features
      posChecklists,
      posChecklistItems,
      posChecklistCompletions,
      posRestaurantAlerts,
      posAlertConfig,
      // Menu & recipe management
      posRecipes,
      posRecipeIngredients,
      posCombos,
      posComboGroups,
      posComboItems,
      posMenuAvailability,
      // Analytics
      posDailyPnl,
      posPnlExpenses,
      posCustomerFavorites,
    }),

    hooks: () => {
      const hooks = [];

      if (options.enableModifiers) {
        hooks.push(buildModifierValidationHook(() => {
          if (!modifierServiceRef.current) throw new Error("ModifierService not initialized");
          return modifierServiceRef.current;
        }));
      }

      hooks.push(buildTableClearOnCompleteHook(() => {
        if (!dbRef.current) throw new Error("Restaurant plugin DB not initialized");
        return dbRef.current;
      }));

      return hooks;
    },

    routes: (ctx) => {
      const db = ctx.database.db;
      if (!db) return [];

      dbRef.current = db;

      // Initialize all services
      const modifierService = new ModifierService(db);
      const tableService = new TableService(db);
      const kdsService = new KDSService(db);
      const checklistService = new ChecklistService(db);
      const alertService = new AlertService(db);
      const recipeService = new RecipeService(db);
      const analyticsService = new RestaurantAnalyticsService(db);

      modifierServiceRef.current = modifierService;

      const routes = [
        // Table management (always enabled)
        ...buildTableRoutes(tableService, ctx),
        // Checklists (always enabled)
        ...buildChecklistRoutes(checklistService, ctx),
        // Alerts (always enabled)
        ...buildAlertRoutes(alertService, ctx),
        // Recipes/BOM (always enabled)
        ...buildRecipeRoutes(recipeService, ctx),
        // Analytics (always enabled)
        ...buildAnalyticsRoutes(analyticsService, ctx),
      ];

      if (options.enableModifiers) {
        routes.push(
          ...buildModifierRoutes(modifierService, ctx),
          ...buildModifierOptionRoutes(modifierService, ctx),
        );
      }

      if (options.enableKDS) {
        routes.push(...buildKDSRoutes(kdsService, ctx));
      }

      return routes;
    },
  });
}
