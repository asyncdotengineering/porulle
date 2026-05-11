/**
 * Modifier Validation Hook — cart.beforeAddItem
 *
 * Validates modifier selections when items are added to a POS cart.
 * URY has no modifier validation (modifiers are just flat item links).
 * This hook enforces:
 * - Required modifier groups must have at least minSelect selections
 * - No group may exceed maxSelect selections
 * - Unavailable (86'd) options are rejected
 * - Price adjustments are summed into cart line item metadata
 */

import type { ModifierService } from "../services/modifier-service.js";

export function buildModifierValidationHook(getService: () => ModifierService) {
  return {
    key: "cart.beforeAddItem",
    handler: async (...args: unknown[]) => {
      const hook = args[0] as {
        data: {
          entityId?: string;
          metadata?: Record<string, unknown>;
          [key: string]: unknown;
        };
        context: {
          actor?: { organizationId?: string | null } | null;
          [key: string]: unknown;
        };
      };

      const { data, context } = hook;
      const modifiers = data.metadata?.modifiers as Array<{
        groupId: string;
        optionIds: string[];
      }> | undefined;

      // If no modifiers provided, skip validation (non-restaurant items)
      if (!modifiers || modifiers.length === 0) return data;
      if (!data.entityId) return data;

      const { resolveOrgId } = await import("@porulle/core");
      const orgId = resolveOrgId(context.actor);
      const service = getService();

      const result = await service.validateModifiers(orgId, data.entityId, modifiers);
      if (!result.ok) {
        throw new Error(result.error);
      }

      // Inject validated modifiers and price adjustment into metadata
      data.metadata = {
        ...data.metadata,
        validatedModifiers: result.value.validatedModifiers,
        modifierPriceAdjustment: result.value.totalAdjustment,
      };

      return data;
    },
  };
}
