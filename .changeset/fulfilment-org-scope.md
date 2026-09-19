---
"@porulle/core": minor
---

Confine fulfilment lookups and the tracking write to the caller's organization

`updateTracking` read a fulfilment with no tenant predicate and wrote carrier,
tracking number, status and the shipped/delivered timestamps through an update
whose only predicate was the fulfilment id. The method took no actor, so there
was nothing to confine it by. `createFulfillment`, on the same service and the
same row, already asserted a permission and resolved an organization — you could
not create a fulfilment outside your organization, but you could update any
fulfilment's tracking from anywhere.

`fulfillment_records` has no organization column; its non-null `orderId` is the
only authoritative edge to `orders.organizationId`. So the predicate now binds
the supplied id to the caller's organization through that foreign key, in the
query, for the read and for the write. `findById` and `findByOrderId` join
`orders`; `update` and `incrementDownloadCount` carry a correlated `EXISTS`
inside the `UPDATE` itself rather than inheriting confinement from a preceding
read.

**Behaviour change for direct service callers.** `updateTracking` and
`getByOrderId` now take an `actor` before `ctx`, and the fulfilment repository's
`findById`, `findByOrderId`, `update`, `updateStatus`, `incrementDownloadCount`,
`isDownloadAllowed`, `isAccessGrantActive`, `activateAccessGrant` and
`deactivateAccessGrant` take an organization id as their first argument. A
cross-tenant id now returns the same not-found as a missing one, so the refusal
is not an existence oracle. Collection methods that remain unscoped are labelled
rather than silently left.
