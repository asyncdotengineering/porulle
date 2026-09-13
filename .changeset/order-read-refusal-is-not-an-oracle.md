---
"@porulle/core": minor
---

An unauthorized order read no longer reveals that the order exists.

> **This is a breaking change shipping as a minor, deliberately.** `@porulle/*` is pre-1.0, and
> semver reserves 0.x for exactly this: "Major version zero is for initial development. Anything
> MAY change at any time. The public API SHOULD NOT be considered stable." Going to 1.0.0 would
> declare the API stable, which is not yet true. The break is documented below and every caller in
> this repository is migrated in the same cycle.

**Breaking: `GET /api/orders/{idOrNumber}` answers `404 Order not found.` instead of
`403 You do not have access to this resource.` when the caller may not read the order.**

`OrderService.getById` looked the row up **before** authorizing it. A miss returned
`CommerceNotFoundError`; a hit fell through to `authorizeOrderRead`, which refused with
`CommerceForbiddenError`. Each refusal was correct on its own. Together they were an existence
oracle — `403` meant "this order is real", `404` meant it is not.

Entropy is what made that matter. A v4 uuid is not walked, but the same route also accepts an
**order number**, and order numbers come out of a sequence: short, ordered, and guessable by
construction. So an unauthenticated caller could enumerate order numbers against any store on this
framework and read off how many orders it has taken and when — commercially sensitive for every
adopter, and leaking before a single real order exists.

The instinct was already in the codebase one level down. The guest-access branch of
`authorizeOrderRead` refuses a stale cart secret with the *identical* error as a wrong one, with a
comment saying why: "fail with the identical error so a stale window is not an oracle telling the
caller their secret is valid." It was right and simply did not reach far enough up — the row's
existence had already leaked before that branch was consulted.

Now an unauthorized read answers exactly as a missing one does. `getByNumber` delegates to
`getById`, so both doors close at one line.

**Who is affected.** Only callers that distinguish the two refusals. A caller that treats any
non-2xx as "cannot show this order" needs no change. A caller that branches on `403` to prompt for
sign-in should branch on `401` (no credential resolved) instead — `404` now means "not yours or not
there", which is the only shape in which those two can share a door.

**What did not change.** A caller who may legitimately see the order still reads it: the owner, a
guest inside the cart-secret window, and any actor holding `orders:read` or `*:*`. Routes that
assert their permission *before* looking anything up — the note, timeline and refund sub-routes, via
`requireOrderAccess` — were never oracles and are untouched. `getByIdempotencyKey` keeps its
`CommerceConflictError`: its lookup is already partitioned by an actor-derived scope, so it never
reached a row the caller could not have created.

Pinned by `packages/core/test/order-read-refusal-is-not-an-oracle.test.ts`, which asserts the two
responses against **each other** rather than against expected literals — pinning each separately is
what let them drift apart, since both were individually correct and the defect lived only in the
difference.
