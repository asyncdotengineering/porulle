---
"@porulle/core": patch
---

Give every 401 the `WWW-Authenticate` challenge RFC 9110 §15.5.2 requires

A 401 that names no scheme is advice a generic HTTP client cannot act on. Core
answered 401 from five places — `requirePerm` and `requireAnyPerm`, the plugin
router's inline refusal, the customer portal's own, and a thrown
`CommerceUnauthorizedError` shaped by `mapErrorToResponse` — and none of them
carried a challenge.

All five now unwind through one boundary wrapped around the auth middleware's
body, which is where they already converged; `app.onError` applies the same
helper for the one 401 that cannot reach it. The value is the constant
`Bearer realm="api"` — never `Basic`, which would make a browser render a native
credential prompt over a JSON API, and never a realm carrying the organization
or vendor, which would disclose tenancy to an unauthenticated caller.

A 403 deliberately carries no challenge: §15.5.4 does not ask for one, and
offering it would tell a caller who is already authenticated to authenticate
again. That absence is asserted, not assumed.
