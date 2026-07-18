import { resolveOrgId } from "../../auth/org.js";
import { assertOwnership, assertPermission } from "../../auth/permissions.js";
import type { Actor } from "../../auth/types.js";
import {
  CommerceForbiddenError,
  CommerceInvalidTransitionError,
  CommerceNotFoundError,
  CommerceValidationError,
  toCommerceError,
} from "../../kernel/errors.js";
import { runAfterHooks, runBeforeHooks } from "../../kernel/hooks/executor.js";
import { createHookContext } from "../../kernel/hooks/create-context.js";
import type { JobsAdapter } from "../../kernel/jobs/adapter.js";
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
import {
  withTransaction,
  type TxContext,
} from "../../kernel/database/tx-context.js";
import type { DatabaseAdapter } from "../../kernel/database/adapter.js";
import type { PluginDb } from "../../kernel/database/plugin-types.js";
import {
  OrdersRepository,
  type Order,
  type OrderLineItem,
  type OrderNote,
  type OrderRefund,
  type OrderStatusHistory,
} from "./repository/index.js";

export interface CreateOrderInput {
  customerId?: string;
  /** Client-supplied retry key — a repeat create with the same key returns the original order. */
  idempotencyKey?: string | undefined;
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
    ...(services.jobs ? { jobs: services.jobs as JobsAdapter } : {}),
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

  /**
   * Resolve every line item's price with org-integrity + price provenance,
   * mirroring how our forefathers handle this (Vendure: order lines are always
   * server-priced from the variant; Medusa: an admin override is honored but
   * flagged `is_custom_price`). Three modes:
   *   - trusted caller (checkout / POS exchange, already server-priced) → prices honored as-is.
   *   - actor with `orders:manage` → explicit price honored as a manual override, flagged isCustomPrice.
   *   - otherwise → price re-derived server-side from the catalog; client prices ignored.
   * The referenced entity MUST belong to the order's org in every mode.
   */
  private async resolveLines(
    input: CreateOrderInput,
    actor: Actor | null,
    trusted: boolean,
    ctx: TxContext | undefined,
  ): Promise<Result<Array<CreateOrderInput["lineItems"][number] & { isCustomPrice: boolean }>>> {
    let canOverride = trusted;
    if (!canOverride) {
      try {
        assertPermission(actor, "orders:manage");
        canOverride = true;
      } catch {
        canOverride = false;
      }
    }
    const catalog = this.deps.services.catalog as {
      getById(
        id: string,
        options: Record<string, unknown>,
        actor?: Actor | null,
        ctx?: TxContext,
      ): Promise<{
        ok: boolean;
        value?: { variants?: Array<{ id: string }> };
      }>;
    };
    const pricing = this.deps.services.pricing as {
      resolve(
        input: {
          entityId: string;
          variantId?: string;
          currency: string;
          quantity: number;
          customerId?: string;
        },
        actor?: Actor | null,
        ctx?: TxContext,
      ): Promise<{ ok: boolean; value?: { finalAmount: number } }>;
    };
    const resolved: Array<
      CreateOrderInput["lineItems"][number] & { isCustomPrice: boolean }
    > = [];
    for (const item of input.lineItems) {
      // Org-integrity — the referenced entity must belong to this order's org.
      const owned = await catalog.getById(
        item.entityId,
        { includeVariants: item.variantId !== undefined },
        actor,
        ctx,
      );
      if (!owned.ok) {
        return Err(
          new CommerceValidationError(
            `Line item entity ${item.entityId} does not belong to this organization.`,
          ),
        );
      }
      if (
        item.variantId !== undefined &&
        !owned.value?.variants?.some((variant) => variant.id === item.variantId)
      ) {
        return Err(
          new CommerceValidationError(
            `Line item variant ${item.variantId} does not belong to entity ${item.entityId}.`,
          ),
        );
      }
      if (trusted || canOverride) {
        // Trusted pipeline totals, or a staff manual/negotiated override.
        resolved.push({ ...item, isCustomPrice: !trusted && canOverride });
        continue;
      }
      // Server-derive the price; the client-supplied unitPrice/totalPrice is ignored.
      const priced = await pricing.resolve(
        {
          entityId: item.entityId,
          currency: input.currency,
          quantity: item.quantity,
          ...(item.variantId ? { variantId: item.variantId } : {}),
          ...(input.customerId ? { customerId: input.customerId } : {}),
        },
        actor,
        ctx,
      );
      if (!priced.ok || !priced.value) {
        return Err(
          new CommerceValidationError(`Cannot resolve price for ${item.entityId}.`),
        );
      }
      const unitPrice = priced.value.finalAmount;
      resolved.push({
        ...item,
        unitPrice,
        totalPrice: unitPrice * item.quantity,
        isCustomPrice: false,
      });
    }
    return Ok(resolved);
  }

