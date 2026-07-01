import type { CommerceConfig } from "../../config/types.js";
import { resolveOrgId } from "../../auth/org.js";
import type { Actor } from "../../auth/types.js";
import { CommerceNotFoundError, CommerceValidationError } from "../../kernel/errors.js";
import { Err, Ok, type Result } from "../../kernel/result.js";
import type { TxContext } from "../../kernel/database/tx-context.js";
import type { CatalogRepository } from "../catalog/repository/index.js";
import {
  calculateShippingCost,
  computeShippableWeightGrams,
  type ShippingAddress,
  type ShippingLineItem,
} from "./calculator.js";
import type {
  ShippingConfigRepository,
  ShippingZone,
  ShippingRate,
} from "./repository/index.js";

interface ShippingServiceDeps {
  config: CommerceConfig;
  catalogRepository: CatalogRepository;
  repository: ShippingConfigRepository;
}

export interface CalculateShippingInput {
  lineItems: ShippingLineItem[];
  subtotalAfterDiscount: number;
  currency: string;
  address?: ShippingAddress;
  isFreeShipping?: boolean;
  /** When set, runtime shipping zones for this org take precedence over code config. */
  orgId?: string;
}

export class ShippingService {
  private readonly catalogRepo: CatalogRepository;

  constructor(private deps: ShippingServiceDeps) {
    this.catalogRepo = deps.catalogRepository;
  }

  async calculate(
    input: CalculateShippingInput,
    ctx?: TxContext,
  ): Promise<
    Result<{ amount: number; strategy: string; weightGrams: number }>
  > {
    // Runtime zones (issue #45) take precedence when they exist and the
    // destination is known; the code-config strategy remains the fallback.
    if (!input.isFreeShipping && input.orgId && input.address) {
      const zoneResult = await this.calculateFromZones(
        input as CalculateShippingInput & { orgId: string; address: ShippingAddress },
        ctx,
      );
      if (zoneResult) return Ok(zoneResult);
    }

    const result = await calculateShippingCost(
      this.deps.config,
      this.catalogRepo,
      {
        lineItems: input.lineItems,
        subtotalAfterDiscount: input.subtotalAfterDiscount,
        currency: input.currency,
        isFreeShipping: input.isFreeShipping ?? false,
        ...(input.address !== undefined ? { address: input.address } : {}),
      },
      ctx,
    );
    return Ok(result);
  }

  private zoneMatches(zone: ShippingZone, address: ShippingAddress): boolean {
    const country = address.country?.toUpperCase();
    const countries = zone.countries.map((c) => c.toUpperCase());
    if (!countries.includes("*") && (!country || !countries.includes(country))) {
      return false;
    }
    if (zone.states.length > 0) {
      const state = address.state?.toUpperCase();
      if (!state || !zone.states.map((s) => s.toUpperCase()).includes(state)) {
        return false;
      }
    }
    return true;
  }

  private async calculateFromZones(
    input: CalculateShippingInput & { orgId: string; address: ShippingAddress },
    ctx?: TxContext,
  ): Promise<{ amount: number; strategy: string; weightGrams: number } | null> {
    const zones = await this.deps.repository.findActiveZones(input.orgId, ctx);
    if (zones.length === 0) return null;

    let weightGrams: number | null = null;
    for (const zone of zones) {
      if (!this.zoneMatches(zone, input.address)) continue;
      const rates = (
        await this.deps.repository.findActiveRatesByZoneId(zone.id, ctx)
      ).filter((rate) => rate.currency === input.currency);

      for (const rate of rates) {
        const sub = input.subtotalAfterDiscount;
        if (rate.minSubtotal != null && sub < rate.minSubtotal) continue;
        if (rate.maxSubtotal != null && sub > rate.maxSubtotal) continue;
        if (rate.minWeightGrams != null || rate.maxWeightGrams != null) {
          weightGrams ??= await computeShippableWeightGrams(
            this.deps.config,
            this.catalogRepo,
            input.lineItems,
            ctx,
          );
          if (rate.minWeightGrams != null && weightGrams < rate.minWeightGrams) continue;
          if (rate.maxWeightGrams != null && weightGrams > rate.maxWeightGrams) continue;
        }
        if (rate.freeShippingThreshold != null && sub >= rate.freeShippingThreshold) {
          return {
            amount: 0,
            strategy: `zone:${zone.name}:free_shipping`,
            weightGrams: weightGrams ?? 0,
          };
        }
        return {
          amount: Math.max(0, Math.round(rate.amount)),
          strategy: `zone:${zone.name}:${rate.name}`,
          weightGrams: weightGrams ?? 0,
        };
      }
    }
    return null;
  }

  // ── Runtime zone & rate management (issue #45) ─────────────────────────

