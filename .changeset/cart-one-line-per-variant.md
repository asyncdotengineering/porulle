---
"@porulle/core": minor
---

Breaking: a cart holds one line per variant, enforced by the database, and adding to it is one atomic statement. `CartItemMatcher` and `defaultCartItemMatcher` are removed from the public API (nothing in this repo or its consumers passed a matcher; `CartServiceDeps.cartItemMatcher` was never wired from the kernel), and `CartRepository.createLineItem` / `findLineItemByEntity` are replaced by `CartRepository.addToLine`.

- `cart_line_items` gains the unique constraint `cart_line_items_cart_entity_variant_unique` on `(cart_id, entity_id, variant_id)` with `NULLS NOT DISTINCT` (Postgres 15+), so a product without variants also has one line.
- `CartService.addItem` is an upsert: `INSERT … ON CONFLICT (cart_id, entity_id, variant_id) DO UPDATE SET quantity = cart_line_items.quantity + excluded.quantity`. It used to read the lines, then write `existing + n` (absolute) or insert: two concurrent adds of one variant made two lines, and an add that read before another writer (a payment settling the line) wrote a stale quantity back. An existing line keeps its price snapshot, currency and metadata; the price is resolved for every add (the insert needs it).
- `CartService.merge` moves lines onto the target's line for the same variant instead of inserting a second one.

Migration for an existing database: merge duplicate `(cart_id, entity_id, variant_id)` lines into one (sum the quantities, keep the earliest row) before adding the constraint, or the constraint cannot be created. minimal-draft-suite ships this as `apps/merchant-center-api/drizzle/apply-cart-line-unique.sql`.
