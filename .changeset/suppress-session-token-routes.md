---
"@porulle/core": minor
---

Stop serving the two auth routes whose only currency is a raw session token

`GET /api/auth/list-sessions` returned every one of the caller's live sessions
through `parseSessionOutput`, which filters by the session output schema — and
`token` carries no `returned: false`, so each row arrived with its **raw bearer
token**. Its guard is `freshSessionMiddleware`, whose `freshAge` defaults to a
day, so a session phished minutes ago was fresh enough to ask. One compromised
session therefore yielded durable capture of all of them, and the capture
survived the victim revoking the session they knew about. `parseAccountOutput`
strips its tokens by name one function above; the session path never did.

`POST /api/auth/revoke-session` takes `{ token }` as its only handle, so it was
the consumer of what `list-sessions` leaked and has no legitimate caller once
that path is gone.

Both are now in Better Auth's own `disabledPaths` and answer **404**, listed
with their reasons in the new `SUPPRESSED_AUTH_PATHS` (exported, alongside
`SUPPRESSED_AUTH_PATH_LIST` and the `SuppressedAuthPath` type). `disabledPaths`
is read inside the auth router's `onRequest`, before rate limiting and before
any plugin hook, so unlike a middleware in front of `auth.handler` there is no
mount point or consumer configuration that reaches the endpoint without passing
it.

**`POST /api/auth/revoke-sessions`, `POST /api/auth/revoke-other-sessions`,
`GET /api/auth/get-session` and `POST /api/auth/sign-out` are unchanged.** They
take no token that the caller does not already hold, and they remain the
supported way to end a session — including one the caller must not be able to
name. A consumer that needs per-session revocation exposes its own route taking
an opaque session id and resolving it server-side under the caller's user id.

The suite that holds this asserts the refusal, the absence of every live token
from the response body, that the refused revoke deleted nothing, and — because
a path list cannot say whether its entries name anything — that every suppressed
path is one the built auth instance actually defines, so a library rename
reddens the gate instead of leaving a live route behind a guard that matches
nothing.
