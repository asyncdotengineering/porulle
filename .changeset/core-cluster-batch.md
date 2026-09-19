---
"@porulle/core": minor
"@porulle/plugin-channel-connector": minor
---

Close five defects found by auditing what core declares against what it does

**`assertOwnership` refuses a credential-less caller 401 instead of 403.** It was the last guard in `auth/permissions.ts` not given `isUnauthenticatedActor`, and its no-actor branch threw a 403 whose own message read "Authentication required." An API-key actor still gets 403 — it presented a credential — and a blank-string identity still gets 403, both by construction of the predicate rather than by special-casing. Behaviour change for any caller reaching ownership checks without a session.

**A list route's declared pagination shape now matches the one it serves.** `paginatedResponse` declared `meta: { page, limit, total? }` while `GET /api/orders` and `GET /api/catalog/entities` served `meta: { pagination: { page, limit, total, totalPages } }`. The OpenAPI document, and therefore every generated SDK type, described a `meta.total` the server never sent — a consumer reading it got `undefined` with no type error and no test failure, because every list handler sits under a `@ts-expect-error`. The schema moved to match the wire, not the reverse; `meta.pagination` was already the house shape in the customer schemas. The customer-portal orders route, whose two return paths disagreed with each other, now serves the nested shape on both.

**`PriceResolutionContext` no longer accepts a `customerId` it discards.** The resolver's only customer-dimension matching reads `customerGroupIds`; nothing ever derived groups from the id, so a caller passing the obvious field got list price while believing otherwise. The field is removed rather than wired up because `customer_group_members` has no writer — `addToGroup`, `removeFromGroup` and `findGroupsByCustomerId` exist on the repository and are called by nothing — so resolving from it would have added a database round trip to a money path to answer a guaranteed miss. Callers now derive the parameter type from the service instead of restating it, so the removal cannot silently drift back. Group-scoped pricing through an explicit `customerGroupIds` is unchanged.

**`sendOrderStatusEmail` is deleted.** It had never sent an email: it declared its own result shape while `changeStatus` passed the hydrated order, so `result.newStatus` was always `undefined` and the hook returned early on every call since it was written. It was unexported and its behaviour was empty, so nothing can regress. The `orders.afterStatusChange` seam and its other subscribers are untouched.

**A store whose connector is unregistered no longer answers a silent success.** `executeCatalogPushJob` returned `Ok({ noop: true })` both for a registered connector that cannot push a catalog and for a provider not registered at all — a store pointing at nothing, which is what a removed or renamed connector leaves behind. The absent case now returns a named error in the same words the rest of the service uses. A registered-but-push-less connector stays a no-op, and a store with catalog writes deliberately disabled stays a no-op whether or not a connector is registered.

Also: the headline checkout suite no longer passes on failure. `api-checkout.test.ts` asserted `expect([201, 422, 500]).toContain(response.status)` in four cases, so a created order, a validation failure and an internal error were all green in the suite covering the framework's most important route. Each case now asserts one status and the shape behind it.