  async create(
    input: CreateOrderInput,
    actor: Actor | null,
    ctx?: TxContext,
    opts?: { trustedPricing?: boolean; stockPolicy?: "reserve" | "backorder" },
  ): Promise<Result<HydratedOrder>> {
    if (opts?.stockPolicy === "reserve" && !ctx) {
      return withTransaction(this.deps.database, { actor }, (txCtx) =>
        this.create(input, actor, txCtx, opts),
      );
    }

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

    const orgId = resolveOrgId(actor);

    // Idempotent replay: offline POS queues and network retries re-submit the
    // same create — return the original order instead of double-creating.
    if (processed.idempotencyKey) {
      const existing = await this.repo.findByIdempotencyKey(
        orgId,
        processed.idempotencyKey,
        ctx,
      );
      if (existing) {
        return Ok(await this.hydrateOrder(existing, ctx));
      }
    }

    // Resolve line prices with org-integrity + provenance (see resolveLines).
    const trusted = opts?.trustedPricing === true;
    const resolvedResult = await this.resolveLines(processed, actor, trusted, ctx);
    if (!resolvedResult.ok) return Err(resolvedResult.error);
    const resolvedLines = resolvedResult.value;

    // Order totals: trusted callers (checkout / exchange) supply rich totals
    // (promotions, tax, shipping); otherwise derive from the server-priced lines.
    const computedSubtotal = trusted
      ? processed.subtotal
      : resolvedLines.reduce(
          (sum, l) => sum + (l.totalPrice ?? l.unitPrice * l.quantity),
          0,
        );
    const computedGrandTotal = trusted
      ? processed.grandTotal
      : computedSubtotal +
        processed.taxTotal +
        processed.shippingTotal -
        (processed.discountTotal ?? 0);

    // Stock: order creation does NOT reserve by default. Stock is allocated at
    // the lifecycle transition to a committed state — checkout reserves in its
    // own pipeline, mirroring Vendure's StockAllocationStrategy (allocate on
    // PaymentAuthorized, not on creation). A caller that represents an immediate
    // committed sale (e.g. a POS exchange) opts in with stockPolicy: "reserve".
    const stockPolicy = opts?.stockPolicy;
    if (stockPolicy === "reserve") {
      const inventory = this.deps.services.inventory as {
        getAvailable(
          entityId: string,
          variantId: string | undefined,
          ctx?: TxContext,
          actor?: Actor | null,
        ): Promise<{ ok: boolean; value?: number }>;
      };
      for (const line of resolvedLines) {
        const avail = await inventory.getAvailable(
          line.entityId,
          line.variantId,
          ctx,
          actor,
        );
        if (!avail.ok || (avail.value ?? 0) < line.quantity) {
          return Err(
            new CommerceValidationError(
              `Insufficient stock for ${line.title ?? line.entityId}. Available: ${
                avail.ok ? (avail.value ?? 0) : 0
              }, requested: ${line.quantity}.`,
            ),
          );
        }
      }
    }

    const orderNumber = await this.repo.getNextOrderNumber(ctx);

    let order: Order;
    try {
      order = await this.repo.create(
        {
          organizationId: orgId,
          orderNumber,
          status: "pending",
          currency: processed.currency,
          subtotal: computedSubtotal,
          taxTotal: processed.taxTotal,
          shippingTotal: processed.shippingTotal,
          discountTotal: processed.discountTotal ?? 0,
          grandTotal: computedGrandTotal,
          ...(processed.paymentIntentId != null ? { paymentIntentId: processed.paymentIntentId } : {}),
          ...(processed.paymentMethodId != null ? { paymentMethodId: processed.paymentMethodId } : {}),
          ...(processed.idempotencyKey != null ? { idempotencyKey: processed.idempotencyKey } : {}),
          metadata: processed.metadata ?? {},
          placedAt: new Date(),
          ...(processed.customerId !== undefined
            ? { customerId: processed.customerId }
            : {}),
        },
        ctx,
      );
    } catch (error) {
      // Concurrent replay lost the unique-index race — return the winner.
      if (processed.idempotencyKey) {
        const winner = await this.repo.findByIdempotencyKey(
          orgId,
          processed.idempotencyKey,
          ctx,
        );
        if (winner) return Ok(await this.hydrateOrder(winner, ctx));
      }
      throw error;
    }

    const lineItemsData = resolvedLines.map((item) => ({
      orderId: order.id,
      entityId: item.entityId,
      entityType: item.entityType,
      title: item.title,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      totalPrice: item.totalPrice ?? item.unitPrice * item.quantity,
      isCustomPrice: item.isCustomPrice,
      taxAmount: item.taxAmount ?? 0,
      discountAmount: item.discountAmount ?? 0,
      fulfillmentStatus: "unfulfilled" as const,
      metadata: item.metadata ?? {},
      ...(item.variantId !== undefined ? { variantId: item.variantId } : {}),
      ...(item.sku !== undefined ? { sku: item.sku } : {}),
    }));

    await this.repo.createLineItems(lineItemsData, ctx);

    // Reserve stock for the resolved lines when the reserve policy is active
    // (availability was verified above). Trusted callers reserve themselves.
    if (stockPolicy === "reserve") {
      const inventory = this.deps.services.inventory as {
        reserve(
          input: {
            entityId: string;
            quantity: number;
            orderId: string;
            variantId?: string;
          },
          actor?: Actor | null,
          ctx?: TxContext,
        ): Promise<{ ok: boolean; error?: unknown }>;
      };
      for (const line of resolvedLines) {
        const reserved = await inventory.reserve(
          {
            entityId: line.entityId,
            quantity: line.quantity,
            orderId: order.id,
            ...(line.variantId ? { variantId: line.variantId } : {}),
          },
          actor,
          ctx,
        );
        if (!reserved.ok) {
          return Err(
            toCommerceError(
              reserved.error ??
                new CommerceValidationError(
                  `Unable to reserve stock for ${line.title ?? line.entityId}.`,
                ),
            ),
          );
        }
      }
    }

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

  /** Returns the order previously created with this idempotency key, or null. */
  async getByIdempotencyKey(
    idempotencyKey: string,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<HydratedOrder | null>> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const order = await this.repo.findByIdempotencyKey(orgId, idempotencyKey, ctx);
    if (!order) return Ok(null);
    return Ok(await this.hydrateOrder(order, ctx));
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

    // R-04: goods must not ship against refunded lines. Reject the fulfilled
    // transition if any line has been (partially) refunded.
    if (
      input.newStatus === "fulfilled" &&
      lineItems.some((li) => li.refundedQuantity > 0)
    ) {
      return Err(
        new CommerceValidationError(
          "Cannot fulfill an order that has refunded line items.",
        ),
      );
    }

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
            release(
              input: {
                entityId: string;
                variantId?: string;
                quantity: number;
                orderId: string;
                performedBy?: string;
              },
              actor?: Actor | null,
              ctx?: TxContext,
            ): Promise<Result<void>>;
          }
        | undefined;

      if (inventory?.release) {
        for (const lineItem of lineItems) {
          // Only release inventory for unfulfilled items.
          // Fulfilled items had their reservation released during the
          // fulfilled transition — releasing again would double-release.
          if (lineItem.fulfillmentStatus === "unfulfilled") {
            const releaseResult = await inventory.release(
              {
                entityId: lineItem.entityId,
                quantity: lineItem.quantity,
                orderId: order.id,
                performedBy: actor?.userId ?? "system",
                ...(lineItem.variantId != null
                  ? { variantId: lineItem.variantId }
                  : {}),
              },
              actor,
              ctx,
            );
            if (!releaseResult.ok) {
              const err = toCommerceError(releaseResult.error);
              // Tolerate a missing inventory record (nothing to release); surface
              // any other inventory error. Check the typed code, not the message.
              if (err.code !== "INVENTORY_RECORD_NOT_FOUND") {
                return Err(err);
              }
            }
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
          // R-01: subtract prior gateway refunds (line-level refundLines, and
          // undone refunds — the gateway was never reversed) so this order-level
          // refund can't double-pay on top of what has already been refunded.
          const priorRefunds = await this.repo.findRefundsByOrderId(order.id, ctx);
          const alreadyRefunded = priorRefunds.reduce((sum, r) => sum + r.amount, 0);
          const maxRefund = Math.max(
            0,
            Math.min(order.grandTotal, order.amountCaptured ?? order.grandTotal) -
              alreadyRefunded,
          );
          const refundAmount =
            input.refundAmount != null
              ? Math.min(input.refundAmount, maxRefund)
              : maxRefund;
          if (refundAmount > 0) {
            await payments.refund(
              paymentIntentId,
              refundAmount,
              input.reason ?? `order_${input.newStatus}`,
            );
          }
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
            release(
              input: {
                entityId: string;
                variantId?: string;
                quantity: number;
                orderId: string;
                performedBy?: string;
              },
              actor?: Actor | null,
              ctx?: TxContext,
            ): Promise<Result<void>>;
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
            const releaseResult = await inventory.release(
              {
                entityId: lineItem.entityId,
                quantity: lineItem.quantity,
                orderId: order.id,
                performedBy: actor?.userId ?? "system",
                ...(lineItem.variantId != null
                  ? { variantId: lineItem.variantId }
                  : {}),
              },
              actor,
              ctx,
            );
            if (!releaseResult.ok) {
              const err = toCommerceError(releaseResult.error);
              // Tolerate a missing inventory record (nothing to release); surface
              // any other inventory error. Check the typed code, not the message.
              if (err.code !== "INVENTORY_RECORD_NOT_FOUND") {
                return Err(err);
              }
            }

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

  // ── Line-level refund policy primitives (issue #52) ─────────────────────

  private async refundPolicies(orgId: string, ctx?: TxContext): Promise<{
    cap: number | null;
    undoWindowMinutes: number;
    timezone: string;
  }> {
    const settings = this.deps.services.settings as
      | { read(orgId: string, group: string, ctx?: TxContext): Promise<Record<string, unknown>> }
      | undefined;
    const policies = (await settings?.read(orgId, "policies", ctx)) ?? {};
    const general = (await settings?.read(orgId, "general", ctx)) ?? {};
    return {
      cap: typeof policies.refundDailyCap === "number" ? policies.refundDailyCap : null,
      undoWindowMinutes:
        typeof policies.refundUndoWindowMinutes === "number"
          ? policies.refundUndoWindowMinutes
          : 15,
      timezone: typeof general.timezone === "string" ? general.timezone : "UTC",
    };
  }

  /**
   * Refunds specific line-item quantities (issue #52). Enforces per-line
   * refundable quantity (`quantity - refundedQuantity`), the operator's daily
   * refund cap (`policies.refundDailyCap`, 403 with the cap surfaced), moves
   * money through the payment adapter when the order has a captured payment,
   * and records an auditable `order_refunds` ledger row.
   */
  async refundLines(
    orderId: string,
    input: { lines: Array<{ lineItemId: string; quantity: number }>; reason?: string | undefined },
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<{ order: HydratedOrder; refund: OrderRefund }>> {
    try {
      assertPermission(actor, "orders:update");
    } catch (error) {
      return Err(toCommerceError(error));
    }
    const orgId = resolveOrgId(actor);
    const found = await this.repo.findWithLineItems(orgId, orderId, ctx);
    if (!found) return Err(new CommerceNotFoundError("Order not found."));
    if (input.lines.length === 0) {
      return Err(new CommerceValidationError("At least one line is required."));
    }
    // R-02: a terminal order (cancelled / fully refunded) cannot be line-refunded.
    if (this.machine.terminal.includes(found.order.status)) {
      return Err(
        new CommerceValidationError(
          `Cannot refund an order in terminal status "${found.order.status}".`,
        ),
      );
    }
    // R-03: a refund moves collected money — reject an unpaid order (otherwise a
    // "refund" is recorded against funds never taken). "Paid" is either a core
    // captured payment (checkout: amountCaptured > 0) or the order having left
    // the initial pending state (e.g. a completed POS/in-store sale). Only a
    // still-pending, uncaptured order is treated as unpaid.
    if ((found.order.amountCaptured ?? 0) <= 0 && found.order.status === "pending") {
      return Err(
        new CommerceValidationError(
          "Cannot refund an unpaid order (no captured payment and still pending).",
        ),
      );
    }

    const byId = new Map(found.lineItems.map((li) => [li.id, li]));
    const refundLines: Array<{ lineItemId: string; quantity: number; amount: number }> = [];
    for (const line of input.lines) {
      const lineItem = byId.get(line.lineItemId);
      if (!lineItem) {
        return Err(new CommerceNotFoundError(`Line item ${line.lineItemId} not found on this order.`));
      }
      if (!Number.isInteger(line.quantity) || line.quantity < 1) {
        return Err(new CommerceValidationError("Refund quantity must be a positive integer."));
      }
      const refundable = lineItem.quantity - lineItem.refundedQuantity;
      if (line.quantity > refundable) {
        return Err(
          new CommerceValidationError(
            `Line "${lineItem.title}" has ${refundable} refundable unit(s); requested ${line.quantity}.`,
          ),
        );
      }
      // Effective paid per unit: line total + tax − discount, split evenly.
      const lineValue = lineItem.totalPrice + lineItem.taxAmount - lineItem.discountAmount;
      const amount = Math.round((lineValue * line.quantity) / lineItem.quantity);
      refundLines.push({ lineItemId: lineItem.id, quantity: line.quantity, amount });
    }
    const totalAmount = refundLines.reduce((sum, l) => sum + l.amount, 0);

    const performedBy = actor?.userId ?? "system";
    const policies = await this.refundPolicies(orgId, ctx);
    if (policies.cap != null) {
      const usedToday = await this.repo.sumRefundsByOperatorToday(
        orgId,
        performedBy,
        policies.timezone,
        ctx,
      );
      if (usedToday + totalAmount > policies.cap) {
        return Err(
          new CommerceForbiddenError(
            `Daily refund cap exceeded: cap ${policies.cap}, used ${usedToday} today, requested ${totalAmount}.`,
          ),
        );
      }
    }

    // Move money if a captured payment exists — clamped to what remains.
    if (found.order.paymentIntentId && (found.order.amountCaptured ?? 0) > 0) {
      const payments = this.deps.services.payments as
        | { refund(paymentId: string, amount: number, reason?: string): Promise<unknown> }
        | undefined;
      if (payments?.refund) {
        const priorRefunds = await this.repo.findRefundsByOrderId(orderId, ctx);
        // Gross total incl. UNDONE refunds: undoRefund reverses the local ledger
        // but not the payment gateway, so that money already left. Counting only
        // "completed" would let refund → undo → refund re-issue a gateway refund
        // (F-04 / R-05 / R-07). Capping on gross keeps total payout ≤ captured.
        const alreadyRefunded = priorRefunds.reduce((sum, r) => sum + r.amount, 0);
        const refundable = Math.max(0, (found.order.amountCaptured ?? 0) - alreadyRefunded);
        const payAmount = Math.min(totalAmount, refundable);
        if (payAmount > 0) {
          await payments.refund(
            found.order.paymentIntentId,
            payAmount,
            input.reason ?? "line_refund",
          );
        }
      }
    }

    for (const line of refundLines) {
      const lineItem = byId.get(line.lineItemId)!;
      await this.repo.updateLineItem(
        line.lineItemId,
        { refundedQuantity: lineItem.refundedQuantity + line.quantity },
        ctx,
      );
    }
    const refund = await this.repo.createRefund(
      {
        organizationId: orgId,
        orderId,
        amount: totalAmount,
        reason: input.reason ?? null,
        lines: refundLines,
        performedBy,
      },
      ctx,
    );
    await this.repo.createStatusHistory(
      {
        orderId,
        fromStatus: found.order.status,
        toStatus: found.order.status,
        reason: `refund ${refund.id}: ${totalAmount} (${input.reason ?? "line refund"})`,
        changedBy: performedBy,
      },
      ctx,
    );

    const hydrated = await this.hydrateOrder(
      (await this.repo.findById(orgId, orderId, ctx))!,
      ctx,
    );
    return Ok({ order: hydrated, refund });
  }

  /**
   * Undoes a refund within the configured window
   * (`policies.refundUndoWindowMinutes`, default 15). Restores line
   * refundedQuantity and marks the ledger row `undone` — an audited,
   * compensating ledger operation; re-collecting the money (cash back into
   * the drawer) is the operator's side of the exchange.
   */
  async undoRefund(
    orderId: string,
    refundId: string,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<{ order: HydratedOrder; refund: OrderRefund }>> {
    try {
      assertPermission(actor, "orders:update");
    } catch (error) {
      return Err(toCommerceError(error));
    }
    const orgId = resolveOrgId(actor);
    const refund = await this.repo.findRefundById(orgId, refundId, ctx);
    if (!refund || refund.orderId !== orderId) {
      return Err(new CommerceNotFoundError("Refund not found."));
    }
    if (refund.status !== "completed") {
      return Err(new CommerceValidationError("Refund has already been undone."));
    }
    const policies = await this.refundPolicies(orgId, ctx);
    const ageMs = Date.now() - refund.createdAt.getTime();
    if (ageMs > policies.undoWindowMinutes * 60_000) {
      return Err(
        new CommerceValidationError(
          `Refund undo window (${policies.undoWindowMinutes} minutes) has passed.`,
        ),
      );
    }

    const performedBy = actor?.userId ?? "system";
    const undone = await this.repo.markRefundUndone(refundId, performedBy, ctx);
    if (!undone) {
      return Err(new CommerceValidationError("Refund has already been undone."));
    }
    for (const line of refund.lines) {
      const lineItem = await this.repo.findLineItemById(line.lineItemId, ctx);
      if (lineItem) {
        await this.repo.updateLineItem(
          line.lineItemId,
          { refundedQuantity: Math.max(0, lineItem.refundedQuantity - line.quantity) },
          ctx,
        );
      }
    }
    await this.repo.createStatusHistory(
      {
        orderId,
        fromStatus: "refund_completed",
        toStatus: "refund_undone",
        reason: `refund ${refundId} undone (${refund.amount})`,
        changedBy: performedBy,
      },
      ctx,
    );

    const order = await this.repo.findById(orgId, orderId, ctx);
    const hydrated = await this.hydrateOrder(order!, ctx);
    return Ok({ order: hydrated, refund: undone });
  }

  async listRefunds(
    orderId: string,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<OrderRefund[]>> {
    try {
      assertPermission(actor, "orders:read");
    } catch (error) {
      return Err(toCommerceError(error));
    }
    const orgId = resolveOrgId(actor);
    const order = await this.repo.findById(orgId, orderId, ctx);
    if (!order) return Err(new CommerceNotFoundError("Order not found."));
    return Ok(await this.repo.findRefundsByOrderId(orderId, ctx));
  }

  /** The acting operator's daily refund-cap status (issue #52). */
  async refundCapStatus(
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<{ cap: number | null; usedToday: number; remaining: number | null }>> {
    try {
      assertPermission(actor, "orders:read");
    } catch (error) {
      return Err(toCommerceError(error));
    }
    const orgId = resolveOrgId(actor);
    const policies = await this.refundPolicies(orgId, ctx);
    const usedToday = await this.repo.sumRefundsByOperatorToday(
      orgId,
      actor?.userId ?? "system",
      policies.timezone,
      ctx,
    );
    return Ok({
      cap: policies.cap,
      usedToday,
      remaining: policies.cap != null ? Math.max(0, policies.cap - usedToday) : null,
    });
  }

  // ── Order notes + activity timeline (issue #56) ─────────────────────────

  private async requireOrderAccess(
    orderId: string,
    actor: Actor | null,
    perm: "orders:read" | "orders:update",
    ctx?: TxContext,
  ): Promise<Result<Order>> {
    try {
      assertPermission(actor, perm);
    } catch (error) {
      return Err(toCommerceError(error));
    }
    const orgId = resolveOrgId(actor);
    const order = await this.repo.findById(orgId, orderId, ctx);
    if (!order) return Err(new CommerceNotFoundError("Order not found."));
    return Ok(order);
  }

  async addNote(
    orderId: string,
    input: { body: string; pinned?: boolean | undefined },
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<OrderNote>> {
    const order = await this.requireOrderAccess(orderId, actor, "orders:update", ctx);
    if (!order.ok) return order;
    if (!input.body.trim()) {
      return Err(new CommerceValidationError("Note body must not be empty."));
    }
    const note = await this.repo.createNote(
      {
        organizationId: order.value.organizationId,
        orderId,
        author: actor?.userId ?? "system",
        body: input.body,
        pinned: input.pinned ?? false,
      },
      ctx,
    );
    return Ok(note);
  }

  async listNotes(
    orderId: string,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<OrderNote[]>> {
    const order = await this.requireOrderAccess(orderId, actor, "orders:read", ctx);
    if (!order.ok) return order;
    return Ok(await this.repo.findNotesByOrderId(orderId, ctx));
  }

  async deleteNote(
    orderId: string,
    noteId: string,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<{ deleted: true }>> {
    const order = await this.requireOrderAccess(orderId, actor, "orders:update", ctx);
    if (!order.ok) return order;
    const deleted = await this.repo.deleteNote(order.value.organizationId, orderId, noteId, ctx);
    if (!deleted) return Err(new CommerceNotFoundError("Note not found."));
    return Ok({ deleted: true });
  }

  /**
   * One merged per-order activity view (issue #56): status history + operator
   * notes + refund ledger events (both directions), newest first.
   */
  async timeline(
    orderId: string,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<Array<{
    type: "status" | "note" | "refund";
    at: Date;
    actor: string;
    summary: string;
    data: Record<string, unknown>;
  }>>> {
    const order = await this.requireOrderAccess(orderId, actor, "orders:read", ctx);
    if (!order.ok) return order;

    const [history, notes, refunds] = await Promise.all([
      this.repo.findStatusHistoryByOrderId(orderId, ctx),
      this.repo.findNotesByOrderId(orderId, ctx),
      this.repo.findRefundsByOrderId(orderId, ctx),
    ]);

    const events: Array<{
      type: "status" | "note" | "refund";
      at: Date;
      actor: string;
      summary: string;
      data: Record<string, unknown>;
    }> = [];

    for (const entry of history) {
      events.push({
        type: "status",
        at: entry.changedAt,
        actor: entry.changedBy,
        summary: `Status ${entry.fromStatus} → ${entry.toStatus}${entry.reason ? ` (${entry.reason})` : ""}`,
        data: { fromStatus: entry.fromStatus, toStatus: entry.toStatus, reason: entry.reason },
      });
    }
    for (const note of notes) {
      events.push({
        type: "note",
        at: note.createdAt,
        actor: note.author,
        summary: note.body,
        data: { noteId: note.id, pinned: note.pinned },
      });
    }
    for (const refund of refunds) {
      events.push({
        type: "refund",
        at: refund.createdAt,
        actor: refund.performedBy,
        summary: `Refund of ${refund.amount}${refund.reason ? ` (${refund.reason})` : ""}`,
        data: { refundId: refund.id, amount: refund.amount, lines: refund.lines, status: refund.status },
      });
      if (refund.status === "undone" && refund.undoneAt) {
        events.push({
          type: "refund",
          at: refund.undoneAt,
          actor: refund.undoneBy ?? "system",
          summary: `Refund of ${refund.amount} undone`,
          data: { refundId: refund.id, amount: refund.amount, undone: true },
        });
      }
    }

    events.sort((a, b) => b.at.getTime() - a.at.getTime());
    return Ok(events);
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
    // Capture the full authorized total when no partial amount is given, and
    // pass it explicitly: Stripe captures the full authorized amount for an
    // omitted value, but not every adapter does — an ambiguous "no amount"
    // capture must never silently record 0.
    const amountToCapture = opts?.amount ?? order.grandTotal;
    const captureResult = await payments.capture(
      paymentIntentId,
      amountToCapture,
      paymentMethodId,
    );
    if (!captureResult.ok) {
      return Err(toCommerceError(captureResult.error));
    }

    // Trust the adapter's reported figure only when it sends a positive one;
    // otherwise record the amount we asked to capture (never a swallowed 0).
    const reported = captureResult.value?.amountCaptured;
    const amountCaptured = reported && reported > 0 ? reported : amountToCapture;
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

  /** Line items may not be edited on terminal or fully-captured orders. */
  private lineItemEditGuard(order: Order): CommerceValidationError | null {
    if (this.machine.terminal.includes(order.status)) {
      return new CommerceValidationError(
        `Order in terminal status "${order.status}" cannot be edited.`,
      );
    }
    if (
      order.amountCaptured != null &&
      order.amountCaptured >= order.grandTotal
    ) {
      return new CommerceValidationError(
        "Order payment is fully captured; line items cannot be edited.",
      );
    }
    // R-06: a checkout order carries a paymentIntentId. If amountCaptured is null
    // (auth-only capture, or a mock adapter reporting 0), treat it as authorized —
    // an order with a live payment must not have its lines silently edited/inflated.
    if (order.paymentIntentId != null && order.amountCaptured == null) {
      return new CommerceValidationError(
        "Order has an authorized payment; line items cannot be edited.",
      );
    }
    return null;
  }

  /**
   * Recomputes subtotal/taxTotal/grandTotal from the order's line items
   * (shippingTotal and order-level discountTotal are preserved), persists
   * them, and records an audit entry in the status history.
   */
  private async recalcOrderTotals(
    order: Order,
    actor: Actor | null,
    reason: string,
    ctx?: TxContext,
  ): Promise<HydratedOrder> {
    const lineItems = await this.repo.findLineItemsByOrderId(order.id, ctx);
    const subtotal = lineItems.reduce((sum, li) => sum + li.totalPrice, 0);
    const taxTotal = lineItems.reduce((sum, li) => sum + li.taxAmount, 0);
    const grandTotal =
      subtotal + taxTotal + order.shippingTotal - order.discountTotal;
    const updated = await this.repo.update(
      order.id,
      { subtotal, taxTotal, grandTotal },
      ctx,
    );
    await this.repo.createStatusHistory(
      {
        orderId: order.id,
        fromStatus: order.status,
        toStatus: order.status,
        reason,
        changedBy: actor?.userId ?? "system",
      },
      ctx,
    );
    return { ...(updated ?? order), lineItems };
  }

  async addLineItem(
    orderId: string,
    input: {
      entityId: string;
      entityType: string;
      variantId?: string | undefined;
      sku?: string | undefined;
      title: string;
      quantity: number;
      unitPrice: number;
      totalPrice?: number | undefined;
      taxAmount?: number | undefined;
      discountAmount?: number | undefined;
      metadata?: Record<string, unknown> | undefined;
    },
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<HydratedOrder>> {
    try {
      assertPermission(actor, "orders:update");
    } catch (error) {
      return Err(toCommerceError(error));
    }
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const order = await this.repo.findById(orgId, orderId, ctx);
    if (!order) return Err(new CommerceNotFoundError("Order not found."));
    const guard = this.lineItemEditGuard(order);
    if (guard) return Err(guard);

    // Org-integrity + price provenance for the added line (same rules as create):
    // the entity must belong to the order's org, and the price is server-derived
    // unless the actor holds `orders:manage` (then honored + flagged isCustomPrice).
    const resolvedResult = await this.resolveLines(
      {
        currency: order.currency,
        subtotal: 0,
        taxTotal: 0,
        shippingTotal: 0,
        grandTotal: 0,
        lineItems: [
          {
            entityId: input.entityId,
            entityType: input.entityType,
            title: input.title,
            quantity: input.quantity,
            unitPrice: input.unitPrice,
            totalPrice: input.totalPrice ?? input.unitPrice * input.quantity,
            ...(input.variantId !== undefined ? { variantId: input.variantId } : {}),
            ...(input.sku !== undefined ? { sku: input.sku } : {}),
            ...(input.taxAmount !== undefined ? { taxAmount: input.taxAmount } : {}),
            ...(input.discountAmount !== undefined
              ? { discountAmount: input.discountAmount }
              : {}),
            ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
          },
        ],
        ...(order.customerId ? { customerId: order.customerId } : {}),
      },
      actor,
      false,
      ctx,
    );
    if (!resolvedResult.ok) return Err(resolvedResult.error);
    const line = resolvedResult.value[0]!;

    await this.repo.createLineItems(
      [
        {
          orderId: order.id,
          entityId: line.entityId,
          entityType: line.entityType,
          title: line.title,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          totalPrice: line.totalPrice ?? line.unitPrice * line.quantity,
          isCustomPrice: line.isCustomPrice,
          taxAmount: line.taxAmount ?? 0,
          discountAmount: line.discountAmount ?? 0,
          fulfillmentStatus: "unfulfilled",
          metadata: line.metadata ?? {},
          ...(line.variantId !== undefined ? { variantId: line.variantId } : {}),
          ...(line.sku !== undefined ? { sku: line.sku } : {}),
        },
      ],
      ctx,
    );

    return Ok(await this.recalcOrderTotals(order, actor, "line_item_added", ctx));
  }

  async updateOrderLineItem(
    orderId: string,
    lineItemId: string,
    patch: { quantity: number },
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<HydratedOrder>> {
    try {
      assertPermission(actor, "orders:update");
    } catch (error) {
      return Err(toCommerceError(error));
    }
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const order = await this.repo.findById(orgId, orderId, ctx);
    if (!order) return Err(new CommerceNotFoundError("Order not found."));
    const guard = this.lineItemEditGuard(order);
    if (guard) return Err(guard);

    const line = await this.repo.findLineItemById(lineItemId, ctx);
    if (!line || line.orderId !== order.id) {
      return Err(new CommerceNotFoundError("Line item not found on this order."));
    }
    if (line.fulfillmentStatus !== "unfulfilled") {
      return Err(
        new CommerceValidationError(
          "Line items with fulfillment progress cannot be adjusted.",
        ),
      );
    }
    if (patch.quantity < 1) {
      return Err(new CommerceValidationError("Quantity must be at least 1."));
    }

    // Scale line totals with the quantity change (tax scales per-unit).
    const perUnitTax = line.quantity > 0 ? line.taxAmount / line.quantity : 0;
    await this.repo.updateLineItem(
      lineItemId,
      {
        quantity: patch.quantity,
        totalPrice: line.unitPrice * patch.quantity,
        taxAmount: Math.round(perUnitTax * patch.quantity),
      },
      ctx,
    );

    return Ok(await this.recalcOrderTotals(order, actor, "line_item_updated", ctx));
  }

  async removeLineItem(
    orderId: string,
    lineItemId: string,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<HydratedOrder>> {
    try {
      assertPermission(actor, "orders:update");
    } catch (error) {
      return Err(toCommerceError(error));
    }
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const order = await this.repo.findById(orgId, orderId, ctx);
    if (!order) return Err(new CommerceNotFoundError("Order not found."));
    const guard = this.lineItemEditGuard(order);
    if (guard) return Err(guard);

    const line = await this.repo.findLineItemById(lineItemId, ctx);
    if (!line || line.orderId !== order.id) {
      return Err(new CommerceNotFoundError("Line item not found on this order."));
    }
    if (line.fulfillmentStatus !== "unfulfilled") {
      return Err(
        new CommerceValidationError(
          "Line items with fulfillment progress cannot be removed.",
        ),
      );
    }
    const existing = await this.repo.findLineItemsByOrderId(order.id, ctx);
    if (existing.length <= 1) {
      return Err(
        new CommerceValidationError("An order must keep at least one line item."),
      );
    }

    await this.repo.deleteLineItem(lineItemId, ctx);

    return Ok(await this.recalcOrderTotals(order, actor, "line_item_removed", ctx));
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
