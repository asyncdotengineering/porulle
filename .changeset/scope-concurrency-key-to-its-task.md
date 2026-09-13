---
"@porulle/core": minor
---

Scope a job's concurrency key to its task, so two tasks can share an entity id without sharing an exclusive slot.

> **This is a breaking change shipping as a minor, deliberately.** `@porulle/*` is pre-1.0, and
> semver reserves 0.x for exactly this: "Major version zero is for initial development. Anything
> MAY change at any time. The public API SHOULD NOT be considered stable." The break is documented
> below and every caller is migrated in the same cycle.

**Breaking: a concurrency key no longer excludes across task slugs.** Two jobs of different tasks
that carry the same `concurrencyKey` may now be claimed and run in the same cycle, and one task's
in-flight job no longer blocks another task's job on that key.

The two halves of this feature disagreed. `enqueue`'s `supersedes` has always deleted pending jobs
matching `(organizationId, taskSlug, concurrencyKey)` — scoped by task, so one task could never
supersede another's work. The claim path compared the key **alone**, in two places: the per-cycle
exclusive slot (`oldestByKey`) and the set of keys already `processing`, the latter selected across
every row in the table with no filter on task at all. So "concurrency key" meant per-task when
superseding and global when claiming.

What that cost, measured downstream on 2026-09-13: a catalog projection and a Shopify image push,
different plugins, each keyed on the entity id it is about because that is the resource each one
concerns. Four runnable jobs in a drain of ten returned `{ processed: 2, failed: 0 }` — the two
pushes released back to `pending` at `attempts: 0`, never claimed, never failed, never retried.
With one drain per tick they never ran at all, and the symptom surfaced in the Shopify feature,
three layers from its cause, reading as a broken push. Nothing warned, because nothing was wrong
with either task.

*To migrate:* if you relied on cross-task exclusion — deliberately giving two different tasks the
same `concurrencyKey` so they could not run together — that no longer holds, and the two will now
overlap. Serialize them explicitly instead: give the second task a `waitUntil` set by the first, or
merge them into one task with one key. Same-task exclusion is unchanged: two jobs of one slug
sharing a key still run one per cycle, oldest first, with the rest released back to `pending`.
