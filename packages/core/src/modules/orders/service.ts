import { resolveOrgId } from "../../auth/org.js";
import { assertOwnership, assertPermission } from "../../auth/permissions.js";
import type { Actor } from "../../auth/types.js";
import {
  CommerceInvalidTransitionError,
  CommerceNotFoundError,
  CommerceValidationError,
  toCommerceError,
} from "../../kernel/errors.js";
import { runAfterHooks, runBeforeHooks } from "../../kernel/hooks/executor.js";
import { createHookContext } from "../../kernel/hooks/create-context.js";
import type {
  AfterHook,
  BeforeHook,
  HookContext,
} from "../../kernel/hooks/types.js";
import type { HookRegistry } from "../../kernel/hooks/registry.js";
import {
  canTransition,
  orderStateMachine,
  type OrderState,
  type StateDefinition,
} from "../../kernel/state-machine/machine.js";
import { Err, Ok, type Result } from "../../kernel/result.js";
import { createLogger } from "../../utils/logger.js";
import { paginate, type Pagination } from "../../utils/pagination.js";
import type { TxContext } from "../../kernel/database/tx-context.js";
import type { DatabaseAdapter } from "../../kernel/database/adapter.js";
import type { PluginDb } from "../../kernel/database/plugin-types.js";
import {
  OrdersRepository,
  type Order,
  type OrderLineItem,
  type OrderStatusHistory,
} from "./repository/index.js";

export interface CreateOrderInput {
  customerId?: string;
  currency: string;
  subtotal: number;
  taxTotal: number;
  shippingTotal: number;
  discountTotal?: number;
  grandTotal: number;
  paymentIntentId?: string | undefined;
  paymentMethodId?: string | undefined;
  metadata?: Record<string, unknown>;
  lineItems: Array<{
    entityId: string;
    entityType: string;
    variantId?: string;
    sku?: string;
    title: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
    taxAmount?: number;
    discountAmount?: number;
    metadata?: Record<string, unknown>;
  }>;
}

export interface ListOrdersParams {
  page?: number;
  limit?: number;
  status?: string;
  /** When true, listByCustomer also returns a lifetime-spend rollup. */
  includeTotals?: boolean;
}

export interface CustomerOrderTotals {
  count: number;
  lifetimeSpend: number;
  averageBasket: number;
}

export interface ChangeStatusInput {
  orderId: string;
  newStatus: OrderState;
  reason?: string;
  /**
   * Explicit refund amount (minor units) for a `refunded` transition. Clamped
   * to the captured amount. Omit to refund the full captured amount.
   */
  refundAmount?: number;
}

export interface OrderServiceDeps {
  repository: OrdersRepository;
  hooks: HookRegistry;
  services: Record<string, unknown>;
  /** Custom state machine. If provided, overrides the default order transitions. */
  stateMachine?: StateDefinition<string>;
  database: DatabaseAdapter;
}

export type HydratedOrder = Order & { lineItems: OrderLineItem[] };
type OrderListResult = {
  items: HydratedOrder[];
  pagination: Pagination;
  totals?: CustomerOrderTotals;
};
type BeforeCreateOrderHook = BeforeHook<CreateOrderInput>;
type AfterCreateOrderHook = AfterHook<HydratedOrder>;
type StatusChangeHookInput = {
  orderId: string;
  fromStatus: OrderState;
  newStatus: OrderState;
  reason?: string;
};
type BeforeStatusChangeHook = BeforeHook<StatusChangeHookInput>;
type AfterStatusChangeHook = AfterHook<HydratedOrder>;

function context(
  actor: Actor | null,
  services: Record<string, unknown>,
  database: DatabaseAdapter,
  tx: unknown = null,
): HookContext {
  return createHookContext({
    actor,
    tx,
    logger: createLogger("orders"),
    services,
    context: { moduleName: "orders" },
    database: { db: database.db as PluginDb },
  });
}

export class OrderService {
  private readonly repo: OrdersRepository;
  private readonly machine: StateDefinition<string>;

  constructor(private deps: OrderServiceDeps) {
    this.repo = deps.repository;
    this.machine = deps.stateMachine ?? orderStateMachine;
  }

  private async hydrateOrder(
    order: Order,
    ctx?: TxContext,
  ): Promise<HydratedOrder> {
    const lineItems = await this.repo.findLineItemsByOrderId(order.id, ctx);
    return { ...order, lineItems };
  }

