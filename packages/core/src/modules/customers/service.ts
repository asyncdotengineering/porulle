import { resolveOrgId } from "../../auth/org.js";
import { assertPermission } from "../../auth/permissions.js";
import type { Actor } from "../../auth/types.js";
import { CommerceNotFoundError, toCommerceError } from "../../kernel/errors.js";
import { runAfterHooks } from "../../kernel/hooks/executor.js";
import { createHookContext } from "../../kernel/hooks/create-context.js";
import type { HookRegistry } from "../../kernel/hooks/registry.js";
import type { AfterHook, HookContext } from "../../kernel/hooks/types.js";
import { Err, Ok, type Result } from "../../kernel/result.js";
import type { DatabaseAdapter } from "../../kernel/database/adapter.js";
import type { PluginDb } from "../../kernel/database/plugin-types.js";
import type { TxContext } from "../../kernel/database/tx-context.js";
import { createLogger } from "../../utils/logger.js";
import type {
  CustomersRepository,
  Customer,
  CustomerAddress,
  CustomerAddressInsert,
  CustomerInteraction,
} from "./repository/index.js";

interface CustomerServiceDeps {
  repository: CustomersRepository;
  hooks: HookRegistry;
  services: Record<string, unknown>;
  database: DatabaseAdapter;
}

function hookContext(
  actor: Actor | null,
  services: Record<string, unknown>,
  database: DatabaseAdapter,
  tx: unknown,
): HookContext {
  return createHookContext({
    actor,
    tx,
    logger: createLogger("customers"),
    services,
    context: { moduleName: "customers" },
    database: { db: database.db as PluginDb },
  });
}

export class CustomerService {
  private readonly repo: CustomersRepository;

  constructor(private deps: CustomerServiceDeps) {
    this.repo = deps.repository;
  }

