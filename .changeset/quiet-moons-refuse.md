---
"@porulle/core": minor
---

Tell a caller with no credential to authenticate, and let a route declare it needs no identity.

Two additive authorization seams, shipped together because both are about what an actor means on a request that has no identity.

**A caller with no credential was told it was personally forbidden.** Once a `storeResolver` is configured, an unauthenticated request no longer arrives without an actor — the middleware sets an anonymous customer actor so the public storefront can read a catalog — and it then reached the permission guard and was refused `403 Permission 'cart:manage' is required.` RFC 9110 §15.5.4 reserves 403 for a refusal that holds whatever credentials accompany the request, and this one does not hold: signing in resolves it. The body also named a permission to a caller with no identity.

A new `isUnauthenticatedActor` predicate separates *no credential* from *a credential that lacks the permission*, and the refusal is now `401 UNAUTHORIZED` with no permission named. An **API key keeps its 403**, whatever its `referenceId`: it did present a credential, and telling it to authenticate is advice it cannot act on. The same rule applies in `requirePerm`, `requireAnyPerm`, the plugin router's guard, `assertPermission`, and the customer-cart read, so the three copies of it cannot drift. `CommerceUnauthorizedError` is exported and maps to 401; it deliberately does **not** extend `CommerceForbiddenError`, which would make every `toThrow(CommerceForbiddenError)` unable to tell the two apart.

The customer portal separates them too, and that clause is load-bearing rather than cosmetic: every route under its guard reads `actor.userId` as a `string`, so an API key with no person is refused `403 The customer portal requires a signed-in user, not an API key.` rather than being let through to a null.

**`authMiddleware` resolved an actor for every route.** Mounted `app.use("*", …)`, it issued three database statements before any handler, including for routes that read no actor at all — measured on a deployed Worker as 146 ms for `GET /api/health` with no credential against 176 ms with one, purely for an actor the route never consults.

A route can now declare it needs none. `GET /api/health`, `/api/doc` and `/api/doc-ext` are declared by core, each verified against its handler; an app adds its own with `auth.identityFreeRoutes: ["POST /api/payments/notify"]`. Matching is exact on method and path — no globs, because a glob is how one entry silently widens to cover a route that does need an identity — and config entries are additive and cannot remove a default. **The default is to resolve:** a route that declares nothing keeps its actor, and that direction is pinned by a test rather than assumed.

One consequence is worth knowing before declaring a route. The wrapper that opens the plugin database scope derives its organization from the resolved actor, so a route with no actor gets no scope, and plugin reads and writes on it run with no organization predicate while the handler still answers normally. Such a route must open its own scope, the way a signed webhook builds its actor from the payload it verified.
