---
"@porulle/core": minor
---

Resolves seven admin/operator API gaps (#40–#46): `POST /orders/{id}/fulfillments` (tracking + partial shipment), pricing-modifier list/patch/delete, order line-item editing with totals recalc, cart listing + abandoned-checkout recovery (`GET /carts`, `POST /carts/{id}/recover`, cart `email` column), runtime shipping zones/rates and tax rates with org-scoped CRUD REST applied at checkout (new `shipping_zones`, `shipping_rates`, `tax_rates` tables — consumers regenerate migrations), and admin staff/RBAC REST over the Better Auth member table (`/admin/staff*`). New permission scopes: `cart:manage`, `shipping:manage`, `tax:manage`, `staff:manage`.