  /**
   * Create a customer. `userId` is optional: for walk-in / point-of-sale
   * customers who never log in, omit it and a synthetic `anonymous_<uuid>` id
   * is generated and the customer is flagged `metadata.walkIn = true`. This
   * keeps non-account contacts out of the auth users table.
   */
  async createWalkIn(
    input: {
      userId?: string | undefined;
      firstName?: string | undefined;
      lastName?: string | undefined;
      phone?: string | undefined;
      email?: string | undefined;
      metadata?: Record<string, unknown> | undefined;
    },
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<Customer>> {
    try {
      assertPermission(actor ?? null, "customers:create");
    } catch (error) {
      return Err(toCommerceError(error));
    }

    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const isWalkIn = input.userId === undefined;
    const userId = input.userId ?? `anonymous_${crypto.randomUUID()}`;
    const metadata = {
      ...(input.metadata ?? {}),
      ...(isWalkIn ? { walkIn: true } : {}),
    };

    const customer = await this.repo.create(
      {
        organizationId: orgId,
        userId,
        metadata,
        ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
        ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
      },
      ctx,
    );

    const afterHooks = this.deps.hooks.resolve(
      "customers.afterCreate",
    ) as AfterHook<Customer>[];
    const hctx = hookContext(actor ?? null, this.deps.services, this.deps.database, ctx?.tx ?? null);
    await runAfterHooks(afterHooks, null, customer, "create", hctx);

    return Ok(customer);
  }

  // ─── Customer interactions (clienteling notes / visits / calls) ──────────

  async listInteractions(customerId: string, actor?: Actor | null, ctx?: TxContext): Promise<Result<CustomerInteraction[]>> {
    try { assertPermission(actor ?? null, "customers:read"); } catch (error) { return Err(toCommerceError(error)); }
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    return Ok(await this.repo.listInteractions(orgId, customerId, ctx));
  }

  async createInteraction(
    customerId: string,
    input: { kind: string; notes: string; relatedEntityId?: string | null | undefined; metadata?: Record<string, unknown> | undefined },
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<CustomerInteraction>> {
    try { assertPermission(actor ?? null, "customers:update"); } catch (error) { return Err(toCommerceError(error)); }
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const customer = await this.repo.findById(orgId, customerId, ctx);
    if (!customer) return Err(new CommerceNotFoundError("Customer not found."));
    const interaction = await this.repo.createInteraction(
      {
        organizationId: orgId,
        customerId,
        kind: input.kind,
        notes: input.notes,
        actorUserId: actor?.userId ?? null,
        relatedEntityId: input.relatedEntityId ?? null,
        metadata: input.metadata ?? {},
      },
      ctx,
    );
    return Ok(interaction);
  }

  async updateInteraction(
    customerId: string,
    interactionId: string,
    input: { kind?: string | undefined; notes?: string | undefined; relatedEntityId?: string | null | undefined; metadata?: Record<string, unknown> | undefined },
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<CustomerInteraction>> {
    try { assertPermission(actor ?? null, "customers:update"); } catch (error) { return Err(toCommerceError(error)); }
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const existing = await this.repo.findInteractionById(orgId, interactionId, ctx);
    if (!existing || existing.customerId !== customerId) return Err(new CommerceNotFoundError("Interaction not found."));
    const patch = {
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.relatedEntityId !== undefined ? { relatedEntityId: input.relatedEntityId } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };
    const updated = await this.repo.updateInteraction(orgId, interactionId, patch, ctx);
    if (!updated) return Err(new CommerceNotFoundError("Interaction not found."));
    return Ok(updated);
  }

  async deleteInteraction(customerId: string, interactionId: string, actor?: Actor | null, ctx?: TxContext): Promise<Result<void>> {
    try { assertPermission(actor ?? null, "customers:update"); } catch (error) { return Err(toCommerceError(error)); }
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const existing = await this.repo.findInteractionById(orgId, interactionId, ctx);
    if (!existing || existing.customerId !== customerId) return Err(new CommerceNotFoundError("Interaction not found."));
    await this.repo.deleteInteraction(orgId, interactionId, ctx);
    return Ok(undefined);
  }

  private async getOrCreateByUserId(
    orgId: string,
    userId: string,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Customer> {
    const existing = await this.repo.findByUserId(orgId, userId, ctx);
    if (existing) {
      return existing;
    }

    const customer = await this.repo.create(
      {
        organizationId: orgId,
        userId,
        metadata: {},
      },
      ctx,
    );

    const afterHooks = this.deps.hooks.resolve(
      "customers.afterCreate",
    ) as AfterHook<Customer>[];
    const hctx = hookContext(actor, this.deps.services, this.deps.database, ctx?.tx ?? null);
    await runAfterHooks(afterHooks, null, customer, "create", hctx);

    return customer;
  }

  async list(
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<Customer[]>> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const customers = await this.repo.findAll(orgId, ctx);
    return Ok(customers);
  }

  async getById(
    id: string,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<Customer>> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const customer = await this.repo.findById(orgId, id, ctx);
    if (!customer) return Err(new CommerceNotFoundError("Customer not found."));
    return Ok(customer);
  }

  async getByUserId(
    userId: string,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<Customer>> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const resolvedActor = actor ?? ctx?.actor ?? null;
    const customer = await this.getOrCreateByUserId(
      orgId,
      userId,
      resolvedActor,
      ctx,
    );
    return Ok(customer);
  }

  async update(
    id: string,
    updates: Partial<
      Omit<Customer, "id" | "userId" | "createdAt" | "updatedAt">
    >,
    actor?: Actor | null,
    ctx?: TxContext,
    options?: { replaceMetadata?: boolean },
  ): Promise<Result<Customer>> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const existing = await this.repo.findById(orgId, id, ctx);
    if (!existing) return Err(new CommerceNotFoundError("Customer not found."));

    // Shallow-merge metadata by default (top-level keys) so a single-key edit
    // doesn't clobber the rest of the blob. Pass replaceMetadata to overwrite.
    let finalUpdates = updates;
    if (updates.metadata !== undefined && !options?.replaceMetadata) {
      finalUpdates = {
        ...updates,
        metadata: {
          ...((existing.metadata as Record<string, unknown> | null) ?? {}),
          ...(updates.metadata as Record<string, unknown>),
        },
      };
    }

    const updated = await this.repo.update(id, finalUpdates, ctx);
    if (!updated) return Err(new CommerceNotFoundError("Customer not found."));

    const afterHooks = this.deps.hooks.resolve(
      "customers.afterUpdate",
    ) as AfterHook<Customer>[];
    const hctx = hookContext(
      actor ?? ctx?.actor ?? null,
      this.deps.services,
      this.deps.database,
      ctx?.tx ?? null,
    );
    await runAfterHooks(afterHooks, existing, updated, "update", hctx);

    return Ok(updated);
  }

  async updateByUserId(
    userId: string,
    updates: Partial<
      Omit<Customer, "id" | "userId" | "createdAt" | "updatedAt">
    >,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<Customer>> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const resolvedActor = actor ?? ctx?.actor ?? null;
    const customer = await this.getOrCreateByUserId(
      orgId,
      userId,
      resolvedActor,
      ctx,
    );

    const updated = await this.repo.update(customer.id, updates, ctx);
    if (!updated) {
      return Err(new CommerceNotFoundError("Customer not found."));
    }

    const afterHooks = this.deps.hooks.resolve(
      "customers.afterUpdate",
    ) as AfterHook<Customer>[];
    const hctx = hookContext(resolvedActor, this.deps.services, this.deps.database, ctx?.tx ?? null);
    await runAfterHooks(afterHooks, customer, updated, "update", hctx);

    return Ok(updated);
  }

  async getAddresses(
    userId: string,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<CustomerAddress[]>> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const resolvedActor = actor ?? ctx?.actor ?? null;
    const customer = await this.getOrCreateByUserId(
      orgId,
      userId,
      resolvedActor,
      ctx,
    );
    const addresses = await this.repo.findAddressesByCustomerId(
      customer.id,
      ctx,
    );
    return Ok(addresses);
  }

  async addAddress(
    userId: string,
    input: Omit<CustomerAddressInsert, "id" | "customerId">,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<CustomerAddress>> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const resolvedActor = actor ?? ctx?.actor ?? null;
    const customer = await this.getOrCreateByUserId(
      orgId,
      userId,
      resolvedActor,
      ctx,
    );

    if (input.isDefault) {
      const addresses = await this.repo.findAddressesByCustomerId(
        customer.id,
        ctx,
      );
      for (const addr of addresses) {
        if (addr.type === input.type && addr.isDefault) {
          await this.repo.updateAddress(addr.id, { isDefault: false }, ctx);
        }
      }
    }

    const address = await this.repo.createAddress(
      {
        ...input,
        customerId: customer.id,
      },
      ctx,
    );

    return Ok(address);
  }

  async deleteAddress(
    userId: string,
    addressId: string,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<void>> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const resolvedActor = actor ?? ctx?.actor ?? null;
    const customer = await this.getOrCreateByUserId(
      orgId,
      userId,
      resolvedActor,
      ctx,
    );
    const addresses = await this.repo.findAddressesByCustomerId(
      customer.id,
      ctx,
    );

    const addressExists = addresses.some((addr) => addr.id === addressId);
    if (!addressExists) {
      return Err(new CommerceNotFoundError("Address not found."));
    }

    await this.repo.deleteAddress(addressId, ctx);
    return Ok(undefined);
  }

  async findPOSOperatorByPin(
    hashedPin: string,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<{ id: string; name: string } | null> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const user = await this.repo.findByPosPin(orgId, hashedPin, ctx);
    if (!user) return null;
    return {
      id: user.userId,
      name:
        [user.firstName, user.lastName].filter(Boolean).join(" ") ||
        user.email ||
        "POS Operator",
    };
  }
}
