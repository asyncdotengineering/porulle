---
"@porulle/core": patch
---

Make the last-owner guard atomic, so two owners cannot revoke each other into an ownerless organization.

The guard counted owners with a plain `SELECT` and then wrote unconditionally. Two concurrent revocations both read `count = 2`, both proceeded, and the organization was left with no owner at all — and an `admin` survivor then outranked everyone. The demote path had the same shape.

Both paths now read the organization's membership with `SELECT … FOR UPDATE` inside the transaction that performs the write, ordered by id so two concurrent revocations cannot deadlock. The second request re-reads after the first commits and is refused with the existing 422.

No schema-level constraint backs this. "At least one row in a group" is not expressible as a check or partial-unique constraint; only a trigger could enforce it, and this schema has none. The lock is held at the single place both mutations pass through instead.
