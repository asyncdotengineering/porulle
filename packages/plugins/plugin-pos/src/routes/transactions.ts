import { router } from "@porulle/core";
import { z } from "@hono/zod-openapi";
import type { TransactionService } from "../services/transaction-service.js";
import type { PluginRouteRegistration } from "@porulle/core";

export function buildTransactionRoutes(
  service: TransactionService,
  cartService: { create: (input: { currency?: string; metadata?: Record<string, unknown> }, actor: unknown) => Promise<{ ok: boolean; value?: { id: string } }> },
  ctx: { services?: Record<string, unknown>; database?: { db: unknown } },
): PluginRouteRegistration[] {
  const r = router("POS Transactions", "/pos/transactions", ctx);

  r.post("/")
    .summary("Start transaction")
    .permission("pos:operate")
    .input(z.object({
      shiftId: z.string().uuid(),
      terminalId: z.string().uuid(),
      type: z.enum(["sale", "return", "exchange"]).optional(),
      customerId: z.string().uuid().optional(),
      currency: z.string().min(3).max(3).optional(),
    }))
    .handler(async ({ input, actor, orgId }) => {
      const body = input as { shiftId: string; terminalId: string; type?: "sale" | "return" | "exchange"; customerId?: string; currency?: string };

      // Create a cart for this transaction
      const cartResult = await cartService.create(
        { currency: body.currency ?? "USD", metadata: { posTransaction: true } },
        actor,
      );
      if (!cartResult.ok || !cartResult.value) {
        throw new Error("Failed to create cart for POS transaction");
      }

      const result = await service.create(orgId, {
        shiftId: body.shiftId,
        terminalId: body.terminalId,
        operatorId: actor!.userId,
        cartId: cartResult.value.id,
        ...(body.type != null ? { type: body.type } : {}),
        ...(body.customerId != null ? { customerId: body.customerId } : {}),
      });
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  // NOTE: /held must be registered BEFORE /{id} to avoid UUID validation catching "held"
  r.get("/held")
    .summary("List held transactions")
    .permission("pos:operate")
    .query(z.object({
      terminalId: z.string().uuid(),
    }))
    .handler(async ({ query, orgId }) => {
      const q = query as { terminalId: string };
      const result = await service.listHeld(orgId, q.terminalId);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/{id}")
    .summary("Get transaction")
    .permission("pos:operate")
    .handler(async ({ params, orgId }) => {
      const result = await service.getById(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/{id}/items")
    .summary("Add item to transaction")
    .permission("pos:operate")
    .input(z.object({
      entityId: z.string().uuid(),
      variantId: z.string().uuid().optional(),
      quantity: z.number().int().min(1).max(9999).optional(),
      notes: z.string().max(500).optional(),
    }))
    .handler(async ({ params, input, actor, services, orgId }) => {
      const body = input as { entityId: string; variantId?: string; quantity?: number; notes?: string };
      const txnResult = await service.getById(orgId, params.id!);
      if (!txnResult.ok) throw new Error(txnResult.error);
      if (txnResult.value.status !== "open") throw new Error("Transaction is not open");

      // Delegate to cart service
      const cart = services.cart as { addItem: (input: unknown, actor: unknown) => Promise<{ ok: boolean; value?: unknown }> };
      const addResult = await cart.addItem({
        cartId: txnResult.value.cartId,
        entityId: body.entityId,
        variantId: body.variantId,
        quantity: body.quantity ?? 1,
        notes: body.notes,
      }, actor);

      if (!addResult.ok) throw new Error("Failed to add item");
      return addResult.value;
    });

  r.patch("/{id}/items/{itemId}")
    .summary("Update line item")
    .permission("pos:operate")
    .input(z.object({
      quantity: z.number().int().min(1).max(9999).optional(),
      notes: z.string().max(500).optional(),
    }))
    .handler(async ({ params, input, actor, services, orgId }) => {
      const body = input as { quantity?: number; notes?: string };
      const txnResult = await service.getById(orgId, params.id!);
      if (!txnResult.ok) throw new Error(txnResult.error);
      if (txnResult.value.status !== "open") throw new Error("Transaction is not open");

      const cart = services.cart as {
        updateQuantity: (input: { cartId: string; itemId: string; quantity: number }, actor: unknown) => Promise<{ ok: boolean; value?: unknown }>;
      };

      if (body.quantity != null) {
        const updateResult = await cart.updateQuantity({
          cartId: txnResult.value.cartId,
          itemId: params.itemId!,
          quantity: body.quantity,
        }, actor);
        if (!updateResult.ok) throw new Error("Failed to update item");
        return updateResult.value;
      }
      return { updated: true };
    });

  r.delete("/{id}/items/{itemId}")
    .summary("Remove line item")
    .permission("pos:operate")
    .handler(async ({ params, actor, services, orgId }) => {
      const txnResult = await service.getById(orgId, params.id!);
      if (!txnResult.ok) throw new Error(txnResult.error);
      if (txnResult.value.status !== "open") throw new Error("Transaction is not open");

      const cart = services.cart as {
        removeItem: (cartId: string, itemId: string, actor: unknown) => Promise<{ ok: boolean }>;
      };
      await cart.removeItem(txnResult.value.cartId, params.itemId!, actor);
      return { removed: true };
    });

  r.post("/{id}/customer")
    .summary("Associate customer")
    .permission("pos:operate")
    .input(z.object({
      customerId: z.string().uuid(),
    }))
    .handler(async ({ params, input, orgId }) => {
      const body = input as { customerId: string };
      const result = await service.setCustomer(orgId, params.id!, body.customerId);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/{id}/hold")
    .summary("Hold transaction")
    .permission("pos:operate")
    .input(z.object({
      label: z.string().min(1).max(200),
    }))
    .handler(async ({ params, input, orgId }) => {
      const body = input as { label: string };
      const result = await service.hold(orgId, params.id!, body.label);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/{id}/recall")
    .summary("Recall held transaction")
    .permission("pos:operate")
    .handler(async ({ params, orgId }) => {
      const result = await service.recall(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/{id}/void")
    .summary("Void transaction")
    .permission("pos:manage")
    .input(z.object({
      reason: z.string().min(1).max(500),
    }))
    .handler(async ({ params, input, orgId }) => {
      const body = input as { reason: string };
      const result = await service.void(orgId, params.id!, body.reason);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  return r.routes();
}
