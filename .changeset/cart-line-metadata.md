---
"@porulle/core": minor
---

`POST /api/carts/:id/items` accepts optional `metadata` on the line: a flat map of at most 16 keys (key up to 64 characters; value a string up to 256 characters, a number, a boolean or null). A storefront records why the piece was added — the search that showed it, whether it is a gift — and the line carries it on. The core checkout (`/api/checkout`) now copies each cart line's metadata onto its order line; it used to build the order lines without it. Lines still merge on entity and variant (`defaultCartItemMatcher`): adding a piece already in the cart raises the quantity and keeps the first add's metadata.
