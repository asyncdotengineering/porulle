import { CommerceValidationError } from "../../kernel/errors.js";
import { Err, Ok, type Result } from "../../kernel/result.js";
import type {
  TaxAdapter,
  TaxCalculationParams,
  TaxCalculationResult,
  TaxReportParams,
  TaxVoidParams,
} from "./adapter.js";

interface TaxServiceDeps {
  adapter: TaxAdapter | undefined;
}

export class TaxService {
  private adapter: TaxAdapter | undefined;

  constructor(deps: TaxServiceDeps) {
    this.adapter = deps.adapter;
  }

  async calculate(params: TaxCalculationParams): Promise<Result<TaxCalculationResult>> {
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
}
