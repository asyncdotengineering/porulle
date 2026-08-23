---
"@porulle/core": minor
---

Stop reporting a failed auth check as a rejected credential.

`authMiddleware` wrapped `getSession` and `verifyApiKey` in bare catches and
fell through to anonymous. A credential better-auth rejected and a check that
could not run were both answered `401 "Authentication required."` and logged
nowhere, so a fault in the auth stack presented as the caller's credential
being wrong.

A rejection (`APIError`, matched structurally so it survives two better-auth
copies in one tree) still falls through to anonymous, unchanged. Anything else
is logged at `error` with the stage, path, and method, then propagates as a 500.

If a route starts returning 500 after this upgrade, it was already broken — the
log line names the fault. See `docs/migration-0.15-to-0.16.md`.
