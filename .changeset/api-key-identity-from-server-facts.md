---
"@porulle/core": minor
"@porulle/plugin-pos": minor
---

An API key acts only as what the server knows it is. Its organization is the key's `referenceId` (organization-referenced
scopes) and its user is the `referenceId` (user-referenced scopes). Key metadata is client-writable, so `organizationId` and
`operatorId` in it are claims: one is accepted only when the `member` table says that user belongs to that organization, and a
key whose claim does not hold is refused `401`. Before this, any organization owner could write another user's id into a key's
metadata and read that person's profile, orders and addresses through `/api/me`.

- The customer portal (`/api/me/*`) refuses every API key (`403`), including one that names a person.
- A customer profile copies the auth user's email only once it is verified.
- `catalog.listProposedCustomFields(params, actor)` is the service method behind `GET /api/admin/custom-field-proposals`, with a
  `sourceStoreIds` filter (an empty list matches nothing), so a plugin can confine the list the way it confines `catalog.list`.
- Breaking for `@porulle/plugin-pos`: PIN login no longer creates a user row for the operator and refuses an operator who is not
  a member of the store organization. Give each cashier a membership (any role; the shift key carries its own permissions).