  async create(
    input: CreateOrderInput,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<HydratedOrder>> {
    try {
      assertPermission(actor, "orders:create");
    } catch (error) {
      return Err(toCommerceError(error));
    }

    if (input.lineItems.length === 0) {
      return Err(
        new CommerceValidationError("Order requires at least one line item."),
      );
    }

    const beforeHooks = this.deps.hooks.resolve(
      "orders.beforeCreate",
    ) as BeforeCreateOrderHook[];
    const afterHooks = this.deps.hooks.resolve(
      "orders.afterCreate",
    ) as AfterCreateOrderHook[];
    const hookCtx = context(actor, this.deps.services, this.deps.database, ctx?.tx);

    const processed = await runBeforeHooks(
      beforeHooks,
      input,
      "create",
      hookCtx,
    );

    const orderNumber = await this.repo.getNextOrderNumber(ctx);
    const orgId = resolveOrgId(actor);

    const order = await this.repo.create(
      {
        organizationId: orgId,
        orderNumber,
        status: "pending",
        currency: processed.currency,
        subtotal: processed.subtotal,
        taxTotal: processed.taxTotal,
        shippingTotal: processed.shippingTotal,
        discountTotal: processed.discountTotal ?? 0,
        grandTotal: processed.grandTotal,
        ...(processed.paymentIntentId != null ? { paymentIntentId: processed.paymentIntentId } : {}),
        ...(processed.paymentMethodId != null ? { paymentMethodId: processed.paymentMethodId } : {}),
        metadata: processed.metadata ?? {},
        placedAt: new Date(),
        ...(processed.customerId !== undefined
          ? { customerId: processed.customerId }
          : {}),
      },
      ctx,
    );

    const lineItemsData = processed.lineItems.map((item) => ({
      orderId: order.id,
      entityId: item.entityId,
      entityType: item.entityType,
      title: item.title,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      totalPrice: item.totalPrice,
      taxAmount: item.taxAmount ?? 0,
      discountAmount: item.discountAmount ?? 0,
      fulfillmentStatus: "unfulfilled" as const,
      metadata: item.metadata ?? {},
      ...(item.variantId !== undefined ? { variantId: item.variantId } : {}),
      ...(item.sku !== undefined ? { sku: item.sku } : {}),
    }));

    await this.repo.createLineItems(lineItemsData, ctx);

    await this.repo.createStatusHistory(
      {
        orderId: order.id,
        fromStatus: "pending",
        toStatus: "pending",
        reason: "order_created",
        changedBy: actor?.userId ?? "system",
      },
      ctx,
    );

    const hydrated = await this.hydrateOrder(order, ctx);
    const report = await runAfterHooks(
      afterHooks,
      null,
      hydrated,
      "create",
      hookCtx,
    );

    return Ok(
      hydrated,
      report.hasErrors ? { hookErrors: report.errors } : undefined,
    );
  }

  async getById(
    id: string,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<HydratedOrder>> {
    const orgId = resolveOrgId(actor);
    const order = await this.repo.findById(orgId, id, ctx);
    if (!order) return Err(new CommerceNotFoundError("Order not found."));

    try {
      if (
        actor?.permissions.includes("orders:read") ||
        actor?.permissions.includes("*:*")
      ) {
        // no-op
      } else if (actor?.permissions.includes("orders:read:own")) {
        assertOwnership(actor, order.customerId ?? null);
      } else {
        assertPermission(actor, "orders:read");
      }
    } catch (error) {
      return Err(toCommerceError(error));
    }

    const hydrated = await this.hydrateOrder(order, ctx);

    // Run afterGet hooks — allows plugins to enrich the order (e.g., vendor fulfillment)
    const afterGetHooks = this.deps.hooks.resolve(
      "orders.afterGet",
    ) as AfterHook<HydratedOrder>[];
    if (afterGetHooks.length > 0) {
      const hookCtx = context(actor, this.deps.services, this.deps.database, ctx?.tx);
      await runAfterHooks(afterGetHooks, null, hydrated, "read", hookCtx);
    }

    return Ok(hydrated);
  }

  async getByNumber(
    orderNumber: string,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<HydratedOrder>> {
    const orgId = resolveOrgId(actor);
    const order = await this.repo.findByOrderNumber(orgId, orderNumber, ctx);
    if (!order) return Err(new CommerceNotFoundError("Order not found."));
    return this.getById(order.id, actor, ctx);
  }

  async list(
    params: ListOrdersParams,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<OrderListResult>> {
    try {
      assertPermission(actor, "orders:read");
    } catch (error) {
      return Err(toCommerceError(error));
    }

    const orgId = resolveOrgId(actor);
    let items: Order[];
    if (params.status) {
      items = await this.repo.findByStatus(orgId, params.status, ctx);
    } else {
      items = await this.repo.findAll(orgId, undefined, ctx);
    }

    // Sort by placedAt descending (in-memory, as findAll already sorts)
    items.sort((a, b) => b.placedAt.getTime() - a.placedAt.getTime());

    const paged = paginate(items, params.page ?? 1, params.limit ?? 20);
    const hydratedItems = await Promise.all(
      paged.items.map((order) => this.hydrateOrder(order, ctx)),
    );

    return Ok({
      items: hydratedItems,
      pagination: paged.pagination,
    });
  }

  async listByCustomer(
    customerId: string,
    params: ListOrdersParams,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<OrderListResult>> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    let items = await this.repo.findByCustomerId(orgId, customerId, ctx);

    if (params.status) {
      items = items.filter((order) => order.status === params.status);
    }

    items.sort((a, b) => b.placedAt.getTime() - a.placedAt.getTime());

    // Lifetime rollup over the full (un-paginated) set, computed server-side.
    // Refunds/voids are excluded from lifetimeSpend.
    let totals: CustomerOrderTotals | undefined;
    if (params.includeTotals) {
      const excluded = new Set(["refunded", "voided"]);
      const count = items.length;
      const lifetimeSpend = items
        .filter((order) => !excluded.has(order.status))
        .reduce((sum, order) => sum + order.grandTotal, 0);
      totals = {
        count,
        lifetimeSpend,
        averageBasket: count > 0 ? Math.round(lifetimeSpend / count) : 0,
      };
    }

    const paged = paginate(items, params.page ?? 1, params.limit ?? 20);
    const hydratedItems = await Promise.all(
      paged.items.map((order) => this.hydrateOrder(order, ctx)),
    );

    return Ok({
      items: hydratedItems,
      pagination: paged.pagination,
      ...(totals ? { totals } : {}),
    });
  }

  /**
   * Fuzzy order lookup for receipt-less returns / support: matches across
   * order number, customer email/name/phone (digits-normalized), and the
   * walk-in label. Returns a compact result; <3 chars returns a hint.
   */
  async lookup(
    q: string,
    opts: { from?: Date; to?: Date },
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<
    Result<{
      items: Array<{
        id: string;
        orderNumber: string;
        placedAt: Date;
        status: string;
        grandTotal: number;
        customer: { id: string; name: string | null; phone: string | null } | null;
      }>;
      hint?: string;
    }>
  > {
    try {
      assertPermission(actor ?? null, "orders:read");
    } catch (error) {
      return Err(toCommerceError(error));
    }

    const term = (q ?? "").trim();
    if (term.length < 3) {
      return Ok({ items: [], hint: "Enter at least 3 characters to search." });
    }

    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const rows = await this.repo.lookup(orgId, term, opts, ctx);
    const items = rows.map((r) => ({
      id: r.id,
      orderNumber: r.orderNumber,
      placedAt: r.placedAt,
      status: r.status,
      grandTotal: r.grandTotal,
      customer: r.customerId
        ? {
            id: r.customerId,
            name: `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim() || null,
            phone: r.phone ?? null,
          }
        : null,
    }));
    return Ok({ items });
  }

  async changeStatus(
    input: ChangeStatusInput,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<HydratedOrder>> {
    const orgId = resolveOrgId(actor);
    const order = await this.repo.findById(orgId, input.orderId, ctx);
    if (!order) return Err(new CommerceNotFoundError("Order not found."));

    try {
      assertPermission(actor, "orders:update");
    } catch (error) {
      return Err(toCommerceError(error));
    }

    if (
      !canTransition(
        this.machine,
        order.status as OrderState,
        input.newStatus,
      )
    ) {
      return Err(
        new CommerceInvalidTransitionError(
          `Cannot transition from ${order.status} to ${input.newStatus}.`,
        ),
      );
    }

    const beforeHooks = this.deps.hooks.resolve(
      "orders.beforeStatusChange",
    ) as BeforeStatusChangeHook[];
    const afterHooks = this.deps.hooks.resolve(
      "orders.afterStatusChange",
    ) as AfterStatusChangeHook[];

    const hookCtx = context(actor, this.deps.services, this.deps.database, ctx?.tx);
    const statusHookInput: StatusChangeHookInput = {
      orderId: order.id,
      fromStatus: order.status as OrderState,
      newStatus: input.newStatus,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    };

    await runBeforeHooks(beforeHooks, statusHookInput, "statusChange", hookCtx);

    const previous = order.status;
    const lineItems = await this.repo.findLineItemsByOrderId(order.id, ctx);

    // VAPT r2 (codex) finding: side effects (inventory release, payment
    // refund, tax void) used to run BEFORE the atomic compare-and-swap on
    // updateStatus. Two parallel cancel/refund requests on the same order
    // would both pass the canTransition check, both release inventory,
    // and both call payments.refund() — double refund and double release —
    // before one of them lost the CAS and returned "concurrent change".
    //
    // Fix: do the CAS first. Only the thread that wins the status update
    // proceeds to the side effects. Losers see the validation error and
    // exit before touching payments / inventory / tax.
    const cas = await this.repo.updateStatus(
      order.id,
      previous,
      input.newStatus,
      ctx,
    );
    if (!cas) {
      return Err(new CommerceValidationError(
        `Order status changed concurrently. Refresh and retry.`,
      ));
    }

    // Handle cancellation and refund side effects
    if (input.newStatus === "cancelled" || input.newStatus === "refunded") {
      // 1. Release inventory reservations
      const inventory = this.deps.services.inventory as
        | {
            release(input: {
              entityId: string;
              variantId?: string;
              quantity: number;
              orderId: string;
              performedBy?: string;
            }): Promise<unknown>;
          }
        | undefined;

      if (inventory?.release) {
        for (const lineItem of lineItems) {
          // Only release inventory for unfulfilled items.
          // Fulfilled items had their reservation released during the
          // fulfilled transition — releasing again would double-release.
          if (lineItem.fulfillmentStatus === "unfulfilled") {
            await inventory.release({
              entityId: lineItem.entityId,
              quantity: lineItem.quantity,
              orderId: order.id,
              performedBy: actor?.userId ?? "system",
              ...(lineItem.variantId != null
                ? { variantId: lineItem.variantId }
                : {}),
            });
          }
        }
      }

      // 2. Refund payment (if captured)
      const paymentIntentId =
        (order as Record<string, unknown>).paymentIntentId as string | undefined
        ?? (order.metadata as Record<string, unknown> | null)?.paymentIntentId as string | undefined;

      if (paymentIntentId) {
        const payments = this.deps.services.payments as
          | {
              refund(
                paymentId: string,
                amount: number,
                reason?: string,
              ): Promise<unknown>;
            }
          | undefined;

        if (payments?.refund) {
          const maxRefund = Math.min(
            order.grandTotal,
            order.amountCaptured ?? order.grandTotal,
          );
          const refundAmount =
            input.refundAmount != null
              ? Math.min(input.refundAmount, maxRefund)
              : maxRefund;
          await payments.refund(
            paymentIntentId,
            refundAmount,
            input.reason ?? `order_${input.newStatus}`,
          );
        }
      }

      // 3. Void tax transaction
      const tax = this.deps.services.tax as
        | {
            voidTransaction(input: { transactionId: string }): Promise<unknown>;
          }
        | undefined;
      if (tax?.voidTransaction) {
        await tax.voidTransaction({ transactionId: order.id });
      }
    }

    // Handle fulfillment: deduct on_hand and release reservations.
    // Items have been shipped — on_hand decreases (stock left the warehouse)
    // and reservations are cleared (no longer needed).
    //
    // Net effect per line item:
    //   on_hand -= quantity, reserved -= quantity, available unchanged
    //   Before: on_hand=100, reserved=5, available=95
    //   After:  on_hand=95,  reserved=0, available=95
    if (input.newStatus === "fulfilled" || input.newStatus === "partially_fulfilled") {
      const inventory = this.deps.services.inventory as
        | {
            deductForFulfillment(input: {
              entityId: string;
              variantId?: string;
              quantity: number;
              orderId: string;
              orgId?: string;
            }): Promise<unknown>;
            release(input: {
              entityId: string;
              variantId?: string;
              quantity: number;
              orderId: string;
              performedBy?: string;
            }): Promise<unknown>;
          }
        | undefined;

      if (inventory) {
        for (const lineItem of lineItems) {
          if (lineItem.fulfillmentStatus === "unfulfilled") {
            // Deduct on_hand (stock physically left warehouse)
            await inventory.deductForFulfillment({
              entityId: lineItem.entityId,
              quantity: lineItem.quantity,
              orderId: order.id,
              orgId: order.organizationId,
              ...(lineItem.variantId != null
                ? { variantId: lineItem.variantId }
                : {}),
            });

            // Release reservation (no longer needed)
            await inventory.release({
              entityId: lineItem.entityId,
              quantity: lineItem.quantity,
              orderId: order.id,
              performedBy: actor?.userId ?? "system",
              ...(lineItem.variantId != null
                ? { variantId: lineItem.variantId }
                : {}),
            });

            // Mark line item as fulfilled
            await this.repo.updateLineItem(
              lineItem.id,
              { fulfillmentStatus: "fulfilled" },
              ctx,
            );
          }
        }
      }
    }

    // Status was atomically updated above; proceed with audit trail.
    await this.repo.createStatusHistory(
      {
        orderId: order.id,
        fromStatus: previous,
        toStatus: input.newStatus,
        changedBy: actor?.userId ?? "system",
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      },
      ctx,
    );

    // Audit logging is automatic via the audit hooks registered at kernel
    // boot — no manual audit.record() call needed here.

    const hydrated = await this.hydrateOrder(cas, ctx);
    const report = await runAfterHooks(
      afterHooks,
      null,
      hydrated,
      "statusChange",
      hookCtx,
    );

    return Ok(
      hydrated,
      report.hasErrors ? { hookErrors: report.errors } : undefined,
    );
  }

  async cancel(
    orderId: string,
    actor: Actor | null,
    reason = "cancelled_by_user",
    ctx?: TxContext,
  ): Promise<Result<HydratedOrder>> {
    return this.changeStatus(
      { orderId, newStatus: "cancelled", reason },
      actor,
      ctx,
    );
  }

  async refund(
    orderId: string,
    actor: Actor | null,
    reason = "refunded",
    ctx?: TxContext,
    opts?: { amount?: number },
  ): Promise<Result<HydratedOrder>> {
    return this.changeStatus(
      {
        orderId,
        newStatus: "refunded",
        reason,
        ...(opts?.amount != null ? { refundAmount: opts.amount } : {}),
      },
      actor,
      ctx,
    );
  }

  /**
   * Capture an authorized payment for an order via the payment adapter and
   * record the captured amount. Does not transition order status — capture is a
   * payment operation, not a fulfillment one.
   */
  async capture(
    orderId: string,
    actor: Actor | null,
    opts?: { amount?: number },
    ctx?: TxContext,
  ): Promise<Result<HydratedOrder>> {
    const orgId = resolveOrgId(actor);
    const order = await this.repo.findById(orgId, orderId, ctx);
    if (!order) return Err(new CommerceNotFoundError("Order not found."));

    try {
      assertPermission(actor, "orders:update");
    } catch (error) {
      return Err(toCommerceError(error));
    }

    const paymentIntentId =
      ((order as Record<string, unknown>).paymentIntentId as string | undefined) ??
      ((order.metadata as Record<string, unknown> | null)?.paymentIntentId as
        | string
        | undefined);
    if (!paymentIntentId) {
      return Err(
        new CommerceValidationError("Order has no authorized payment to capture."),
      );
    }

    const payments = this.deps.services.payments as
      | {
          capture(
            paymentIntentId: string,
            amount?: number,
            paymentMethodId?: string,
          ): Promise<{ ok: boolean; value?: { amountCaptured?: number }; error?: unknown }>;
        }
      | undefined;
    if (!payments?.capture) {
      return Err(
        new CommerceValidationError("No payment adapter configured for capture."),
      );
    }

    const paymentMethodId = (order as Record<string, unknown>).paymentMethodId as
      | string
      | undefined;
    const captureResult = await payments.capture(
      paymentIntentId,
      opts?.amount,
      paymentMethodId,
    );
    if (!captureResult.ok) {
      return Err(toCommerceError(captureResult.error));
    }

    const amountCaptured =
      captureResult.value?.amountCaptured ?? opts?.amount ?? order.grandTotal;
    await this.repo.update(orderId, { amountCaptured }, ctx);

    const refreshed = await this.repo.findById(orgId, orderId, ctx);
    const hydrated = await this.hydrateOrder(refreshed ?? order, ctx);
    return Ok(hydrated);
  }

  async getStatusHistory(
    orderId: string,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<OrderStatusHistory[]>> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const order = await this.repo.findById(orgId, orderId, ctx);
    if (!order) {
      return Err(new CommerceNotFoundError("Order not found."));
    }

    const items = await this.repo.findStatusHistoryByOrderId(orderId, ctx);
    // Sort by changedAt ascending (oldest first)
    items.sort((a, b) => a.changedAt.getTime() - b.changedAt.getTime());

    return Ok(items);
  }

  async updateOrder(
    orderId: string,
    data: {
      placedAt?: Date;
      metadata?: Record<string, unknown>;
      amountCaptured?: number;
    },
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<Order>> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const order = await this.repo.findById(orgId, orderId, ctx);
    if (!order) {
      return Err(new CommerceNotFoundError("Order not found."));
    }
    const updated = await this.repo.update(orderId, data, ctx);
    return Ok(updated!);
  }
}
