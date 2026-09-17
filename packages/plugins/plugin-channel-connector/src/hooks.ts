import { resolveOrgIdForCommerce } from "@porulle/core";
import type {
  Actor,
  CommerceConfig,
  HookContext,
  PluginHookRegistration,
} from "@porulle/core";
import { and, eq, inArray } from "@porulle/core/drizzle";
import { sellableEntities } from "@porulle/core/schema";
import {
  ChannelConnectorService,
  type ChannelConnectorPluginOptions,
  type ChannelPushTrigger,
  type ChannelStockLine,
} from "./service.js";
import {
  handleCatalogAfterUpdate,
  recordUpdateFieldPaths,
} from "./catalog-push-trigger.js";

/**
 * The state an order sits in while it waits for a payment gateway. Core owns it
 * and its machine runs `pending_payment -> confirmed | cancelled`.
 */
const PENDING_PAYMENT = "pending_payment";

/** The committed order, as much of it as the push needs. */
interface PushOrderResult {
  id: string;
  status: string | undefined;
  entityIds: string[];
}

/** The transition that produced a committed order, on `orders.afterStatusChange`. */
interface StatusTransition {
  fromStatus: string;
  newStatus: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Parse the committed order out of a hook payload rather than asserting its
 * shape. The kernel is a trust boundary for this plugin: an order that arrives
 * without an `id`, or whose line items are not the shape we expect, is skipped
 * rather than pushed against a half-read payload.
 *
 * `orders.afterCreate` and `orders.afterStatusChange` both deliver the committed
 * order as `result`, so one parser serves both.
 */
function parseOrderResult(args: unknown): PushOrderResult | null {
  if (!isRecord(args)) return null;
  const { result } = args;
  if (!isRecord(result)) return null;
  const { id, status, lineItems } = result;
  if (typeof id !== "string" || id === "") return null;

  const entityIds = Array.isArray(lineItems)
    ? lineItems.flatMap((line) =>
      isRecord(line) && typeof line.entityId === "string" ? [line.entityId] : []
    )
    : [];

  return {
    id,
    status: typeof status === "string" ? status : undefined,
    entityIds,
  };
}

/**
 * Parse the transition from a hook payload. `data` carries it on
 * `orders.afterStatusChange`; a payload without both statuses is not a
 * transition this plugin can reason about, so it pushes nothing.
 */
function parseStatusTransition(args: unknown): StatusTransition | null {
  if (!isRecord(args)) return null;
  const { data } = args;
  if (!isRecord(data)) return null;
  const { fromStatus, newStatus } = data;
  if (typeof fromStatus !== "string" || typeof newStatus !== "string") return null;
  return { fromStatus, newStatus };
}

/**
 * Narrow a hook payload to one carrying the kernel's own `HookContext`.
 *
 * A type predicate rather than a cast: the capabilities it carries are live
 * objects — a Drizzle handle and a jobs adapter — which cannot be validated by
 * shape, so this checks that they are present and callable and lets the kernel's
 * published type describe them. A payload missing either is skipped rather than
 * pushed against.
 */
function hasHookContext(args: unknown): args is { context: HookContext } {
  if (!isRecord(args)) return false;
  const { context } = args;
  if (!isRecord(context)) return false;
  const { db, jobs } = context;
  return (
    isRecord(db) &&
    isRecord(jobs) &&
    typeof jobs.enqueue === "function"
  );
}

/**
 * Enqueue one `channel/push-order` job per store that owns a line of this order.
 * `concurrencyKey` + `supersedes` collapse repeats on the same order and store.
 */
async function pushForOrder(
  order: PushOrderResult,
  context: HookContext,
): Promise<void> {
  if (order.entityIds.length === 0) return;
  const orgId = resolveOrgIdForCommerce(context.actor, context.commerceConfig);

  const entities = await context.db
    .select({
      id: sellableEntities.id,
      sourceStoreId: sellableEntities.sourceStoreId,
    })
    .from(sellableEntities)
    .where(and(
      eq(sellableEntities.organizationId, orgId),
      inArray(sellableEntities.id, order.entityIds),
    ));

  const stores = new Set(
    entities
      .map((entity) => entity.sourceStoreId)
      .filter((storeId): storeId is string => storeId !== null),
  );

  await Promise.all([...stores].map((storeId) =>
    context.jobs.enqueue(
      "channel/push-order",
      { orgId, storeId, orderId: order.id },
      {
        organizationId: orgId,
        concurrencyKey: `push:${order.id}:${storeId}`,
        supersedes: true,
      },
    )
  ));
}

/**
 * The hooks that trigger the order push, by mode. The switch is exhaustive over
 * `ChannelPushTrigger`, so a fourth mode fails to compile rather than silently
 * registering nothing.
 *
 * `"payment"` registers BOTH hooks on purpose. An order created directly in
 * `pending` — a store with no payment step, which is most consumers — never
 * transitions out of `pending_payment`, so dropping `orders.afterCreate`
 * entirely would silently stop pushing for them.
 *
 * On the transition side the predicate is `fromStatus === PENDING_PAYMENT`, not
 * "the new status looks paid". That is exactly-once by construction: core
 * commits the status with a compare-and-swap, so only one caller wins a given
 * transition. Keying on the new status alone would re-push on every later move
 * (`confirmed -> processing -> fulfilled`), and `exportOrder` short-circuits only
 * on an already-`confirmed` export — one still `exported` is pushed again.
 */
function pushHooks(mode: ChannelPushTrigger): PluginHookRegistration[] {
  switch (mode) {
    case false:
      return [];

    case "create":
      return [{
        key: "orders.afterCreate",
        async handler(args: unknown) {
          const order = parseOrderResult(args);
          if (order === null || !hasHookContext(args)) return;
          await pushForOrder(order, args.context);
        },
      }];

    case "payment":
      return [{
        key: "orders.afterCreate",
        async handler(args: unknown) {
          const order = parseOrderResult(args);
          if (order === null || !hasHookContext(args)) return;
          // A gateway order waits for its notify; anything else is unchanged.
          if (order.status === PENDING_PAYMENT) return;
          await pushForOrder(order, args.context);
        },
      }, {
        key: "orders.afterStatusChange",
        async handler(args: unknown) {
          const transition = parseStatusTransition(args);
          const order = parseOrderResult(args);
          if (transition === null || order === null || !hasHookContext(args)) return;
          if (transition.fromStatus !== PENDING_PAYMENT) return;
          if (transition.newStatus === "cancelled") return;
          await pushForOrder(order, args.context);
        },
      }];
  }
}

export function buildHooks(options: ChannelConnectorPluginOptions): PluginHookRegistration[] {
  return [{
    key: "checkout.beforePayment",
    async handler(args: unknown) {
      const { data, context } = args as {
        data: { lineItems: ChannelStockLine[] };
        context: {
          actor: Actor | null;
          commerceConfig?: CommerceConfig | null;
          db: ConstructorParameters<typeof ChannelConnectorService>[0];
          services: Record<string, unknown>;
        };
      };
      if (data.lineItems.length === 0) return data;
      const service = new ChannelConnectorService(context.db, context.services, options);
      await service.validateLineStock(
        resolveOrgIdForCommerce(context.actor, context.commerceConfig),
        data.lineItems,
        options.inventoryTimeoutMs,
      );
      return data;
    },
  },
  ...pushHooks(options.pushOrderOn ?? "payment"),
  {
    key: "catalog.beforeUpdate",
    handler(args: unknown) {
      const { data, context } = args as {
        data: Parameters<typeof recordUpdateFieldPaths>[0];
        context: Parameters<typeof recordUpdateFieldPaths>[1];
      };
      return recordUpdateFieldPaths(data, context);
    },
  }, {
    key: "catalog.afterUpdate",
    async handler(args: unknown) {
      const { result, context } = args as {
        result: { id: string };
        context: Parameters<typeof handleCatalogAfterUpdate>[0]["context"];
      };
      await handleCatalogAfterUpdate({ result, context });
    },
  }];
}
