---
"@porulle/plugin-channel-connector": minor
---

Let a consumer confine which connected stores a read returns.

`listStores` filtered on `organizationId` alone, so every caller saw every store in the
organization. That is right for a single-tenant deployment and wrong for a marketplace, where one
organization holds many sellers.

`ChannelConnectorPluginOptions.confineStoreReads` takes a request context and returns the store ids
the caller may read: `null` to decline to confine, which is the default and leaves existing
behaviour untouched, or an array, where `[]` means none. The ids are applied in the WHERE clause
rather than filtered out of the result, so no other caller of `listStores` is left unconfined and a
change to the returned shape cannot silently break the confinement.

It takes ids rather than a tenant on purpose: `vendor`, `seller` and `team` are models a consumer
owns, and this package is generic commerce. The consumer resolves the meaning and hands back the
answer.

No status predicate was added or removed — `listStores` has never had one, and disconnected stores
keep being returned.
