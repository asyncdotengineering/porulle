---
"@porulle/adapter-shopify": minor
"@porulle/adapter-woocommerce": minor
---

Import what a catalog needs to be read by AI shopping agents.

- Shopify: a product's Standard Product Taxonomy category arrives as `metadata.shopifyTaxonomyCategoryId` (Shopify's own id, e.g. `aa-1-4`), so a platform that classifies against the same taxonomy can use it instead of guessing from text. The query now reads `category { id name }`.
- WooCommerce: `global_unique_id` (GTIN, UPC, EAN or ISBN; core since WooCommerce 9.2) imports as the variant's `barcode`, for simple products and for each variation.
- WooCommerce: `short_description` imports beside `description`, summary first, as the product page shows them. A store that writes only a summary no longer imports with no description. Existing products re-converge once with the combined text.
