---
"@porulle/core": minor
---

Replace implicit role and write-permission authorization with explicit permissions for unpublished catalog reads and assisted order customer attribution.

Merchants whose custom roles relied on `catalog:update` or a staff-shaped role name must grant `catalog:read:unpublished` and/or `orders:create:on-behalf` explicitly. The default `manager` role receives both scopes; `customer` receives neither.

This release also tightens `customerId` validation for on-behalf order creation. Every supplied customer ID must now identify an existing customer in the caller's organization; dangling IDs, cross-organization IDs, and older integrations that stored an auth user ID directly as `customerId` now receive a validation error. Those integrations must resolve or migrate the value to the organization's customer profile ID before creating orders.

Self-attribution at order creation now follows `orders:read:own`. An actor that holds neither `orders:create:on-behalf` nor `orders:read:own` creates a **guest order** rather than having a customer profile minted for it — which is what previously happened to operators, silently attributing every walk-in sale to the cashier. Two consequences to check before upgrading. A custom shopper role carrying `orders:create` without `orders:read:own` — including any deployment that trims `auth.customerPermissions`, or grants unscoped `orders:read` instead — now produces guest orders where it previously self-attributed; grant `orders:read:own` to restore it. And an actor lacking `orders:create:on-behalf` that supplies a `customerId` has it ignored rather than refused, so a missing scope shows up as lost attribution rather than an error.

This is a proxy and it is deliberately a stopgap: the honest discriminator is caller intent, which a storefront route knows and the order service cannot see. It is recorded here rather than left implicit because a change whose whole thesis is replacing implicit permission semantics should not ship a new one silently.
