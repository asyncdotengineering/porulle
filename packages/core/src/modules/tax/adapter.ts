import type { Result } from "../../kernel/result.js";

export interface TaxAddress {
  country: string;
  postalCode: string;
  state?: string;
  city?: string;
  line1?: string;
}

export interface TaxLineItem {
  id: string;
  entityId: string;
  description: string;
  quantity: number;
  unitPrice: number;
  discount?: number;
  productTaxCode?: string;
}

export interface TaxCalculationParams {
  currency: string;
  customerId?: string;
  orderId?: string;
  fromAddress?: TaxAddress;
  toAddress?: TaxAddress;
  shippingAmount: number;
  lineItems: TaxLineItem[];
}

export interface TaxCalculationResult {
  amountToCollect: number;
  taxableAmount: number;
  rate: number;
  breakdown?: Record<string, unknown>;
}

export interface TaxReportParams {
  transactionId: string;
  transactionDate: Date;
  currency: string;
  customerId?: string;
  fromAddress?: TaxAddress;
  toAddress?: TaxAddress;
  amount: number;
  shipping: number;
  salesTax: number;
  lineItems: TaxLineItem[];
}

export interface TaxVoidParams {
  transactionId: string;
}

export interface TaxAdapter {
  readonly providerId: string;
  calculateTax(params: TaxCalculationParams): Promise<Result<TaxCalculationResult>>;
  reportTransaction(params: TaxReportParams): Promise<Result<{ transactionId: string }>>;
  voidTransaction(params: TaxVoidParams): Promise<Result<{ transactionId: string }>>;
}
