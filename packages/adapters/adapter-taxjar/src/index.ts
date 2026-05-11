import { Err, Ok, type TaxAdapter } from "@porulle/core";

export interface TaxJarAdapterOptions {
  apiKey: string;
  apiBaseUrl?: string;
  fromAddress?: {
    country?: string;
    postalCode?: string;
    state?: string;
    city?: string;
    line1?: string;
  };
  fetchImpl?: typeof fetch;
}

function safeDate(date: Date): string {
  return date.toISOString();
}

export function taxjarAdapter(options: TaxJarAdapterOptions): TaxAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.apiBaseUrl ?? "https://api.taxjar.com/v2";

  async function post(path: string, payload: unknown): Promise<Response> {
    return fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  }

  async function del(path: string): Promise<Response> {
    return fetchImpl(`${baseUrl}${path}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
      },
    });
  }

  return {
    providerId: "taxjar",

    async calculateTax(params) {
      try {
        const fromAddress = params.fromAddress ?? options.fromAddress;
        const payload = {
          from_country: fromAddress?.country,
          from_zip: fromAddress?.postalCode,
          from_state: fromAddress?.state,
          from_city: fromAddress?.city,
          from_street: fromAddress?.line1,
          to_country: params.toAddress?.country,
          to_zip: params.toAddress?.postalCode,
          to_state: params.toAddress?.state,
          to_city: params.toAddress?.city,
          to_street: params.toAddress?.line1,
          amount:
            params.lineItems.reduce(
              (sum, lineItem) => sum + lineItem.unitPrice * lineItem.quantity - (lineItem.discount ?? 0),
              0,
            ) + params.shippingAmount,
          shipping: params.shippingAmount,
          line_items: params.lineItems.map((lineItem) => ({
            id: lineItem.id,
            quantity: lineItem.quantity,
            product_identifier: lineItem.entityId,
            description: lineItem.description,
            unit_price: lineItem.unitPrice,
            discount: lineItem.discount,
            product_tax_code: lineItem.productTaxCode,
          })),
        };

        const response = await post("/taxes", payload);
        if (!response.ok) {
          return Err({
            code: "TAX_CALCULATION_FAILED",
            message: `TaxJar tax calculation failed (${response.status}).`,
          });
        }

        const body = (await response.json()) as {
          tax?: { amount_to_collect?: number; taxable_amount?: number; rate?: number; breakdown?: unknown };
        };

        const tax = body.tax ?? {};
        return Ok({
          amountToCollect: Math.round(Number(tax.amount_to_collect ?? 0)),
          taxableAmount: Number(tax.taxable_amount ?? 0),
          rate: Number(tax.rate ?? 0),
          ...(tax.breakdown !== undefined ? { breakdown: { taxjar: tax.breakdown } } : {}),
        });
      } catch (error) {
        return Err({
          code: "TAX_CALCULATION_FAILED",
          message: error instanceof Error ? error.message : "TaxJar tax calculation failed.",
        });
      }
    },

    async reportTransaction(params) {
      try {
        const fromAddress = params.fromAddress ?? options.fromAddress;
        const response = await post("/transactions/order", {
          transaction_id: params.transactionId,
          transaction_date: safeDate(params.transactionDate),
          from_country: fromAddress?.country,
          from_zip: fromAddress?.postalCode,
          from_state: fromAddress?.state,
          from_city: fromAddress?.city,
          from_street: fromAddress?.line1,
          to_country: params.toAddress?.country,
          to_zip: params.toAddress?.postalCode,
          to_state: params.toAddress?.state,
          to_city: params.toAddress?.city,
          to_street: params.toAddress?.line1,
          amount: params.amount,
          shipping: params.shipping,
          sales_tax: params.salesTax,
          customer_id: params.customerId,
          line_items: params.lineItems.map((lineItem) => ({
            id: lineItem.id,
            quantity: lineItem.quantity,
            product_identifier: lineItem.entityId,
            description: lineItem.description,
            unit_price: lineItem.unitPrice,
            discount: lineItem.discount,
            product_tax_code: lineItem.productTaxCode,
          })),
        });

        if (!response.ok) {
          return Err({
            code: "TAX_REPORT_FAILED",
            message: `TaxJar transaction report failed (${response.status}).`,
          });
        }

        return Ok({ transactionId: params.transactionId });
      } catch (error) {
        return Err({
          code: "TAX_REPORT_FAILED",
          message: error instanceof Error ? error.message : "TaxJar transaction report failed.",
        });
      }
    },

    async voidTransaction(params) {
      try {
        const response = await del(`/transactions/orders/${encodeURIComponent(params.transactionId)}`);
        if (!response.ok) {
          return Err({
            code: "TAX_VOID_FAILED",
            message: `TaxJar transaction void failed (${response.status}).`,
          });
        }
        return Ok({ transactionId: params.transactionId });
      } catch (error) {
        return Err({
          code: "TAX_VOID_FAILED",
          message: error instanceof Error ? error.message : "TaxJar transaction void failed.",
        });
      }
    },
  };
}
