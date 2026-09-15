---
"@porulle/core": patch
---

Let a plugin declare that a hook must run inside the writing transaction.

0.35.0 made after-commit the default for every after-hook, which is right for
anything with an external effect, and gave core's own outbox writers an opt-in
through `appendInTransaction`. It gave plugins nothing. `PluginHookRegistration`
was `{ key, handler }`, and `manifest.hooks()` is flattened into a bare
`key -> handler[]` map before any registry exists, so a plugin had no channel to
say otherwise and every plugin hook became after-commit.

That silently moved a transactional outbox. A hook whose whole purpose is to
write a row that commits or rolls back *with* the write it records was left
writing it after the commit instead — narrow, because the drain is awaited
inside the same invocation, but a real weakening of an invariant the consumer
depends on.

`PluginHookRegistration` now takes `inTransaction?: boolean`. The manifest marks
the handler function itself, which is the only channel that survives the
flattening, and the kernel reads the mark back at boot and registers those
through `appendInTransaction`.

Set it only for an outbox writer. A webhook, a search-index write or an email
must stay after-commit — none of them may announce a write that can still roll
back, which is what 0.35.0 exists to prevent.
