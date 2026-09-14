---
"@porulle/core": minor
---

Carry an optional `dateOfBirth` on the user model.

A storefront selling age-restricted goods needs to know how old the buyer is,
and one selling anything else must not be made to collect it — so the field is
optional, `input: true`, and stored as text in `YYYY-MM-DD` form. Text rather
than a date column so the value a customer typed is the value read back: a
timestamp would silently apply a timezone to a day that has none.

Porulle does not decide what a valid date is or what age is old enough. An app
does that in a `before` hook over `auth.extraAuthPlugins`, where the two
thresholds it needs — refusing an account, and gating a feature within one —
can be different numbers.

The parity guard's maximal option set carries the field too, so removing the
Drizzle column without removing the declaration fails `check:auth-schema`
rather than failing at the first sign-up.
