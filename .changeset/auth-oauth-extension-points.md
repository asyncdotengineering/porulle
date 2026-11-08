---
"@porulle/core": minor
---

Breaking: Add `auth.extraAuthSchema`, `auth.jwt`, and `auth.suppressedAuthPaths` so consumer Better Auth plugins (for example `@better-auth/mcp`) can merge plugin-owned Drizzle tables, forward jwt() options, and suppress extra auth paths without patching core. OAuth provider tables are no longer duplicated in core's auth-schema — generate them with `@better-auth/cli` in the consumer app. Bump better-auth to 1.7.18 and drop `account.issuer` (removed upstream).
