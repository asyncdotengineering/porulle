---
"@porulle/core": minor
---

Close every breach found by five adversarial security rounds against the catalog read path, and make the class of defect that produced them structurally harder to reintroduce.

**Three changes matter more than any individual fix.**

Route coverage is asserted at server construction. Every route in the production table must be either guarded or named in an explicit allowlist with a written justification, so an unguarded route fails startup instead of passing an isolated test. The previous guard was blind to `/api/me`, which carried the worst breach in the codebase.

Organization resolution refuses rather than guessing. `resolveOrgId` previously fell back to the deprecated `org_default` constant for any request with no actor, which served one merchant's data to unauthenticated callers on every allowlisted read path. It now throws instead. Note the precise scope: a configured `auth.defaultOrganizationId` is still consulted first and still answers, which is correct for a single-tenant deployment and is why this is not a blanket fail-closed. A multi-tenant deployment should leave that unset so the refusal takes effect. Set `auth.strictOrgResolution: false` (or `STRICT_ORG_RESOLUTION=false`) to restore the previous permissive behaviour during a migration.

Guest identity is a positive credential rather than an absence. A guest cart carries a secret that must be presented to read it, an actor with no user identity carries `null` instead of a shared placeholder, and internal service reads use explicit `getByIdForInternalUse` paths rather than impersonating the caller.

**Breaking for consumers.**

`Actor.userId` is now `string | null`. Any code that keys a per-person resource on it — an `operatorId`, a `requestedBy`, a `purchaserId` — must handle the absent case. Use the new `requireUserId(actor)` export, which refuses a null or blank identity rather than returning one that reads as a person. An API key that carries neither an operator nor a reference now has no user identity at all; previously it carried the empty string, which made every such key look like the same person to an ownership check.

`catalog.list` and `catalog.getById` apply the storefront visibility policy: a caller without `catalog:update` sees only entities that are `active` and visible. Service-layer calls that previously omitted an actor and received drafts must now pass the actor they are acting for. `catalog.getAttributes` takes an `actor` argument and asserts `catalog:read`.

Order creation validates line-item entities through an internal organization-scoped read, so an operator can still sell an unpublished product, while an unprivileged buyer cannot. The refusal is indistinguishable from a not-in-organization refusal, so nothing new is discoverable.
