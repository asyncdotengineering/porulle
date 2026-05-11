import { eq, and } from "drizzle-orm";
import type { TxContext } from "../../../kernel/database/tx-context.js";
import type {
  DrizzleDatabase,
  DbOrTx,
} from "../../../kernel/database/drizzle-db.js";
import {
  customers,
  customerAddresses,
  customerGroups,
  customerGroupMembers,
} from "../schema.js";

// Infer types from Drizzle schema
export type Customer = typeof customers.$inferSelect;
export type CustomerInsert = typeof customers.$inferInsert;
export type CustomerAddress = typeof customerAddresses.$inferSelect;
export type CustomerAddressInsert = typeof customerAddresses.$inferInsert;
export type CustomerGroup = typeof customerGroups.$inferSelect;
export type CustomerGroupInsert = typeof customerGroups.$inferInsert;
export type CustomerGroupMember = typeof customerGroupMembers.$inferSelect;
export type CustomerGroupMemberInsert =
  typeof customerGroupMembers.$inferInsert;

/**
 * CustomersRepository provides type-safe database operations for customers.
 *
 * This repository manages customers, addresses, groups, and group memberships.
 * All methods support an optional TxContext parameter for transaction participation.
 */
export class CustomersRepository {
  constructor(private readonly db: DrizzleDatabase) {}

  private getDb(ctx?: TxContext): DbOrTx {
    return (ctx?.tx as DbOrTx | undefined) ?? this.db;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Customers
  // ─────────────────────────────────────────────────────────────────────────────

  async findById(orgId: string, id: string, ctx?: TxContext): Promise<Customer | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(customers)
      .where(and(eq(customers.organizationId, orgId), eq(customers.id, id)));
    return rows[0];
  }

