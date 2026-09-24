---
"@porulle/core": patch
---

The customer profile Porulle creates lazily now carries the shopper's email.

`CustomerService.getByUserId` creates a profile on first access (the customer portal's profile route, checkout). Until now it wrote only the organization and user id, so almost every new shopper's profile had no email. Email is the key channel redaction uses, so such an account couldn't be erased once its orders had been exported.

- A new profile copies the auth user's email.
- An existing email-less profile is filled on its next access. A non-null email is never overwritten.
- If another profile in the organization already holds that email (`customers` is unique on organization + email), the email is left unset rather than failing the profile read.

Existing email-less profiles that aren't accessed again need a one-off backfill; the consumer ships its own script.
