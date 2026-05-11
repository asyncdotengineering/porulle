import { resolveOrgId } from "../../auth/org.js";
import type { Actor } from "../../auth/types.js";
import { CommerceNotFoundError } from "../../kernel/errors.js";
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
  ): Promise<Result<Customer>> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const existing = await this.repo.findById(orgId, id, ctx);
    if (!existing) return Err(new CommerceNotFoundError("Customer not found."));
    const updated = await this.repo.update(id, updates, ctx);
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
