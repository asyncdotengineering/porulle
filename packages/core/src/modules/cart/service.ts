import { resolveOrgId } from "../../auth/org.js";
import { assertOwnership, assertPermission } from "../../auth/permissions.js";
import type { Actor } from "../../auth/types.js";
import type { CommerceConfig } from "../../config/types.js";
import {
  CommerceForbiddenError,
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
import { Err, Ok, type Result } from "../../kernel/result.js";
import { createLogger } from "../../utils/logger.js";
import { paginate, type Pagination } from "../../utils/pagination.js";
import type { DatabaseAdapter } from "../../kernel/database/adapter.js";
import type { PluginDb } from "../../kernel/database/plugin-types.js";
import type { TxContext } from "../../kernel/database/tx-context.js";
import { CartRepository, type Cart, type CartLineItem } from "./repository/index.js";
import type { CatalogRepository } from "../catalog/repository/index.js";

export type {
  CreateCartInput,
  AddCartItemInput,
  UpdateCartItemInput,
} from "./schemas.js";

import type {
  CreateCartInput,
  AddCartItemInput,
  UpdateCartItemInput,
} from "./schemas.js";

import { defaultCartItemMatcher, type CartItemMatcher } from "./matcher.js";

export interface CartServiceDeps {
  repository: CartRepository;
  catalogRepository: CatalogRepository;
  hooks: HookRegistry;
  config: CommerceConfig;
  services: Record<string, unknown>;
  database: DatabaseAdapter;
  cartItemMatcher?: CartItemMatcher;
}

type CartAddBeforeHook = BeforeHook<AddCartItemInput>;
type CartAddAfterHook = AfterHook<CartLineItem>;
type CartRemoveBeforeHook = BeforeHook<CartLineItem>;
type CartRemoveAfterHook = AfterHook<CartLineItem>;
type CartUpdateBeforeHook = BeforeHook<UpdateCartItemInput>;
type CartUpdateAfterHook = AfterHook<CartLineItem>;

function makeContext(
  actor: Actor | null,
  services: Record<string, unknown>,
  database: DatabaseAdapter,
  tx: unknown = null,
): HookContext {
  return createHookContext({
    actor,
    tx,
    logger: createLogger("cart"),
    services,
    context: { moduleName: "cart" },
    database: { db: database.db as PluginDb },
  });
}

function isExpired(cart: Cart): boolean {
  return cart.expiresAt.getTime() < Date.now();
}

export class CartService {
  private readonly repo: CartRepository;
  private readonly catalogRepo: CatalogRepository;

  constructor(private deps: CartServiceDeps) {
    this.repo = deps.repository;
    this.catalogRepo = deps.catalogRepository;
  }

  async create(
    input: CreateCartInput,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<Cart>> {
    try {
      assertPermission(actor ?? null, "cart:create");
    } catch (error) {
      return Err(toCommerceError(error));
    }

    const ttlMinutes = this.deps.config.cart?.ttlMinutes ?? 60 * 24 * 7;
    const now = new Date();
    const orgId = resolveOrgId(actor ?? null);

    // SECURITY: cart.customerId is service-managed.
    //
    // VAPT r2 (claude-glm) follow-up: the previous "set null for customer
    // role" fix made every customer cart a "guest cart", which the cart
    // ownership check treated as accessible-to-anyone-with-the-UUID.
    // Cross-customer cart hijack was the consequence — customer B could
    // read/add/update/delete items on customer A's cart by knowing the UUID.
    //
    // The right model: customer-role actors get cart.customerId resolved
    // from their session via the customers service (lookup-or-create). The
    // ownership check in assertCartReadAccess and assertCartOwnership then
    // matches actor.userId against the customer profile owned by that user.
    // Staff / admin / agent: trusted, may supply customerId for POS / agent
    // assist. Anonymous (no actor): null customerId, secret-gated.
    const STAFF_ROLES = new Set(["staff", "admin", "owner", "ai_agent", "service"]);
    const isStaffActor =
      actor != null &&
      typeof actor.role === "string" &&
      STAFF_ROLES.has(actor.role);

    let resolvedCustomerId: string | null = null;
    if (isStaffActor) {
      resolvedCustomerId = input.customerId ?? null;
    } else if (actor?.userId) {
      // Customer-role actor: bind cart to their customer profile UUID.
      // customers.getByUserId is lookup-or-create; subsequent reads/writes
      // can match the cart's customerId against the same UUID via this
      // service to assert ownership.
      const customers = this.deps.services.customers as
        | {
            getByUserId(
              userId: string,
              actor?: Actor | null,
              ctx?: TxContext,
            ): Promise<{ ok: true; value: { id: string } } | { ok: false; error: unknown }>;
          }
        | undefined;
      if (customers?.getByUserId) {
        const profileResult = await customers.getByUserId(actor.userId, actor, ctx);
        if (profileResult.ok) {
          resolvedCustomerId = profileResult.value.id;
        }
      }
    }

    const cart = await this.repo.create(
      {
        organizationId: orgId,
        status: "active",
        currency: input.currency ?? "USD",
        metadata: input.metadata ?? {},
        expiresAt: new Date(now.getTime() + ttlMinutes * 60 * 1000),
        ...(resolvedCustomerId !== null ? { customerId: resolvedCustomerId } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
      },
      ctx,
    );

    return Ok(cart);
  }

  async getById(
    id: string,
    actor?: Actor | null,
    ctx?: TxContext,
    secret?: string,
  ): Promise<Result<Cart & { lineItems: CartLineItem[] }>> {
    // VAPT r2 (codex) finding: cart.getById had no permission gate AND
    // assertCartOwnership returned early for guest carts (customerId == null)
    // and for anonymous actors. Anyone who knew or guessed a cart UUID could
    // read any cart's contents, prices, line items, and metadata. This now
    // requires either an authenticated owner/staff actor OR the cart's
    // secret token (returned only at createGuest()).
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const cart = await this.repo.findById(orgId, id, ctx);
    if (!cart) return Err(new CommerceNotFoundError("Cart not found."));

    try {
      await this.assertCartReadAccess(actor ?? null, cart, secret, ctx);
    } catch (error) {
      return Err(toCommerceError(error));
    }

    if (isExpired(cart) && cart.status === "active") {
      await this.repo.updateStatus(cart.id, "abandoned", ctx);
      cart.status = "abandoned";
    }

    const lineItems = await this.repo.findLineItemsByCartId(id, ctx);
    return Ok({
      ...cart,
      lineItems,
    });
  }

  async addItem(
    input: AddCartItemInput,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<CartLineItem>> {
    try {
      assertPermission(actor ?? null, "cart:update");
    } catch (error) {
      return Err(toCommerceError(error));
    }

    const orgId = resolveOrgId(actor ?? null);
    const cart = await this.repo.findById(orgId, input.cartId, ctx);
    if (!cart) return Err(new CommerceNotFoundError("Cart not found."));

    try {
      await this.assertCartOwnership(actor ?? null, cart, ctx);
    } catch (error) {
      return Err(toCommerceError(error));
    }

    if (cart.status !== "active") {
      return Err(new CommerceValidationError("Cart is not active."));
    }

    const quantity = input.quantity ?? 1;
    if (quantity <= 0) {
      return Err(
        new CommerceValidationError("Quantity must be greater than zero."),
      );
    }

    // Validate entity exists
    const entity = await this.catalogRepo.findEntityById(input.entityId, ctx);
    if (!entity) return Err(new CommerceNotFoundError("Entity not found."));

    // Check if entity has variants
    const entityVariants = await this.catalogRepo.findVariantsByEntityId(
      input.entityId,
      ctx,
    );
    const hasVariants = entityVariants.length > 0;
    if (hasVariants && !input.variantId) {
      const variantIds = entityVariants.map((v) => v.id);
      return Err(
        new CommerceValidationError(
          `Entity "${entity.slug}" has variants enabled, but no variantId was provided.`,
          [
            {
              field: "variantId",
              message: `Available variants: ${variantIds.join(", ")}`,
            },
          ],
        ),
      );
    }

    const context = makeContext(actor ?? null, this.deps.services, this.deps.database, ctx?.tx);
    const beforeHooks = this.deps.hooks.resolve(
      "cart.beforeAddItem",
    ) as CartAddBeforeHook[];
    const afterHooks = this.deps.hooks.resolve(
      "cart.afterAddItem",
    ) as CartAddAfterHook[];

    const processed = await runBeforeHooks(
      beforeHooks,
      input,
      "addItem",
      context,
    );

    // CartItemMatcher: deduplicate by merging quantity into existing matching item
    const matcher = this.deps.cartItemMatcher ?? defaultCartItemMatcher;
    const existingItems = await this.repo.findLineItemsByCartId(
      input.cartId,
      ctx,
    );
    const match = existingItems.find((existing) =>
      matcher({
        existingItem: existing,
        newItem: {
          ...processed,
          variantId: processed.variantId ?? null,
        },
      }),
    );

    let item: CartLineItem;
    if (match) {
      const updated = await this.repo.updateLineItem(
        match.id,
        { quantity: match.quantity + quantity },
        ctx,
      );
      item = updated!;
    } else {
      item = await this.repo.createLineItem(
        {
          cartId: input.cartId,
          entityId: processed.entityId,
          quantity,
          unitPriceSnapshot: processed.unitPriceSnapshot ?? 1000,
          currency: processed.currency ?? cart.currency,
          metadata: processed.metadata ?? {},
          ...(processed.variantId !== undefined
            ? { variantId: processed.variantId }
            : {}),
        },
        ctx,
      );
    }

    await runAfterHooks(afterHooks, null, item, "addItem", context);

    return Ok(item);
  }

  async removeItem(
    cartId: string,
    itemId: string,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<void>> {
    try {
      assertPermission(actor ?? null, "cart:update");
    } catch (error) {
      return Err(toCommerceError(error));
    }

    const orgId = resolveOrgId(actor ?? null);
    const cart = await this.repo.findById(orgId, cartId, ctx);
    if (!cart) return Err(new CommerceNotFoundError("Cart not found."));

    try {
      await this.assertCartOwnership(actor ?? null, cart, ctx);
    } catch (error) {
      return Err(toCommerceError(error));
    }

    const existing = await this.repo.findLineItemById(itemId, ctx);
    if (!existing || existing.cartId !== cartId) {
      return Err(new CommerceNotFoundError("Cart item not found."));
    }

    const context = makeContext(actor ?? null, this.deps.services, this.deps.database, ctx?.tx);
    const beforeHooks = this.deps.hooks.resolve(
      "cart.beforeRemoveItem",
    ) as CartRemoveBeforeHook[];
    const afterHooks = this.deps.hooks.resolve(
      "cart.afterRemoveItem",
    ) as CartRemoveAfterHook[];
    await runBeforeHooks(beforeHooks, existing, "removeItem", context);

    await this.repo.deleteLineItem(itemId, ctx);

    await runAfterHooks(afterHooks, existing, existing, "removeItem", context);
    return Ok(undefined);
  }

  async updateQuantity(
    input: UpdateCartItemInput,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<CartLineItem>> {
    try {
      assertPermission(actor ?? null, "cart:update");
    } catch (error) {
      return Err(toCommerceError(error));
    }

    const orgId = resolveOrgId(actor ?? null);
    const cart = await this.repo.findById(orgId, input.cartId, ctx);
    if (!cart) return Err(new CommerceNotFoundError("Cart not found."));

    try {
      await this.assertCartOwnership(actor ?? null, cart, ctx);
    } catch (error) {
      return Err(toCommerceError(error));
    }

    const item = await this.repo.findLineItemById(input.itemId, ctx);
    if (!item || item.cartId !== input.cartId) {
      return Err(new CommerceNotFoundError("Cart item not found."));
    }

    if (input.quantity <= 0) {
      return Err(
        new CommerceValidationError("Quantity must be greater than zero."),
      );
    }

    const context = makeContext(actor ?? null, this.deps.services, this.deps.database, ctx?.tx);
    const beforeHooks = this.deps.hooks.resolve(
      "cart.beforeUpdateQuantity",
    ) as CartUpdateBeforeHook[];
    const afterHooks = this.deps.hooks.resolve(
      "cart.afterUpdateQuantity",
    ) as CartUpdateAfterHook[];

    await runBeforeHooks(beforeHooks, input, "update", context);

    const updated = await this.repo.updateLineItem(
      input.itemId,
      { quantity: input.quantity },
      ctx,
    );

    if (!updated) {
      return Err(new CommerceNotFoundError("Cart item not found."));
    }

    await runAfterHooks(afterHooks, item, updated, "update", context);
    return Ok(updated);
  }

  async merge(
    sourceCartId: string,
    targetCartId: string,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<void>> {
    try {
      assertPermission(actor ?? null, "cart:update");
    } catch (error) {
      return Err(toCommerceError(error));
    }

    const orgId = resolveOrgId(actor ?? null);
    const source = await this.repo.findById(orgId, sourceCartId, ctx);
    const target = await this.repo.findById(orgId, targetCartId, ctx);
    if (!source || !target)
      return Err(new CommerceNotFoundError("Cart not found."));

    const sourceItems = await this.repo.findLineItemsByCartId(
      sourceCartId,
      ctx,
    );

    // Move items from source to target
    for (const item of sourceItems) {
      await this.repo.createLineItem(
        {
          cartId: targetCartId,
          entityId: item.entityId,
          variantId: item.variantId,
          quantity: item.quantity,
          unitPriceSnapshot: item.unitPriceSnapshot,
          currency: item.currency,
          metadata: item.metadata ?? {},
        },
        ctx,
      );
    }

    // Clear source cart items and mark as merged
    await this.repo.deleteLineItemsByCartId(sourceCartId, ctx);
    await this.repo.updateStatus(sourceCartId, "merged", ctx);

    return Ok(undefined);
  }

  /**
   * Admin listing of carts with abandoned-checkout recovery filters:
   * status, olderThan (not touched since), hasCustomer, plus pagination.
   * Returns shopper identity (cart email + linked customer email).
   */
  async list(
    filter?: {
      status?: string;
      olderThan?: Date;
      hasCustomer?: boolean;
      page?: number;
      limit?: number;
    },
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<{ items: Array<Cart & { customerEmail: string | null }>; pagination: Pagination }>> {
    try {
      assertPermission(actor ?? null, "cart:manage");
    } catch (error) {
      return Err(toCommerceError(error));
    }
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const rows = await this.repo.list(
      orgId,
      {
        ...(filter?.status !== undefined ? { status: filter.status } : {}),
        ...(filter?.olderThan !== undefined ? { olderThan: filter.olderThan } : {}),
        ...(filter?.hasCustomer !== undefined ? { hasCustomer: filter.hasCustomer } : {}),
      },
      ctx,
    );
    const paged = paginate(rows, filter?.page ?? 1, filter?.limit ?? 20);
    return Ok({ items: paged.items, pagination: paged.pagination });
  }

  /**
   * Abandoned-checkout recovery primitive: reactivates the cart, extends its
   * expiry, and returns a resume secret that gates guest access to the cart —
   * enough to build a recovery email with a resume/checkout link.
   * Fires the `cart.afterRecover` hook so plugins/webhooks can react.
   */
  async recover(
    cartId: string,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<
    Result<{
      cartId: string;
      secret: string;
      status: string;
      expiresAt: string;
      email: string | null;
      customerId: string | null;
    }>
  > {
    try {
      assertPermission(actor ?? null, "cart:manage");
    } catch (error) {
      return Err(toCommerceError(error));
    }
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const cart = await this.repo.findById(orgId, cartId, ctx);
    if (!cart) return Err(new CommerceNotFoundError("Cart not found."));
    if (cart.status === "checked_out" || cart.status === "merged" || cart.status === "checking_out") {
      return Err(
        new CommerceValidationError(
          `Cart with status "${cart.status}" cannot be recovered.`,
        ),
      );
    }

    const secret = cart.secret ?? crypto.randomUUID();
    const ttlMinutes = this.deps.config.cart?.ttlMinutes ?? 60 * 24 * 7;
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
    const updated = await this.repo.update(
      cart.id,
      { status: "active", secret, expiresAt },
      ctx,
    );

    const afterHooks = this.deps.hooks.resolve("cart.afterRecover") as AfterHook<Cart>[];
    await runAfterHooks(
      afterHooks,
      null,
      updated ?? cart,
      "recover",
      makeContext(actor ?? null, this.deps.services, this.deps.database, ctx?.tx ?? null),
    );

    return Ok({
      cartId: cart.id,
      secret,
      status: "active",
      expiresAt: expiresAt.toISOString(),
      email: cart.email ?? null,
      customerId: cart.customerId ?? null,
    });
  }

  async abandon(cartId: string, actor?: Actor | null, ctx?: TxContext): Promise<Result<void>> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const cart = await this.repo.findById(orgId, cartId, ctx);
    if (!cart) return Err(new CommerceNotFoundError("Cart not found."));

    await this.repo.updateStatus(cartId, "abandoned", ctx);
    return Ok(undefined);
  }

  async markAsCheckedOut(
    cartId: string,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<void>> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const cart = await this.repo.findById(orgId, cartId, ctx);
    if (!cart) return Err(new CommerceNotFoundError("Cart not found."));

    await this.repo.updateStatus(cartId, "checked_out", ctx);
    return Ok(undefined);
  }

  /**
   * Atomically transitions a cart from "active" to "checking_out".
   * Returns Err if the cart was already claimed by a concurrent checkout.
   * This prevents TOCTOU race conditions on double-checkout.
   */
  async claimForCheckout(
    cartId: string,
    ctx?: TxContext,
  ): Promise<Result<Cart>> {
    const claimed = await this.repo.transitionToCheckingOut(cartId, ctx);
    if (!claimed) {
      return Err(
        new CommerceValidationError(
          "Cart is not available for checkout. It may have already been checked out by a concurrent request.",
        ),
      );
    }
    return Ok(claimed);
  }

  /**
   * Creates an anonymous guest cart with a secret token for access control.
   * The secret must be stored client-side (cookie/local storage) and sent
   * with subsequent requests to identify the cart owner.
   */
  async createGuestCart(
    currency = "USD",
    ctx?: TxContext,
  ): Promise<Result<{ cart: Cart; secret: string }>> {
    const secret = crypto.randomUUID();
    const ttlMinutes = this.deps.config.cart?.ttlMinutes ?? 60 * 24 * 7;
    const now = new Date();

    const cart = await this.repo.create(
      {
        organizationId: resolveOrgId(null),
        customerId: undefined,
        status: "active",
        currency,
        secret,
        metadata: {},
        expiresAt: new Date(now.getTime() + ttlMinutes * 60 * 1000),
      },
      ctx,
    );

    return Ok({ cart, secret });
  }

  /**
   * Merges a guest (source) cart into an authenticated (target) cart on login.
   * Uses addItem() internally so CartItemMatcher deduplication is applied.
   * The source cart's secret must be provided for access control.
   */
  async mergeCarts(
    targetCartId: string,
    sourceCartId: string,
    sourceSecret: string,
    actor: Actor,
    ctx?: TxContext,
  ): Promise<Result<Cart>> {
    const orgId = resolveOrgId(actor);
    const sourceCart = await this.repo.findById(orgId, sourceCartId, ctx);
    if (!sourceCart || sourceCart.secret !== sourceSecret) {
      return Err(
        new CommerceValidationError("Invalid cart or cart secret."),
      );
    }

    const targetCart = await this.repo.findById(orgId, targetCartId, ctx);
    if (!targetCart) {
      return Err(new CommerceNotFoundError("Target cart not found."));
    }

    const sourceItems = await this.repo.findLineItemsByCartId(
      sourceCartId,
      ctx,
    );

    for (const item of sourceItems) {
      await this.addItem(
        {
          cartId: targetCartId,
          entityId: item.entityId,
          quantity: item.quantity,
          ...(item.variantId != null ? { variantId: item.variantId } : {}),
          unitPriceSnapshot: item.unitPriceSnapshot,
          currency: item.currency,
          metadata: item.metadata ?? {},
        },
        actor,
        ctx,
      );
    }

    // Mark source cart as merged
    await this.repo.updateStatus(sourceCartId, "merged", ctx);

    const mergedCart = await this.repo.findById(orgId, targetCartId, ctx);
    return Ok(mergedCart!);
  }

  /**
   * Resolves the actor's customer profile UUID.
   * Returns null if actor is anonymous or has no associated customer profile.
   * Cart.customerId is bound to the customer profile UUID, not the Better
   * Auth user.id, so ownership checks must resolve the profile first.
   */
  private async resolveActorCustomerId(
    actor: Actor | null,
    ctx: TxContext | undefined,
  ): Promise<string | null> {
    if (!actor?.userId) return null;
    const customers = this.deps.services.customers as
      | {
          getByUserId(
            userId: string,
            actor?: Actor | null,
            ctx?: TxContext,
          ): Promise<{ ok: true; value: { id: string } } | { ok: false; error: unknown }>;
        }
      | undefined;
    if (!customers?.getByUserId) return null;
    const result = await customers.getByUserId(actor.userId, actor, ctx);
    return result.ok ? result.value.id : null;
  }

  /**
   * Cart-write ownership policy (used by addItem, updateQuantity, removeItem):
   *   - Admin/staff (permissions include *:*) — bypass.
   *   - Customer role: cart.customerId must match the actor's customer
   *     profile UUID. Without this match, customer B was able to write
   *     to customer A's cart by UUID (claude-glm finding).
   *   - Guest cart (customerId null): only the cart-secret holder may write.
   *     Without a presented secret, deny — the previous "anyone can write
   *     to a guest cart" behavior allowed cross-customer hijack of the
   *     post-A1-fix orphan carts.
   */
  private async assertCartOwnership(
    actor: Actor | null,
    cart: Cart,
    ctx: TxContext | undefined,
    presentedSecret?: string,
  ): Promise<void> {
    if (actor && actor.permissions.includes("*:*")) return;

    // Staff / admin / ai_agent / service may modify any cart in their org
    // (POS, AI assist). They already cleared cart:update at the entry to
    // the calling method.
    const STAFF = new Set(["staff", "admin", "owner", "ai_agent", "service"]);
    const role = (actor as { role?: string } | null)?.role;
    if (actor && role && STAFF.has(role)) return;

    if (cart.customerId == null) {
      // Guest cart — must present the cart secret to write.
      if (presentedSecret && cart.secret && presentedSecret === cart.secret) {
        return;
      }
      throw new CommerceForbiddenError(
        "Cart secret required to modify guest cart.",
      );
    }

    if (!actor) {
      throw new CommerceForbiddenError(
        "Authentication required to modify customer cart.",
      );
    }

    const profileId = await this.resolveActorCustomerId(actor, ctx);
    if (profileId !== cart.customerId) {
      throw new CommerceForbiddenError(
        "You do not have access to this resource.",
      );
    }
  }

  /**
   * Cart-read access policy:
   *   - *:* permission — bypass (admins).
   *   - Customer cart (customerId set): authenticated actor's customer
   *     profile UUID must match cart.customerId.
   *   - Guest cart (customerId null): require the presented cart secret
   *     to match, OR a staff/admin/agent actor with cart:read.
   *   - Anonymous + customer cart, OR no secret + guest cart: forbidden.
   */
  private async assertCartReadAccess(
    actor: Actor | null,
    cart: Cart,
    presentedSecret: string | undefined,
    ctx: TxContext | undefined,
  ): Promise<void> {
    if (actor && actor.permissions.includes("*:*")) return;

    if (cart.customerId != null) {
      if (!actor) {
        throw new CommerceForbiddenError(
          "Authentication required to read customer cart.",
        );
      }
      const profileId = await this.resolveActorCustomerId(actor, ctx);
      if (profileId !== cart.customerId) {
        throw new CommerceForbiddenError(
          "You do not have access to this resource.",
        );
      }
      return;
    }

    // Guest cart — secret-gated.
    if (presentedSecret && cart.secret && presentedSecret === cart.secret) {
      return;
    }

    // Staff / admin / ai_agent / service may inspect any guest cart with cart:read.
    if (actor) {
      try {
        assertPermission(actor, "cart:read");
        const role = (actor as { role?: string }).role;
        const STAFF = new Set(["staff", "admin", "owner", "ai_agent", "service"]);
        if (role && STAFF.has(role)) return;
      } catch {
        // fall through to forbidden
      }
    }

    throw new CommerceForbiddenError(
      "Cart secret required to access guest cart.",
    );
  }
}
