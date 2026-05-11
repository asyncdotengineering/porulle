# @porulle/adapter-tax-manual

`TaxAdapter` that applies a single flat rate. For stores that need basic tax math without a third-party service.

## Usage

```ts
import { defineConfig } from "@porulle/core";
import { manualTaxAdapter } from "@porulle/adapter-tax-manual";

export default defineConfig({
  tax: {
    adapter: manualTaxAdapter({
      rate: 0.08,                  // 8% flat
      shippingTaxable: true,       // default: true
    }),
  },
  // …
});
```

## What it does

`calculateTax` applies the rate to the line-item subtotal (post-discount) plus shipping if `shippingTaxable` is true. `reportTransaction` and `voidTransaction` are no-ops — there's nothing to file.

## When to use this

- Single-jurisdiction stores
- Local development / tests
- Markets where you handle filing manually outside the framework

For multi-jurisdiction tax calculation and automated filing, use `@porulle/adapter-taxjar` (or build a new adapter for your jurisdiction's preferred service).
