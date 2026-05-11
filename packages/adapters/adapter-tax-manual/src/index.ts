import { Ok, type TaxAdapter, type TaxCalculationParams } from "@porulle/core";

export interface ManualTaxAdapterOptions {
  rate: number;
  shippingTaxable?: boolean;
}

function taxableSubtotal(params: TaxCalculationParams, shippingTaxable: boolean): number {
  const lineTaxable = params.lineItems.reduce(
    (sum, lineItem) => sum + lineItem.unitPrice * lineItem.quantity - (lineItem.discount ?? 0),
    0,
  );
  return lineTaxable + (shippingTaxable ? params.shippingAmount : 0);
}

export function manualTaxAdapter(options: ManualTaxAdapterOptions): TaxAdapter {
  const rate = Math.max(0, options.rate);

  return {
    providerId: "tax-manual",
    async calculateTax(params) {
      const taxableAmount = taxableSubtotal(params, options.shippingTaxable ?? true);
      const amountToCollect = Math.round(taxableAmount * rate);
      return Ok({
        amountToCollect,
        taxableAmount,
        rate,
      });
    },
    async reportTransaction(params) {
      return Ok({ transactionId: params.transactionId });
    },
    async voidTransaction(params) {
      return Ok({ transactionId: params.transactionId });
    },
  };
}
