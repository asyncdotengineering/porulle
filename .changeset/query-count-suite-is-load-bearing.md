---
"@porulle/core": patch
---

Say why the `resolveActor` query-count suite is load-bearing for a card it predates

`1939c7c4` (delete `activeOrganizationRole`) asked for its own stubbed-adapter
call count. It was deliberately not written, because
`auth-resolve-actor-query-count` already proves the same property against a real
adapter and a weaker duplicate justified only by a card naming it is the wrong
thing to add.

The cost of that choice is that these numbers now carry a contract nobody
editing the file would know about: the shopper's `3` is what says the deletion
did not change what runs, so relaxing it removes the only evidence that a
shipped deletion was behaviour-preserving. The file now says so, and keeps the
two measurements apart — SQL statements within one request (3) versus adapter
calls across two (2) — because they were once read as contradicting each other.
