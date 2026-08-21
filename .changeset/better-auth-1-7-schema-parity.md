---
"@porulle/core": patch
---

Declare every column better-auth 1.7 writes, and make the parity guard actually derive its scope from better-auth instead of a hand-written list.

An adopter reported that email/password sign-up returns 500 on a clean install against better-auth 1.7. `account.issuer` was fixed in the previous release. The next call then failed the same way on `jwks.alg`, which was still missing — better-auth validates its field map against the Drizzle schema object and throws before reaching the database, so the auth route is non-functional rather than degraded.

`jwks` gains `alg` and `crv`. The `jwt` plugin is enabled unconditionally, so this affected every deployment. `user` gains `twoFactorEnabled`, `phoneNumber` and `phoneNumberVerified`, and the `twoFactor` table is declared; those plugins are config-gated, so the columns were latent until a merchant enabled two-factor or phone auth. Deployments using the example migrations should apply `0003_add-better-auth-1-7-columns.sql`; every statement is idempotent.

**The guard is the real fix.** `auth-schema-guard.ts` existed to stop exactly this, and missed it twice. It passed `plugins: []` under a comment claiming it mirrored the plugins `createAuth` enables, so `getAuthTables()` never reported a single plugin-contributed table. It then walked a hand-maintained list of four model names — the four whose columns had already been repaired. It now passes the maximal plugin set and iterates every model better-auth reports, resolving Drizzle tables by their declared model name. A column added by any enabled plugin now fails the build.
