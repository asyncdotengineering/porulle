# @porulle/import-woocommerce

Import a WooCommerce store's catalog into Porulle. Maps WooCommerce's product / variation / attribute / image model onto Porulle's catalog.

## Usage

Export your WooCommerce catalog as JSON (via the WooCommerce REST API or the WP-CLI):

```bash
wp wc product list --user=admin --format=json > woo-catalog.json
porulle import ./woo-catalog.json --format woocommerce
```

Or programmatically:

```ts
import { importWooProducts } from "@porulle/import-woocommerce";
import { commerce } from "./server";

const products = JSON.parse(await fs.readFile("./woo-catalog.json", "utf-8"));
const result = await importWooProducts(commerce.api, products);
if (!result.ok) {
  console.error("import failed:", result.error);
  process.exit(1);
}
```

## What it maps

| WooCommerce | Porulle |
|---|---|
| `product` (simple, variable) | `sellable_entities` (type: `product`) |
| `variation` | `variants` |
| `attribute` (pa_size, pa_color, …) | `option_types` + `option_values` |
| `images[]` | `media_assets` + `entity_media` |
| `categories[]` | `entity_categories` (creates `categories` rows on first sight) |
| `tags[]` | `metadata.tags` |
| `meta_data[]` | `metadata.<key>` |

## What it doesn't map

- Customers, orders, coupons — same reasoning as the Shopify importer
- Tax rates — Porulle's tax adapter handles this; configure separately
- Shipping zones — set up via `config.shipping`
- WP users / themes / plugins — out of scope

## See also

- `@porulle/import-flat` — neutral JSON format
- `@porulle/import-shopify` — for Shopify origins
- [WooCommerce REST API — Products](https://woocommerce.github.io/woocommerce-rest-api-docs/#products)