  async createZone(
    input: {
      name: string;
      countries: string[];
      states?: string[] | undefined;
      priority?: number | undefined;
      isActive?: boolean | undefined;
    },
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<ShippingZone>> {
    if (input.countries.length === 0) {
      return Err(new CommerceValidationError("A shipping zone requires at least one country (\"*\" matches any)."));
    }
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const zone = await this.deps.repository.createZone(
      {
        organizationId: orgId,
        name: input.name,
        countries: input.countries.map((c) => c.toUpperCase()),
        states: (input.states ?? []).map((s) => s.toUpperCase()),
        priority: input.priority ?? 100,
        isActive: input.isActive ?? true,
      },
      ctx,
    );
    return Ok(zone);
  }

  async listZones(actor?: Actor | null, ctx?: TxContext): Promise<Result<ShippingZone[]>> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    return Ok(await this.deps.repository.findZones(orgId, ctx));
  }

  async updateZone(
    id: string,
    patch: {
      name?: string | undefined;
      countries?: string[] | undefined;
      states?: string[] | undefined;
      priority?: number | undefined;
      isActive?: boolean | undefined;
    },
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<ShippingZone>> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const existing = await this.deps.repository.findZoneById(orgId, id, ctx);
    if (!existing) return Err(new CommerceNotFoundError("Shipping zone not found."));
    const updated = await this.deps.repository.updateZone(
      id,
      {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.countries !== undefined
          ? { countries: patch.countries.map((c) => c.toUpperCase()) }
          : {}),
        ...(patch.states !== undefined
          ? { states: patch.states.map((s) => s.toUpperCase()) }
          : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
      },
      ctx,
    );
    return Ok(updated!);
  }

  async deleteZone(id: string, actor?: Actor | null, ctx?: TxContext): Promise<Result<{ deleted: true }>> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const existing = await this.deps.repository.findZoneById(orgId, id, ctx);
    if (!existing) return Err(new CommerceNotFoundError("Shipping zone not found."));
    await this.deps.repository.deleteZone(id, ctx);
    return Ok({ deleted: true });
  }

  async createRate(
    input: {
      zoneId: string;
      name: string;
      amount: number;
      currency?: string | undefined;
      minSubtotal?: number | undefined;
      maxSubtotal?: number | undefined;
      minWeightGrams?: number | undefined;
      maxWeightGrams?: number | undefined;
      freeShippingThreshold?: number | undefined;
      isActive?: boolean | undefined;
    },
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<ShippingRate>> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const zone = await this.deps.repository.findZoneById(orgId, input.zoneId, ctx);
    if (!zone) return Err(new CommerceNotFoundError("Shipping zone not found."));
    const rate = await this.deps.repository.createRate(
      {
        organizationId: orgId,
        zoneId: input.zoneId,
        name: input.name,
        amount: input.amount,
        currency: input.currency ?? "USD",
        minSubtotal: input.minSubtotal ?? null,
        maxSubtotal: input.maxSubtotal ?? null,
        minWeightGrams: input.minWeightGrams ?? null,
        maxWeightGrams: input.maxWeightGrams ?? null,
        freeShippingThreshold: input.freeShippingThreshold ?? null,
        isActive: input.isActive ?? true,
      },
      ctx,
    );
    return Ok(rate);
  }

  async listRates(
    filter?: { zoneId?: string },
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<ShippingRate[]>> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    return Ok(
      await this.deps.repository.findRates(
        orgId,
        filter?.zoneId !== undefined ? { zoneId: filter.zoneId } : undefined,
        ctx,
      ),
    );
  }

  async updateRate(
    id: string,
    patch: {
      name?: string | undefined;
      amount?: number | undefined;
      currency?: string | undefined;
      minSubtotal?: number | null | undefined;
      maxSubtotal?: number | null | undefined;
      minWeightGrams?: number | null | undefined;
      maxWeightGrams?: number | null | undefined;
      freeShippingThreshold?: number | null | undefined;
      isActive?: boolean | undefined;
    },
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<ShippingRate>> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const existing = await this.deps.repository.findRateById(orgId, id, ctx);
    if (!existing) return Err(new CommerceNotFoundError("Shipping rate not found."));
    const updated = await this.deps.repository.updateRate(
      id,
      {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.amount !== undefined ? { amount: patch.amount } : {}),
        ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
        ...(patch.minSubtotal !== undefined ? { minSubtotal: patch.minSubtotal } : {}),
        ...(patch.maxSubtotal !== undefined ? { maxSubtotal: patch.maxSubtotal } : {}),
        ...(patch.minWeightGrams !== undefined ? { minWeightGrams: patch.minWeightGrams } : {}),
        ...(patch.maxWeightGrams !== undefined ? { maxWeightGrams: patch.maxWeightGrams } : {}),
        ...(patch.freeShippingThreshold !== undefined
          ? { freeShippingThreshold: patch.freeShippingThreshold }
          : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
      },
      ctx,
    );
    return Ok(updated!);
  }

  async deleteRate(id: string, actor?: Actor | null, ctx?: TxContext): Promise<Result<{ deleted: true }>> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const existing = await this.deps.repository.findRateById(orgId, id, ctx);
    if (!existing) return Err(new CommerceNotFoundError("Shipping rate not found."));
    await this.deps.repository.deleteRate(id, ctx);
    return Ok({ deleted: true });
  }
}
