---
"@porulle/core": minor
---

Give session reads their own rate-limit budget, separate from the credential endpoints.

`GET /api/auth/get-session` previously shared the `/api/auth/*` bucket with sign-in, so an app resolving the session per navigation exhausted a 10-per-minute budget in ten screens. The call then returned 429, and a client treating any non-ok response as "no session" signed the operator out.

Session reads now use `config.rateLimits.session`, defaulting to 120 per minute, and are skipped by the shared limiter so a single request is never counted twice. `rateLimits.auth` and `rateLimits.signInPerEmail` are unchanged — the per-email sign-in limit is the credential control and stays where it is.

Widen or tighten it like any other limit:

```ts
rateLimits: { session: 300 }
```
