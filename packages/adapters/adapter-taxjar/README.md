# @porulle/adapter-taxjar

`TaxAdapter` for [TaxJar](https://www.taxjar.com). Calculates sales tax, files transactions, and voids them on refund.

## Usage

```ts
import { defineConfig } from "@porulle/core";
import { taxjarAdapter } from "@porulle/adapter-taxjar";

export default defineConfig({
  tax: {
    adapter: taxjarAdapter({
      apiKey: process.env.TAXJAR_API_KEY!,
      fromAddress: {
        country: "US",
        state: "CA",
        postalCode: "94110",
        city: "San Francisco",
        line1: "1 Market St",
      },
    }),
  },
  // …
});
```

## What it implements

| Adapter method | TaxJar endpoint |
|---|---|
| `calculateTax(params)` | `POST /v2/taxes` — returns `amountToCollect`, `taxableAmount`, `rate` |
| `reportTransaction(params)` | `POST /v2/transactions/orders` — files the order for jurisdictional reporting |
| `voidTransaction(params)` | `POST /v2/transactions/refunds` — refund-flow reversal |

## Notes

- Use `apiBaseUrl: "https://api.sandbox.taxjar.com/v2"` for the sandbox.
- For low-volume / single-rate stores, `@porulle/adapter-tax-manual` avoids the external dependency.

## See also

- [TaxJar API docs](https://developers.taxjar.com)
- `@porulle/adapter-tax-manual` — flat-rate alternative
