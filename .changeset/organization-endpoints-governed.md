---
"@porulle/core": patch
---

Refuse Better Auth's organization membership endpoints, leaving `/api/admin/staff` as the one governed membership surface.

The plugin's `update-member-role`, `invite-member`, `remove-member`, `leave` and role-CRUD endpoints ran none of the rules `admin/staff.ts` enforces: no permission containment, no rank floor, no last-owner invariant, and they accepted comma-composite role strings that `admin/staff.ts` refuses. `invite-member` only appeared safe because the plugin is configured with commerce permission arrays where its access-control model expects `Role` objects, so its permission check died of type confusion — fail-closed by accident, one "fix the roles wiring" commit from being fail-open. `update-member-role` was not even inert: the plugin short-circuits organization creators, so an owner reached it and could write a composite role.

All of them now return 403 pointing at `/api/admin/staff`. The roles configuration in `auth/setup.ts` is unchanged and deliberately so — handing the plugin real `Role` objects would stand up a second permission model to keep in agreement with the first, which is how the two layers came to disagree about composite roles and owner counting. The refusal is what makes the closure deliberate, and a test pins it.

**Breaking:** callers using Better Auth's organization endpoints to change membership must move to `/api/admin/staff`. Self-service `leave` is refused too; no REST route offered it, and the plugin's version had no last-owner protection.
