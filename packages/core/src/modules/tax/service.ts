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
import type { TaxRate, TaxRatesRepository } from "./repository/index.js";

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
   * Calculates tax. Resolution order (issue #45):
   * 1. Runtime tax rates for the org matching `toAddress` — state-specific
   *    matches beat country-level; matches at the winning specificity are
   *    summed (e.g. GST + PST).
   * 2. The configured tax adapter.
   * 3. Zero tax.
   */
  async calculate(
    params: TaxCalculationParams,
    orgId?: string,
    ctx?: TxContext,
  ): Promise<Result<TaxCalculationResult>> {
    if (this.repository && orgId && params.toAddress) {
      const matched = await this.matchRuntimeRates(orgId, params.toAddress, ctx);
      if (matched.length > 0) {
        const taxableAmount = params.lineItems.reduce(
          (sum, lineItem) =>
            sum + lineItem.unitPrice * lineItem.quantity - (lineItem.discount ?? 0),
          0,
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
