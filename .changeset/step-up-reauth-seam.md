---
"@porulle/core": minor
---

Step-up re-authentication: a typed refusal and the session's authentication time on the actor.

An app can now require that a caller authenticated *recently*, not merely that it is
authenticated, and say so in a way a client can act on.

- `CommerceReauthRequiredError` carries `code: "REAUTH_REQUIRED"` and maps to **401**.
  It exists because the alternatives are all lossy: returning `Err` lets each route
  translate the refusal into its own status (a customer-portal address write becomes
  422, a delete becomes 404 — "that address does not exist"), an unrecognised
  `CommerceError` code falls through to 500, and an `HTTPException(401)` has its body
  rebuilt as `UNAUTHORIZED` with the message scrubbed in production. Discriminate on
  the code, never the message.
- `Actor.sessionCreatedAt` is the `createdAt` of the Better Auth session behind the
  actor, as an ISO string, set by `resolveActor` from the session it already fetches.
  A guard that needs the authentication time no longer has to resolve the session a
  second time, which on a serverless database is a second round trip per guarded call.

`sessionCreatedAt` is **optional** on `Actor`, deliberately. Making it required is the
louder design and was tried first: it produced 96 type errors across roughly fifty
hand-built actor literals, every one of which would have written `null`. That is noise
that proves nothing, so the field is optional and absence carries the meaning. A guard
must read an absent value as **"cannot establish, refuse"** and never as "recent" —
an API key, a store resolver and a hand-built test actor all legitimately have no
session. `createSystemActor` states `sessionCreatedAt: null` explicitly rather than
omitting it, so the one constructed identity in the package that runs privileged work
says out loud that it proved nothing to anybody.
