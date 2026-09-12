---
"@porulle/core": minor
---

Resolve an actor's organization membership with one indexed read instead of the organization plugin's endpoints.

`resolveActor` discovered a caller's role by calling `getFullOrganization` — which loads the organization row, its invitations and its entire member list, then scans in JavaScript for a single membership — and then `getActiveMemberRole`, which looks for the same membership again. Both take `headers` and re-resolve the session from them, so each also re-read `session` and `user`, and the plugin wrote `active_organization_id` back to the session row on every request, putting a write on the hot path of every GET.

For a shopper every one of those lookups is a guaranteed miss: a shopper is not a member of the platform organization and never will be. The member-by-organization scan also grew with the member list, so the busiest request on the platform got slower as the platform got bigger.

Membership is now read once, directly, by `(user_id, organization_id)`. An authenticated request costs three statements where it cost around a dozen, and resolving an actor no longer writes.

The `Actor` shape, the `resolveActor` signature and all permission semantics are unchanged, `sessionCreatedAt` included. `test/auth-resolve-actor-query-count.test.ts` pins the counts per table so a future change cannot trade one wasteful read for another and keep the total looking healthy.
