---
"@porulle/core": minor
---

Replace custom-role grant checks with permission containment so a caller holding `staff:manage` cannot grant itself or peers a role carrying permissions it lacks (including `*:*`). Invitations are deferred grants, so they now use the same containment and rank checks as immediate role changes.

Restore the rank floor for new-role grants, so a grant must satisfy both containment and rank. `owner` becomes unreachable for every role below it: an `admin` can no longer grant `owner`, and neither can a custom role carrying `*:*`. A custom `*:*` role still *can* grant `admin`, because it is floored at admin rank deliberately — that floor is what stops a lesser role revoking it — and granting `admin` hands out nothing the minter does not already hold. API-key actors regain grant ability based on their stamped permission list rather than their `api_key` role name, which limits them to contained custom roles at their own rank.

**Breaking:** a custom role that could previously grant a peer custom role can no longer grant one whose permissions are not a subset of its own.
