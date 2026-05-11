import { resolveOrgId } from "../../auth/org.js";
import { assertPermission } from "../../auth/permissions.js";
import type { Actor } from "../../auth/types.js";
import type { CommerceConfig } from "../../config/types.js";
import {
  CommerceNotFoundError,
  CommerceValidationError,
  toCommerceError,
} from "../../kernel/errors.js";
import { runAfterHooks } from "../../kernel/hooks/executor.js";
import { createHookContext } from "../../kernel/hooks/create-context.js";
import type { HookContext } from "../../kernel/hooks/types.js";
import type { HookRegistry } from "../../kernel/hooks/registry.js";
import { Err, Ok, type Result } from "../../kernel/result.js";
import { createLogger } from "../../utils/logger.js";
import type { DatabaseAdapter } from "../../kernel/database/adapter.js";
import type { PluginDb } from "../../kernel/database/plugin-types.js";
import { createTxContext, type TxContext } from "../../kernel/database/tx-context.js";
import {
  InventoryRepository,
  type Warehouse,
  type InventoryLevel,
} from "./repository/index.js";

export type { InventoryAdjustInput, InventoryReserveInput, InventoryReleaseInput } from "./schemas.js";
import type { InventoryAdjustInput, InventoryReserveInput, InventoryReleaseInput } from "./schemas.js";

export interface InventoryServiceDeps {
  repository: InventoryRepository;
  hooks: HookRegistry;
  config: CommerceConfig;
  services: Record<string, unknown>;
  database: DatabaseAdapter;
}

export class InventoryService {
  private readonly repo: InventoryRepository;

  constructor(private deps: InventoryServiceDeps) {
    this.repo = deps.repository;
  }

  private async withTransaction<T>(
    ctx: TxContext | undefined,
    fn: (tx: unknown) => Promise<T>,
  ): Promise<T> {
    if (ctx?.tx) return fn(ctx.tx);
    return this.deps.database.transaction(async (tx) => fn(tx));
  }

  private async pickWarehouse(
    actor?: Actor | null,
    ctx?: TxContext,
    orgIdOverride?: string,
  ): Promise<string> {
    const orgId =
      orgIdOverride ??
      resolveOrgId(actor ?? ctx?.actor ?? null, undefined, this.deps.config);
    const warehouses = await this.repo.findAllWarehouses(orgId, ctx);
    const sorted = warehouses.sort((a, b) => a.priority - b.priority);
    if (sorted.length > 0) {
      return sorted[0]!.id;
    }

    // Create default warehouse if none exists
    const defaultWarehouse = await this.repo.createWarehouse(
      {
        organizationId: orgId,
        name: "Default Warehouse",
        code: "DEFAULT",
        isActive: true,
        priority: 0,
        metadata: {},
      },
      ctx,
    );
    return defaultWarehouse.id;
  }

