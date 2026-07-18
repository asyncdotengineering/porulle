import { resolveOrgId } from "../../auth/org.js";
import type { Actor } from "../../auth/types.js";
import type { TxContext } from "../../kernel/database/tx-context.js";
import { CommerceNotFoundError, CommerceValidationError } from "../../kernel/errors.js";
import { Err, Ok, type Result } from "../../kernel/result.js";
import type {
  TaxAdapter,
  TaxCalculationParams,
  TaxCalculationResult,
  TaxReportParams,
  TaxVoidParams,
} from "./adapter.js";
import type { TaxClass, TaxRate, TaxRatesRepository } from "./repository/index.js";

interface TaxServiceDeps {
  adapter: TaxAdapter | undefined;
  repository?: TaxRatesRepository;
}

export class TaxService {
  private adapter: TaxAdapter | undefined;
  private repository: TaxRatesRepository | undefined;

  constructor(deps: TaxServiceDeps) {
    this.adapter = deps.adapter;
    this.repository = deps.repository;
  }

  /**
   * Calculates tax. Resolution order:
   * 1. Product tax classes (issue #57) — when the org defines active classes,
   *    each line taxes by its class (variant taxClass beats entity taxClass;
   *    unclassed lines use the default class or 0), with `orderDiscount`
   *    pro-rated across lines first. Returns per-line results in `lines`.
   * 2. Runtime tax rates for the org matching `toAddress` (issue #45) —
   *    state-specific matches beat country-level; matches at the winning
   *    specificity are summed (e.g. GST + PST).
   * 3. The configured tax adapter.
   * 4. Zero tax.
   */
  async calculate(
    params: TaxCalculationParams,
    orgId?: string,
    ctx?: TxContext,
  ): Promise<Result<TaxCalculationResult>> {
    if (this.repository && orgId && params.lineItems.length > 0) {
      const classes = await this.repository.findActiveClasses(orgId, ctx);
      if (classes.length > 0) {
        return Ok(await this.calculateByClasses(params, classes, ctx));
      }
    }

    if (this.repository && orgId && params.toAddress) {
      const matched = await this.matchRuntimeRates(orgId, params.toAddress, ctx);
      if (matched.length > 0) {
        // Subtract the order-level discount from the taxable base too (audit
        // C2a) — otherwise runtime rates tax the pre-discount subtotal and
        // over-collect on every discounted order, unlike the class-based path.
        const taxableAmount = Math.max(
          0,
          params.lineItems.reduce(
            (sum, lineItem) =>
              sum + lineItem.unitPrice * lineItem.quantity - (lineItem.discount ?? 0),
            0,
          ) - (params.orderDiscount ?? 0),
        );
        let amountToCollect = 0;
        const breakdown: Record<string, unknown> = {};
        for (const rate of matched) {
          const base =
            taxableAmount + (rate.appliesToShipping ? params.shippingAmount : 0);
          const amount = Math.max(0, Math.round((base * rate.rateBps) / 10_000));
          amountToCollect += amount;
          breakdown[rate.name] = { rateBps: rate.rateBps, amount };
        }
        const totalBps = matched.reduce((sum, r) => sum + r.rateBps, 0);
        return Ok({
          amountToCollect,
          taxableAmount,
          rate: totalBps / 10_000,
          breakdown,
        });
      }
    }

    if (!this.adapter) {
      return Ok({
        amountToCollect: 0,
        taxableAmount:
          params.lineItems.reduce(
            (sum, lineItem) => sum + lineItem.unitPrice * lineItem.quantity - (lineItem.discount ?? 0),
            0,
          ) + params.shippingAmount,
        rate: 0,
      });
    }
    return this.adapter.calculateTax(params);
  }

