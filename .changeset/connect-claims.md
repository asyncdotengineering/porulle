---
"@porulle/plugin-channel-connector": minor
---

Breaking: connect claims, and services for the after-connect hook.

- New `connectClaims(context)` option: resolved from the request that STARTS a connection (OAuth start or `POST /api/channels/stores`) — e.g. which of the user's vendors the store is for — and signed into the OAuth state. `StoreConnectActor.claims` carries it to `bindConnectedStore`, so the OAuth callback, which has no session or headers, binds the store to exactly what was chosen at the start. A claims refusal lands the browser on `postConnectRedirect?connect_error=CONNECT_REFUSED`.
- `afterStoreConnected` receives `services` (the kernel services, including `jobs`) so a consumer can start the first import.

Migration: `StoreConnectActor` gains a required `claims`; `OAuthStatePayload` gains `claims`.
