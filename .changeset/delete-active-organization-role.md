---
"@porulle/core": patch
---

Delete `activeOrganizationRole`, a session field nothing ever writes

`createAuth` declares `user.additionalFields` and no `session.additionalFields`
at all, and Better Auth's organization plugin contributes `activeOrganizationId`
and `activeTeamId` — neither is a role. So the field was only ever a type: the
`if (!role)` guard below it always held and `findMembershipRole` always ran.

**Removed from the published type surface:** `Session["activeOrganizationRole"]`
and the internal `enrichedSession`, which existed only to carry the field into
`resolvePermissions`. `resolvePermissions` now takes the role directly and
returns the same three outcomes for a falsy, known and unknown role.

Deleting a guard that never holds cannot change behaviour, and the query-count
suite says so rather than asserting it: a shopper still costs three statements
(session, user, one membership miss) and an organization member still costs one
indexed membership read. No assertion number moved.
