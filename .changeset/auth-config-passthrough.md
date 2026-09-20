---
"@porulle/core": minor
---

Forward the Better Auth options core was dropping, and stop the next one from being dropped silently.

`createAuth` built its `emailAndPassword` block from a fixed list of four keys, so 9 of Better Auth 1.7.1's 14 options never reached the library. A consumer could set `revokeSessionsOnPasswordReset: true`, typecheck clean, read it back as a security decision, and have nothing happen.

Two additions to `AuthConfig`:

- `password` — a curated block (`minLength`, `maxLength`, `disableSignUp`, `autoSignIn`, `revokeSessionsOnPasswordReset`, `resetTokenExpiresIn`, `onPasswordReset`), forwarded into `emailAndPassword`. Curated rather than pass-through because core owns that block: it injects `sendResetPassword` and `sendVerificationEmail` from `config.email`, which a wholesale override would lose.
- `extend` — every other upstream option, typed `Omit<BetterAuthOptions, …>` over the keys core builds, and spread FIRST so a core-owned key can never be clobbered. Reaching for an owned key here is a compile error naming it, rather than a value that is accepted and ignored.

**Behaviour change:** `revokeSessionsOnPasswordReset` now defaults to **true**, against Better Auth's own `false`. A password reset is the canonical "I think I am compromised" action and leaving other sessions live through it is the wrong default for a commerce platform. Opt out with `auth.password.revokeSessionsOnPasswordReset: false`.

Unconfigured options are omitted rather than sent as `undefined`, so Better Auth's own defaults still apply.
