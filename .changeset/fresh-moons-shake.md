---
"@porulle/core": patch
---

**Behaviour change, shipped as a patch because it is a defect in what the session already promised.** Sign-out now invalidates on the very next request.

`session.cookieCache` was enabled with a five-minute `maxAge`, which made the signed `uc.session_data` cookie a second source of truth for session liveness. A revoked session therefore kept authorizing every route that resolves an actor, and kept `get-session` answering with the user, for up to five minutes after sign-out. The cache is removed: liveness is read from the session table, which is the only place a session is revoked.

**What a consumer loses:** the cached read. Every request that resolves an actor now performs one indexed read of the session table, as does `get-session`. For scale, the cached baseline on a deployed Cloudflare Worker over Hyperdrive → Neon was `get-session` p50 134 ms / p95 157 ms (n = 20, warm), on a route whose cost is dominated by the round trip rather than by the read this adds. There is no configuration option to restore the cache; if one is added, `resolveActor` must pass `query.disableCookieCache` so authorization keeps reading the table.