  async findByUserId(
    orgId: string,
    userId: string,
    ctx?: TxContext,
  ): Promise<Customer | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(customers)
      .where(and(eq(customers.organizationId, orgId), eq(customers.userId, userId)));
    return rows[0];
  }

  async findByEmail(
    orgId: string,
    email: string,
    ctx?: TxContext,
  ): Promise<Customer | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(customers)
      .where(and(eq(customers.organizationId, orgId), eq(customers.email, email)));
    return rows[0];
  }

  async findByPosPin(
    orgId: string,
    hashedPin: string,
    ctx?: TxContext,
  ): Promise<Customer | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(customers)
      .where(and(eq(customers.organizationId, orgId), eq(customers.posOperatorPin, hashedPin)));
    return rows[0];
  }

  async findAll(orgId: string, ctx?: TxContext): Promise<Customer[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(customers)
      .where(eq(customers.organizationId, orgId));
  }

  async create(data: CustomerInsert, ctx?: TxContext): Promise<Customer> {
    const db = this.getDb(ctx);
    const rows = await db.insert(customers).values(data).returning();
    return rows[0]!;
  }

  async update(
    id: string,
    data: Partial<Omit<CustomerInsert, "id">>,
    ctx?: TxContext,
  ): Promise<Customer | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .update(customers)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(customers.id, id))
      .returning();
    return rows[0];
  }

  async delete(id: string, ctx?: TxContext): Promise<boolean> {
    const db = this.getDb(ctx);
    const result = await db
      .delete(customers)
      .where(eq(customers.id, id))
      .returning();
    return result.length > 0;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Customer Addresses
  // ─────────────────────────────────────────────────────────────────────────────

  async findAddressById(
    id: string,
    ctx?: TxContext,
  ): Promise<CustomerAddress | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(customerAddresses)
      .where(eq(customerAddresses.id, id));
    return rows[0];
  }

  async findAddressesByCustomerId(
    customerId: string,
    ctx?: TxContext,
  ): Promise<CustomerAddress[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(customerAddresses)
      .where(eq(customerAddresses.customerId, customerId));
  }

  async findDefaultAddress(
    customerId: string,
    type: "shipping" | "billing",
    ctx?: TxContext,
  ): Promise<CustomerAddress | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(customerAddresses)
      .where(
        and(
          eq(customerAddresses.customerId, customerId),
          eq(customerAddresses.type, type),
          eq(customerAddresses.isDefault, true),
        ),
      );
    return rows[0];
  }

  async createAddress(
    data: CustomerAddressInsert,
    ctx?: TxContext,
  ): Promise<CustomerAddress> {
    const db = this.getDb(ctx);
    const rows = await db.insert(customerAddresses).values(data).returning();
    return rows[0]!;
  }

  async updateAddress(
    id: string,
    data: Partial<Omit<CustomerAddressInsert, "id">>,
    ctx?: TxContext,
  ): Promise<CustomerAddress | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .update(customerAddresses)
      .set(data)
      .where(eq(customerAddresses.id, id))
      .returning();
    return rows[0];
  }

  async deleteAddress(id: string, ctx?: TxContext): Promise<boolean> {
    const db = this.getDb(ctx);
    const result = await db
      .delete(customerAddresses)
      .where(eq(customerAddresses.id, id))
      .returning();
    return result.length > 0;
  }

  async deleteAddressesByCustomerId(
    customerId: string,
    ctx?: TxContext,
  ): Promise<void> {
    const db = this.getDb(ctx);
    await db
      .delete(customerAddresses)
      .where(eq(customerAddresses.customerId, customerId));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Customer Groups
  // ─────────────────────────────────────────────────────────────────────────────

  async findGroupById(
    orgId: string,
    id: string,
    ctx?: TxContext,
  ): Promise<CustomerGroup | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(customerGroups)
      .where(and(eq(customerGroups.organizationId, orgId), eq(customerGroups.id, id)));
    return rows[0];
  }

  async findGroupByName(
    orgId: string,
    name: string,
    ctx?: TxContext,
  ): Promise<CustomerGroup | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(customerGroups)
      .where(and(eq(customerGroups.organizationId, orgId), eq(customerGroups.name, name)));
    return rows[0];
  }

  async findAllGroups(orgId: string, ctx?: TxContext): Promise<CustomerGroup[]> {
    const db = this.getDb(ctx);
    return db.select().from(customerGroups).where(eq(customerGroups.organizationId, orgId));
  }

  async createGroup(
    data: CustomerGroupInsert,
    ctx?: TxContext,
  ): Promise<CustomerGroup> {
    const db = this.getDb(ctx);
    const rows = await db.insert(customerGroups).values(data).returning();
    return rows[0]!;
  }

  async updateGroup(
    id: string,
    data: Partial<Omit<CustomerGroupInsert, "id">>,
    ctx?: TxContext,
  ): Promise<CustomerGroup | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .update(customerGroups)
      .set(data)
      .where(eq(customerGroups.id, id))
      .returning();
    return rows[0];
  }

  async deleteGroup(id: string, ctx?: TxContext): Promise<boolean> {
    const db = this.getDb(ctx);
    const result = await db
      .delete(customerGroups)
      .where(eq(customerGroups.id, id))
      .returning();
    return result.length > 0;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Customer Group Members
  // ─────────────────────────────────────────────────────────────────────────────

  async findGroupsByCustomerId(
    customerId: string,
    ctx?: TxContext,
  ): Promise<string[]> {
    const db = this.getDb(ctx);
    const rows = await db
      .select({ groupId: customerGroupMembers.groupId })
      .from(customerGroupMembers)
      .where(eq(customerGroupMembers.customerId, customerId));
    return rows.map((r) => r.groupId);
  }

  async addToGroup(
    customerId: string,
    groupId: string,
    ctx?: TxContext,
  ): Promise<void> {
    const db = this.getDb(ctx);
    await db
      .insert(customerGroupMembers)
      .values({ customerId, groupId })
      .onConflictDoNothing();
  }

  async removeFromGroup(
    customerId: string,
    groupId: string,
    ctx?: TxContext,
  ): Promise<boolean> {
    const db = this.getDb(ctx);
    const result = await db
      .delete(customerGroupMembers)
      .where(
        and(
          eq(customerGroupMembers.customerId, customerId),
          eq(customerGroupMembers.groupId, groupId),
        ),
      )
      .returning();
    return result.length > 0;
  }
}
