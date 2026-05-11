import { eq, and, desc } from "@porulle/core/drizzle";
import {
  serviceTypes, providers, providerServices,
  weeklyAvailability, availabilityOverrides, breaks,
} from "../schema.js";
import type { Db } from "../types.js";

export class ProviderService {
  constructor(private db: Db) {}

  // ─── Service Types ──────────────────────────────────────────────────────────

  async createServiceType(orgId: string, data: {
    name: string;
    slug: string;
    description?: string;
    durationMinutes?: number;
    priceCents?: number;
    currency?: string;
    bufferBeforeMinutes?: number;
    bufferAfterMinutes?: number;
  }) {
    const [row] = await this.db.insert(serviceTypes).values({
      organizationId: orgId,
      name: data.name,
      slug: data.slug,
      description: data.description,
      durationMinutes: data.durationMinutes ?? 30,
      priceCents: data.priceCents ?? 0,
      currency: data.currency ?? "USD",
      bufferBeforeMinutes: data.bufferBeforeMinutes ?? 0,
      bufferAfterMinutes: data.bufferAfterMinutes ?? 0,
    }).returning();
    return row;
  }

  async getServiceType(id: string) {
    const [row] = await this.db.select().from(serviceTypes).where(eq(serviceTypes.id, id));
    return row ?? null;
  }

  async getServiceTypeBySlug(slug: string) {
    const [row] = await this.db.select().from(serviceTypes).where(eq(serviceTypes.slug, slug));
    return row ?? null;
  }

  async listServiceTypes() {
    return this.db.select().from(serviceTypes).where(eq(serviceTypes.isActive, true)).orderBy(desc(serviceTypes.createdAt));
  }

  async updateServiceType(id: string, data: Partial<{
    name: string; description: string; durationMinutes: number;
    priceCents: number; currency: string;
    bufferBeforeMinutes: number; bufferAfterMinutes: number; isActive: boolean;
  }>) {
    const [updated] = await this.db.update(serviceTypes)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(serviceTypes.id, id))
      .returning();
    return updated ?? null;
  }

  async deleteServiceType(id: string) {
    const [deleted] = await this.db.delete(serviceTypes).where(eq(serviceTypes.id, id)).returning();
    return deleted ?? null;
  }

  // ─── Providers ──────────────────────────────────────────────────────────────

  async createProvider(orgId: string, data: {
    name: string;
    email?: string;
    phone?: string;
    timezone?: string;
    metadata?: Record<string, unknown>;
  }) {
    const [row] = await this.db.insert(providers).values({
      organizationId: orgId,
      name: data.name,
      email: data.email,
      phone: data.phone,
      timezone: data.timezone ?? "UTC",
      metadata: data.metadata ?? {},
    }).returning();
    return row;
  }

  async getProvider(id: string) {
    const [row] = await this.db.select().from(providers).where(eq(providers.id, id));
    return row ?? null;
  }

  async listProviders() {
    return this.db.select().from(providers).where(eq(providers.isActive, true)).orderBy(desc(providers.createdAt));
  }

  async updateProvider(id: string, data: Partial<{
    name: string; email: string; phone: string; timezone: string; isActive: boolean;
    metadata: Record<string, unknown>;
  }>) {
    const [updated] = await this.db.update(providers)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(providers.id, id))
      .returning();
    return updated ?? null;
  }

  async deleteProvider(id: string) {
    const [deleted] = await this.db.delete(providers).where(eq(providers.id, id)).returning();
    return deleted ?? null;
  }

  // ─── Provider–ServiceType Links ─────────────────────────────────────────────

  async linkServiceType(providerId: string, serviceTypeId: string, overrides?: {
    customDurationMinutes?: number;
    customPriceCents?: number;
  }) {
    const [row] = await this.db.insert(providerServices).values({
      providerId,
      serviceTypeId,
      customDurationMinutes: overrides?.customDurationMinutes,
      customPriceCents: overrides?.customPriceCents,
    }).returning();
    return row;
  }

  async getProviderServices(providerId: string) {
    return this.db.select().from(providerServices)
      .where(eq(providerServices.providerId, providerId));
  }

  // ─── Weekly Availability ────────────────────────────────────────────────────

  async setWeeklyAvailability(providerId: string, schedules: Array<{
    dayOfWeek: number;
    startTime: string;
    endTime: string;
  }>) {
    // Delete existing weekly availability for this provider
    await this.db.delete(weeklyAvailability)
      .where(eq(weeklyAvailability.providerId, providerId));

    if (schedules.length === 0) return [];

    const rows = await this.db.insert(weeklyAvailability)
      .values(schedules.map((s) => ({
        providerId,
        dayOfWeek: s.dayOfWeek,
        startTime: s.startTime,
        endTime: s.endTime,
      })))
      .returning();

    return rows;
  }

  async getWeeklyAvailability(providerId: string) {
    return this.db.select().from(weeklyAvailability)
      .where(eq(weeklyAvailability.providerId, providerId))
      .orderBy(weeklyAvailability.dayOfWeek);
  }

  // ─── Breaks ─────────────────────────────────────────────────────────────────

  async addBreak(providerId: string, data: {
    dayOfWeek?: number | undefined;
    startTime: string;
    endTime: string;
    label?: string | undefined;
  }) {
    const [row] = await this.db.insert(breaks).values({
      providerId,
      dayOfWeek: data.dayOfWeek,
      startTime: data.startTime,
      endTime: data.endTime,
      label: data.label,
    }).returning();
    return row;
  }

  async getBreaks(providerId: string) {
    return this.db.select().from(breaks)
      .where(eq(breaks.providerId, providerId));
  }

  async deleteBreak(id: string) {
    const [deleted] = await this.db.delete(breaks).where(eq(breaks.id, id)).returning();
    return deleted ?? null;
  }

  // ─── Availability Overrides ─────────────────────────────────────────────────

  async addOverride(providerId: string, data: {
    date: string;
    isAvailable: boolean;
    startTime?: string | undefined;
    endTime?: string | undefined;
    reason?: string | undefined;
  }) {
    const [row] = await this.db.insert(availabilityOverrides).values({
      providerId,
      date: data.date,
      isAvailable: data.isAvailable,
      startTime: data.startTime,
      endTime: data.endTime,
      reason: data.reason,
    }).returning();
    return row;
  }

  async getOverrides(providerId: string) {
    return this.db.select().from(availabilityOverrides)
      .where(eq(availabilityOverrides.providerId, providerId))
      .orderBy(availabilityOverrides.date);
  }

  async deleteOverride(id: string) {
    const [deleted] = await this.db.delete(availabilityOverrides)
      .where(eq(availabilityOverrides.id, id)).returning();
    return deleted ?? null;
  }
}
