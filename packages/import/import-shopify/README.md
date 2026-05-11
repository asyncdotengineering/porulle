# @porulle/import-shopify

Import a Shopify store's catalog into Porulle. Maps Shopify's product / variant / option / image model onto `sellable_entities`, `variants`, `option_types`, `option_values`, `entity_media`.

## Usage

Export your Shopify catalog (JSON via the Admin API or `shopify CLI products list --json`):

```bash
shopify products list --json > shopify-catalog.json
porulle import ./shopify-catalog.json --format shopify
```

Or programmatically:

```ts
import { importShopifyProducts } from "@porulle/import-shopify";
import { commerce } from "./server";

const products = JSON.parse(await fs.readFile("./shopify-catalog.json", "utf-8"));
const result = await importShopifyProducts(commerce.api, products);
if (!result.ok) {
  console.error("import failed:", result.error);
  process.exit(1);
}
```

## What it maps

| Shopify | Porulle |
|---|---|
| `Product` | `sellable_entities` (type: `product`) |
| `Variant` | `variants` |
| `Option` (Size, Color, …) | `option_types` + `option_values` |
| `Image` | `media_assets` + `entity_media` (role: gallery / primary) |
| `tags` | `metadata.tags` |
| `vendor` | `metadata.vendor` (or wired to a brand if you've enabled brands) |

## What it doesn't map

- Customers — Shopify customer export needs PII review; bring your own migration script
- Orders — Porulle doesn't import historical orders (different schema, different fulfillment state machine)
- Discounts — Shopify's discount engine is shaped differently; rebuild as Porulle promotions
- Apps / themes / scripts — out of scope

## See also

- `@porulle/import-flat` — neutral JSON format
- `@porulle/import-woocommerce` — for WooCommerce origins
- [Shopify Admin API — Product](https://shopify.dev/docs/api/admin-rest/latest/resources/product)