  /** Per-line class-based tax with cart-discount pro-ration (issue #57). */
  private async calculateByClasses(
    params: TaxCalculationParams,
    classes: TaxClass[],
    ctx?: TxContext,
  ): Promise<TaxCalculationResult> {
    const byName = new Map(classes.map((c) => [c.name, c]));
    const defaultClass = classes.find((c) => c.isDefault) ?? null;

    const { byEntity, byVariant } = await this.repository!.resolveCatalogTaxClasses(
      params.lineItems.map((li) => ({ entityId: li.entityId, variantId: li.variantId })),
      ctx,
    );

    // Pro-rate the cart-level discount across lines by value share; the last
    // line absorbs the rounding remainder so the sum stays exact.
    const lineValues = params.lineItems.map(
      (li) => Math.max(0, li.unitPrice * li.quantity - (li.discount ?? 0)),
    );
    const totalValue = lineValues.reduce((sum, v) => sum + v, 0);
    const orderDiscount = Math.min(params.orderDiscount ?? 0, totalValue);
    const prorated = lineValues.map((value) =>
      totalValue > 0 ? Math.round((orderDiscount * value) / totalValue) : 0,
    );
    if (lineValues.length > 0) {
      const drift = orderDiscount - prorated.reduce((sum, v) => sum + v, 0);
      prorated[prorated.length - 1]! += drift;
    }

    let amountToCollect = 0;
    let taxableAmount = 0;
    const breakdown: Record<string, unknown> = {};
    const lines: Array<{ id: string; taxClass: string | null; taxAmount: number }> = [];

    for (const [i, lineItem] of params.lineItems.entries()) {
      const className =
        (lineItem.variantId ? byVariant.get(lineItem.variantId) : null) ??
        byEntity.get(lineItem.entityId) ??
        defaultClass?.name ??
        null;
      const taxClass = className ? (byName.get(className) ?? defaultClass) : defaultClass;
      const base = Math.max(0, lineValues[i]! - prorated[i]!);
      const taxAmount = taxClass
        ? Math.max(0, Math.round((base * taxClass.rateBps) / 10_000))
        : 0;
      amountToCollect += taxAmount;
      taxableAmount += base;
      lines.push({ id: lineItem.id, taxClass: taxClass?.name ?? null, taxAmount });
      if (taxClass) {
        const entry = (breakdown[taxClass.name] as { rateBps: number; amount: number }) ?? {
          rateBps: taxClass.rateBps,
          amount: 0,
        };
        entry.amount += taxAmount;
        breakdown[taxClass.name] = entry;
      }
    }

    return {
      amountToCollect,
      taxableAmount,
      rate: taxableAmount > 0 ? amountToCollect / taxableAmount : 0,
      breakdown,
      lines,
    };
  }

  // ── Tax class management (issue #57) ─────────────────────────────────────

