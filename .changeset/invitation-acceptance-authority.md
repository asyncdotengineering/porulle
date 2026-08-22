---
"@porulle/core": patch
---

Re-check the inviter's authority when an invitation is accepted, not only when it is created.

Containment and rank were enforced at invitation creation and never revisited, while acceptance went through Better Auth's `/organization/accept-invitation`, which validates only that the invitation exists, is pending, is unexpired, and matches the session email. A demoted or revoked inviter's outstanding invitation still minted admins and owners for the invitation's full seven-day life — enough for a complete organization takeover.

Acceptance now re-reads the inviter's current membership and re-runs the same containment and rank rules `admin/staff.ts` applies, refusing the grant and cancelling the invitation when the inviter can no longer confer that role. Demoting or revoking a member additionally cancels the pending invitations their new role could not issue, so the invitation list stays honest.

The grant arithmetic moved to `auth/role-authority.ts` so both surfaces answer the question the same way.

**Migration:** deployments holding pending invitations should expect any whose inviter has since lost authority to be refused and marked `canceled` on first acceptance attempt. Re-issue them from an account that currently holds the authority.
