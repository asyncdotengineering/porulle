# @porulle/import-flat

Import catalog entities from a flat JSON file. The lowest-friction format — define an array of products, run `porulle import`, done.

## Usage

```bash
porulle import ./catalog.json
```

Format:

```json
[
  {
    "type": "product",
    "slug": "ceylon-black-tea-50g",
    "attributes": {
      "locale": "en",
      "title": "Ceylon Black Tea (50g)",
      "description": "Single-estate, hand-picked.",
      "subtitle": "Uva region"
    },
    "metadata": { "weight": 50, "material": "tea leaves" },
    "variants": [
      { "sku": "CBT-50G", "options": { "size": "50g" }, "price": 1200 }
    ]
  }
]
```

## When to use

- Seeding a new store with a small fixed catalog
- Internal inventory dumps converted from a spreadsheet (export CSV → flatten to JSON)
- Test fixtures
- Anything that doesn't have a Shopify or WooCommerce origin

For Shopify migrations: `@porulle/import-shopify`. For WooCommerce: `@porulle/import-woocommerce`.

## See also

- `@porulle/cli` — `porulle import` command
- `apps/store-example/src/scripts/seed.ts` — programmatic seeding example
