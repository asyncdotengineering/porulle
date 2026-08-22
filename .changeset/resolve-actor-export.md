---
"@porulle/core": minor
---

Export `resolveActor`, so code outside the request pipeline can resolve a porulle `Actor` from request headers.

Going from a better-auth session to an `Actor` — organization resolved, permissions resolved — was reachable only from inside `authMiddleware`. A server function, a script, or a job had to re-derive it by hand.

That mapping is now `auth/actor.ts` and is exported. `authMiddleware` calls the same function, so the two paths cannot drift:

```ts
import { resolveActor } from "@porulle/core";

const actor = await resolveActor(request.headers, auth, config);
if (!actor) return redirectToSignIn();
```

Returns `null` for an absent, malformed or expired session rather than throwing — "signed out" is an ordinary answer. `AUTH_COOKIE_PREFIX` and `SESSION_COOKIE_NAME` are exported alongside it for consumers managing the cookie themselves.

Note that resolving a *session* needs no porulle helper: better-auth already provides `auth.api.getSession({ headers })` in-process and `createAuthClient` from `better-auth/client` for a separate frontend. The documentation now points at both.
