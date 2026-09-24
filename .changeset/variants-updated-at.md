---
"@porulle/core": minor
"@porulle/plugin-channel-connector": minor
---

Variants get an `updated_at`, so a variant-only change leaves a trace a consumer can version from.

**Schema change:** `variants.updated_at timestamptz NOT NULL DEFAULT now()`. Existing rows take the migration time.

Before this, a change to only a variant (its option values) moved neither the entity row nor any timestamp. A consumer versioning a product from its timestamps saw an unchanged version and dropped the change as stale.

`updated_at` is bumped on every write to a variant or its option values, in the same transaction as the write:
- variant insert (default), and `updateVariant`
- option-value create and delete (single variant or whole entity)
- the channel converge's option-value rewrite on an existing variant

A reconcile that changes nothing leaves it untouched.
