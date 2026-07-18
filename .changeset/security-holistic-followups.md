---
"@porulle/core": patch
---

Security hardening from the holistic review (R-03–R-07):

- Orders discriminate a missing inventory record by a typed code (`INVENTORY_RECORD_NOT_FOUND`) instead of matching the message string — new `CommerceInventoryRecordNotFoundError`, emitted by the inventory service from a single shared message constant.
- The stale-order-cleanup job enumerates orgs and reads each org's stale orders under an explicit `organizationId` predicate, so no query returns another tenant's order rows.
- The scoped-db proxy re-wraps the result of an intercepted `.where()`, so a chained `.where(a).where(b)` can no longer drop the injected org predicate (Drizzle's second `.where` replaces the first).
- Promotions usage recording (`FOR UPDATE` lock + limit read) and `webhooks.findFailedDeliveries` are scoped by `organizationId` (the latter via its parent endpoint).