  async createTaxClass(
    input: { name: string; rateBps: number; isDefault?: boolean | undefined; isActive?: boolean | undefined },
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<TaxClass>> {
    const repo = this.requireRepository();
    if (!repo.ok) return repo;
    if (input.rateBps < 0) {
      return Err(new CommerceValidationError("rateBps must be non-negative."));
    }
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    if (input.isDefault) await repo.value.clearDefaultClass(orgId, ctx);
    const created = await repo.value.createClass(
      {
        organizationId: orgId,
        name: input.name,
        rateBps: input.rateBps,
        isDefault: input.isDefault ?? false,
        isActive: input.isActive ?? true,
      },
      ctx,
    );
    return Ok(created);
  }

  async listTaxClasses(actor?: Actor | null, ctx?: TxContext): Promise<Result<TaxClass[]>> {
    const repo = this.requireRepository();
    if (!repo.ok) return repo;
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    return Ok(await repo.value.findAllClasses(orgId, ctx));
  }

  async updateTaxClass(
    id: string,
    patch: { name?: string | undefined; rateBps?: number | undefined; isDefault?: boolean | undefined; isActive?: boolean | undefined },
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<TaxClass>> {
    const repo = this.requireRepository();
    if (!repo.ok) return repo;
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const existing = await repo.value.findClassById(orgId, id, ctx);
    if (!existing) return Err(new CommerceNotFoundError("Tax class not found."));
    if (patch.isDefault) await repo.value.clearDefaultClass(orgId, ctx);
    const updated = await repo.value.updateClass(
      id,
      {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.rateBps !== undefined ? { rateBps: patch.rateBps } : {}),
        ...(patch.isDefault !== undefined ? { isDefault: patch.isDefault } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
      },
      ctx,
    );
    return Ok(updated!);
  }

  async deleteTaxClass(id: string, actor?: Actor | null, ctx?: TxContext): Promise<Result<{ deleted: true }>> {
    const repo = this.requireRepository();
    if (!repo.ok) return repo;
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const existing = await repo.value.findClassById(orgId, id, ctx);
    if (!existing) return Err(new CommerceNotFoundError("Tax class not found."));
    await repo.value.deleteClass(id, ctx);
    return Ok({ deleted: true });
  }

  private async matchRuntimeRates(
    orgId: string,
    toAddress: { country: string; state?: string },
    ctx?: TxContext,
  ): Promise<TaxRate[]> {
    const rates = await this.repository!.findActive(orgId, ctx);
    if (rates.length === 0) return [];
    const country = toAddress.country?.toUpperCase();
    const state = toAddress.state?.toUpperCase();

    const countryMatches = rates.filter(
      (r) => r.country === "*" || r.country.toUpperCase() === country,
    );
    const stateMatches = countryMatches.filter(
      (r) => r.state != null && state != null && r.state.toUpperCase() === state,
    );
    if (stateMatches.length > 0) return stateMatches;
    return countryMatches.filter((r) => r.state == null);
  }

  async reportTransaction(params: TaxReportParams): Promise<Result<{ transactionId: string }>> {
    if (!this.adapter) return Ok({ transactionId: params.transactionId });
    return this.adapter.reportTransaction(params);
  }

  async voidTransaction(params: TaxVoidParams): Promise<Result<{ transactionId: string }>> {
    if (!this.adapter) return Ok({ transactionId: params.transactionId });
    return this.adapter.voidTransaction(params);
  }

  requireConfigured(): Result<TaxAdapter> {
    if (!this.adapter) {
      return Err(new CommerceValidationError("Tax adapter is not configured."));
    }
    return Ok(this.adapter);
  }

  // ── Runtime tax-rate management (issue #45) ────────────────────────────

  private requireRepository(): Result<TaxRatesRepository> {
    if (!this.repository) {
      return Err(new CommerceValidationError("Tax rate persistence is not available."));
    }
    return Ok(this.repository);
  }

  async createTaxRate(
    input: {
      name: string;
      country: string;
      state?: string | undefined;
      rateBps: number;
      appliesToShipping?: boolean | undefined;
      priority?: number | undefined;
      isActive?: boolean | undefined;
    },
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<TaxRate>> {
    const repo = this.requireRepository();
    if (!repo.ok) return repo;
    if (input.rateBps < 0) {
      return Err(new CommerceValidationError("rateBps must be non-negative."));
    }
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const rate = await repo.value.create(
      {
        organizationId: orgId,
        name: input.name,
        country: input.country.toUpperCase(),
        state: input.state?.toUpperCase() ?? null,
        rateBps: input.rateBps,
        appliesToShipping: input.appliesToShipping ?? true,
        priority: input.priority ?? 100,
        isActive: input.isActive ?? true,
      },
      ctx,
    );
    return Ok(rate);
  }

  async listTaxRates(actor?: Actor | null, ctx?: TxContext): Promise<Result<TaxRate[]>> {
    const repo = this.requireRepository();
    if (!repo.ok) return repo;
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    return Ok(await repo.value.findAll(orgId, ctx));
  }

  async updateTaxRate(
    id: string,
    patch: {
      name?: string | undefined;
      country?: string | undefined;
      state?: string | null | undefined;
      rateBps?: number | undefined;
      appliesToShipping?: boolean | undefined;
      priority?: number | undefined;
      isActive?: boolean | undefined;
    },
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<TaxRate>> {
    const repo = this.requireRepository();
    if (!repo.ok) return repo;
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const existing = await repo.value.findById(orgId, id, ctx);
    if (!existing) return Err(new CommerceNotFoundError("Tax rate not found."));
    const updated = await repo.value.update(
      id,
      {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.country !== undefined ? { country: patch.country.toUpperCase() } : {}),
        ...(patch.state !== undefined ? { state: patch.state?.toUpperCase() ?? null } : {}),
        ...(patch.rateBps !== undefined ? { rateBps: patch.rateBps } : {}),
        ...(patch.appliesToShipping !== undefined
          ? { appliesToShipping: patch.appliesToShipping }
          : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
      },
      ctx,
    );
    return Ok(updated!);
  }

  async deleteTaxRate(id: string, actor?: Actor | null, ctx?: TxContext): Promise<Result<{ deleted: true }>> {
    const repo = this.requireRepository();
    if (!repo.ok) return repo;
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const existing = await repo.value.findById(orgId, id, ctx);
    if (!existing) return Err(new CommerceNotFoundError("Tax rate not found."));
    await repo.value.delete(id, ctx);
    return Ok({ deleted: true });
  }
}