  async createWarehouse(
    input: Partial<Warehouse>,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<Warehouse>> {
    if (!input.name || !input.code) {
      return Err(
        new CommerceValidationError("Warehouse name and code are required."),
      );
    }

    const orgId = resolveOrgId(
      actor ?? ctx?.actor ?? null,
      undefined,
      this.deps.config,
    );

    const warehouse = await this.repo.createWarehouse(
      {
        organizationId: orgId,
        name: input.name,
        code: input.code,
        isActive: input.isActive ?? true,
        priority: input.priority ?? 0,
        metadata: input.metadata ?? {},
        ...(input.address !== undefined ? { address: input.address } : {}),
      },
      ctx,
    );

    return Ok(warehouse);
  }

  async listWarehouses(actor?: Actor | null, ctx?: TxContext): Promise<Result<Warehouse[]>> {
    const orgId = resolveOrgId(
      actor ?? ctx?.actor ?? null,
      undefined,
      this.deps.config,
    );
    const warehouses = await this.repo.findAllWarehouses(orgId, ctx);
    return Ok(warehouses.sort((a, b) => a.priority - b.priority));
  }

  async getAvailable(
    entityId: string,
    variantId?: string,
    ctx?: TxContext,
    actor?: Actor | null,
  ): Promise<Result<number>> {
    const orgId = resolveOrgId(
      actor ?? ctx?.actor ?? null,
      undefined,
      this.deps.config,
    );
    const available = await this.repo.getAvailableQuantity(
      orgId,
      entityId,
      variantId,
      ctx,
    );
    return Ok(available);
  }

  async listLevels(
    params?: { warehouseId?: string; entityId?: string },
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<InventoryLevel[]>> {
    const orgId = resolveOrgId(
      actor ?? ctx?.actor ?? null,
      undefined,
      this.deps.config,
    );
    if (params?.entityId) {
      const levels = await this.repo.findLevelsByEntityId(
        orgId,
        params.entityId,
        ctx,
      );
      return Ok(levels);
    }
    if (params?.warehouseId) {
      const levels = await this.repo.findLevelsByWarehouseId(
        orgId,
        params.warehouseId,
        ctx,
      );
      return Ok(levels);
    }
    const levels = await this.repo.findAllLevels(orgId, ctx);
    return Ok(levels);
  }

  async checkMultiple(
    entityIds: string[],
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<Record<string, number>>> {
    const orgId = resolveOrgId(
      actor ?? ctx?.actor ?? null,
      undefined,
      this.deps.config,
    );
    const data = await this.repo.getAvailableQuantities(orgId, entityIds, ctx);
    return Ok(data);
  }

  async getLevelsByEntityId(
    entityId: string,
    ctx?: TxContext,
    actor?: Actor | null,
  ): Promise<Result<InventoryLevel[]>> {
    const orgId = resolveOrgId(
      actor ?? ctx?.actor ?? null,
      undefined,
      this.deps.config,
    );
    const levels = await this.repo.findLevelsByEntityId(orgId, entityId, ctx);
    return Ok(levels);
  }

  async reserve(
    input: InventoryReserveInput,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<void>> {
    if (input.quantity <= 0) {
      return Err(
        new CommerceValidationError(
          "Reservation quantity must be greater than zero.",
        ),
      );
    }

    const orgId = resolveOrgId(
      actor ?? ctx?.actor ?? null,
      undefined,
      this.deps.config,
    );
    const warehouseId = input.warehouseId ?? (await this.pickWarehouse(actor, ctx));
    const performedBy = input.performedBy ?? actor?.userId ?? "system";
    const variantId = input.variantId ?? null;

    return this.withTransaction(ctx, async (tx) => {
      const txCtx = ctx?.tx ? ctx : createTxContext(tx, { actor: actor ?? null });
      const reserveResult = await this.repo.reserveWithLock(
        orgId,
        input.entityId,
        variantId,
        warehouseId,
        input.quantity,
        txCtx,
      );

      if (!reserveResult.ok) {
        return Err(new CommerceValidationError(reserveResult.reason));
      }

      await this.repo.createMovement(
        {
          organizationId: orgId,
          entityId: input.entityId,
          warehouseId,
          type: "reservation",
          quantity: input.quantity,
          performedBy,
          referenceType: "order",
          referenceId: input.orderId,
          ...(input.variantId != null
            ? { variantId: input.variantId }
            : {}),
        },
        txCtx,
      );

      return Ok(undefined);
    });
  }

  async release(
    input: InventoryReleaseInput,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<void>> {
    const orgId = resolveOrgId(
      actor ?? ctx?.actor ?? null,
      undefined,
      this.deps.config,
    );
    const warehouseId = input.warehouseId ?? (await this.pickWarehouse(actor, ctx));
    const performedBy = input.performedBy ?? actor?.userId ?? "system";
    const variantId = input.variantId ?? null;

    const doRelease = async (txCtx: TxContext): Promise<Result<void>> => {
      const releaseResult = await this.repo.releaseWithLock(
        orgId,
        input.entityId,
        variantId,
        warehouseId,
        input.quantity,
        txCtx,
      );

      if (!releaseResult.ok) {
        return Err(new CommerceValidationError(releaseResult.reason));
      }

      await this.repo.createMovement(
        {
          organizationId: orgId,
          entityId: input.entityId,
          warehouseId,
          type: "release",
          quantity: input.quantity,
          performedBy,
          referenceType: "order",
          referenceId: input.orderId,
          ...(input.variantId != null
            ? { variantId: input.variantId }
            : {}),
        },
        txCtx,
      );

      return Ok(undefined);
    };

    return this.withTransaction(ctx, async (tx) => {
      const txCtx = ctx?.tx ? ctx : createTxContext(tx, { actor: actor ?? null });
      return doRelease(txCtx);
    });
  }

  async adjust(
    input: InventoryAdjustInput,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<InventoryLevel>> {
    try {
      assertPermission(actor ?? null, "inventory:adjust");
    } catch (error) {
      return Err(toCommerceError(error));
    }

    const warehouseId = input.warehouseId ?? (await this.pickWarehouse(actor, ctx));
    const variantId = input.variantId ?? null;
    const performedBy = input.performedBy ?? actor?.userId ?? "system";

    const doAdjust = async (txCtx: TxContext): Promise<Result<InventoryLevel>> => {
      const orgId = resolveOrgId(
        actor ?? txCtx.actor ?? null,
        undefined,
        this.deps.config,
      );
      // Row-locked read + atomic SQL increment prevents lost updates
      const lockResult = await this.repo.adjustWithLock(
        orgId,
        input.entityId,
        variantId,
        warehouseId,
        input.adjustment,
        txCtx,
      );

      let level: InventoryLevel;
      if (lockResult.ok) {
        level = lockResult.level;
      } else {
        // No existing level — create is safe; unique index on
        // (entityId, variantId, warehouseId) prevents duplicate inserts.
        level = await this.repo.createLevel(
          {
            organizationId: orgId,
            entityId: input.entityId,
            warehouseId,
            quantityOnHand: Math.max(0, input.adjustment),
            quantityReserved: 0,
            quantityIncoming: 0,
            ...(input.variantId !== undefined
              ? { variantId: input.variantId }
              : {}),
          },
          txCtx,
        );
      }

      await this.repo.createMovement(
        {
          organizationId: orgId,
          entityId: input.entityId,
          warehouseId,
          type: "adjustment",
          quantity: input.adjustment,
          reason: input.reason,
          performedBy,
          ...(input.variantId !== undefined
            ? { variantId: input.variantId }
            : {}),
          ...(input.referenceType !== undefined
            ? { referenceType: input.referenceType }
            : {}),
          ...(input.referenceId !== undefined
            ? { referenceId: input.referenceId }
            : {}),
        },
        txCtx,
      );

      const hookCtx: HookContext = createHookContext({
        actor: actor ?? null,
        tx: txCtx.tx,
        logger: createLogger("inventory.adjust"),
        services: this.deps.services,
        context: { moduleName: "inventory" },
        database: { db: this.deps.database.db as PluginDb },
      });

      const afterHooks = this.deps.hooks.resolve("inventory.afterAdjust");
      await runAfterHooks(
        afterHooks as Parameters<typeof runAfterHooks>[0],
        null,
        level,
        "update",
        hookCtx,
      );

      return Ok(level);
    };

    return this.withTransaction(ctx, async (tx) => {
      const txCtx = ctx?.tx ? ctx : createTxContext(tx, { actor: actor ?? null });
      return doAdjust(txCtx);
    });
  }

  /**
   * Set inventory to an absolute quantity (not a delta).
   *
   * Used by external store webhooks where the source system reports
   * the current stock level (e.g., Shopify sends `{ available: 6 }`).
   * Computes the delta internally so audit movements stay correct.
   */
  async setAbsolute(
    input: {
      entityId: string;
      quantity: number;
      warehouseId?: string;
      variantId?: string;
      reason?: string;
    },
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<InventoryLevel>> {
    const warehouseId = input.warehouseId ?? (await this.pickWarehouse(actor, ctx));
    const orgId = resolveOrgId(
      actor ?? ctx?.actor ?? null,
      undefined,
      this.deps.config,
    );

    const existingLevel = await this.repo.findLevelByKey(
      orgId,
      input.entityId,
      warehouseId,
      input.variantId,
      ctx,
    );

    const currentOnHand = existingLevel?.quantityOnHand ?? 0;
    const delta = input.quantity - currentOnHand;

    // Delegate to adjust() so hooks, movements, and permission checks are consistent
    return this.adjust(
      {
        entityId: input.entityId,
        warehouseId,
        adjustment: delta,
        reason: input.reason ?? "External store absolute inventory sync",
        ...(input.variantId !== undefined ? { variantId: input.variantId } : {}),
      },
      actor,
      ctx,
    );
  }

  /**
   * Deduct inventory on fulfillment (system-level, no permission check).
   *
   * Decrements quantityOnHand for fulfilled items. This is a system
   * operation triggered by order status → fulfilled, not a manual
   * stock adjustment. Creates a "fulfillment" type movement for audit.
   *
   * Net effect when paired with release():
   *   Before: on_hand=100, reserved=5, available=95
   *   After deduct+release: on_hand=95, reserved=0, available=95
   */
  async deductForFulfillment(
    input: {
      entityId: string;
      variantId?: string;
      warehouseId?: string;
      quantity: number;
      orderId: string;
      orgId?: string;
    },
    ctx?: TxContext,
  ): Promise<Result<void>> {
    const orgId =
      input.orgId ??
      resolveOrgId(ctx?.actor ?? null, undefined, this.deps.config);
    const warehouseId =
      input.warehouseId ?? (await this.pickWarehouse(null, ctx, orgId));
    const variantId = input.variantId ?? null;

    const level = await this.repo.findLevelByKey(
      orgId,
      input.entityId,
      warehouseId,
      variantId != null ? variantId : undefined,
      ctx,
    );

    if (!level) {
      // No inventory record — nothing to deduct
      return Ok(undefined);
    }

    const newOnHand = Math.max(0, level.quantityOnHand - input.quantity);
    await this.repo.updateLevel(
      orgId,
      level.id,
      { quantityOnHand: newOnHand },
      ctx,
    );

    await this.repo.createMovement(
      {
        organizationId: orgId,
        entityId: input.entityId,
        warehouseId,
        type: "fulfillment",
        quantity: -input.quantity,
        performedBy: "system",
        referenceType: "order",
        referenceId: input.orderId,
        ...(variantId != null ? { variantId } : {}),
      },
      ctx,
    );

    return Ok(undefined);
  }

  async setUnitCost(
    entityId: string,
    warehouseId: string,
    unitCost: number,
    variantId?: string,
    ctx?: TxContext,
  ): Promise<Result<InventoryLevel>> {
    const orgId = resolveOrgId(
      ctx?.actor ?? null,
      undefined,
      this.deps.config,
    );
    const level = await this.repo.findLevelByKey(
      orgId,
      entityId,
      warehouseId,
      variantId,
      ctx,
    );
    if (!level) {
      return Err(
        new CommerceNotFoundError(
          `Inventory level not found for entity ${entityId} at warehouse ${warehouseId}.`,
        ),
      );
    }
    const updated = await this.repo.updateLevel(
      orgId,
      level.id,
      { unitCost },
      ctx,
    );
    return Ok(updated!);
  }
}
