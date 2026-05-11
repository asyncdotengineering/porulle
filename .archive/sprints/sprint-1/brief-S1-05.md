# Story Brief — `S1-05` Scoped plugin DB by default

> **You are the IC engineer (`cursor` worker, fresh process; clean context).** Branch: `foundation-repair`.
>
> **Atomic-commit policy:** ONE commit `[S1-05] PluginContext.database scoped by default`. **Sentinel:** `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s1-05-scoped-plugin-db.done`.

---

## 1. Goal

Make `PluginContext.database.db` deliver a scoped Drizzle proxy by default (auto-injecting `organizationId` into queries on org-scoped tables) and expose `database.unscoped` as the explicit escape hatch with a deprecation log on use (MT-4).

---

## 1.5 Validation policy

Do NOT run `bun run test`, `bun run check-types`, or `bun run lint`. Manager runs at gate.

---

## 2. Required reading

1. `FRAMEWORK-WIKI-PHASE-2.md` §3 MT-4.
2. `packages/core/src/kernel/database/scoped-db.ts` — **already exists**. Read it in full. Understand the scoping semantics it implements (`createScopedDb()` likely takes a `db` + `organizationId` and returns a Proxy that filters/auto-stamps).
3. `packages/core/src/kernel/plugin/manifest.ts` — full file. The current shape: `PluginContext.database.db: PluginDb` (raw handle). The function that builds the context is `defineCommercePlugin` itself — find where the `database.db` is set when building `routes(ctx)` and `mcpTools(ctx)`.
4. `packages/core/src/runtime/kernel.ts:226` — `serviceContainer.database = database` exposes the raw adapter. We're not changing that; we're changing how `PluginContext.database.db` is constructed for plugin routes/tools.
5. One existing plugin's route: `packages/plugins/plugin-gift-cards/src/index.ts` — see how it uses `ctx.database.db` and whether it currently does cross-org reads or would break under scoping.

---

## 3. Approach (concrete)

The plugin context is built per-route per-request (Hono context exists). The scoped proxy needs an actor — and that actor lives in `c.var.actor` (Hono context). So the wiring is:

```typescript
// In manifest.ts, where routes are registered:
const route = config.routes; // existing
return (app, kernel) => {
  // ... existing route registration ...
  // Each route's handler receives Hono ctx with actor.
  // When the route handler calls into ctx.database.db, we want the proxy
  // to be lazy-bound to the request's actor.
  
  // The cleanest path: change PluginContext to compute db at handler-call time:
  //   database: {
  //     db: createScopedDb(rawDb, c.var.actor.organizationId),
  //     unscoped: rawDb,
  //     transaction: ...
  //   }
  // But PluginContext is built once at boot; the actor is per-request.
  //
  // Two designs:
  //   A) Make `database.db` a Proxy/getter that resolves actor from a
  //      per-request AsyncLocalStorage context.
  //   B) Plumb an `c.var.actor`-aware factory through to plugin routes.
  //
  // Pick B unless A is already used in the project (search for 
  // AsyncLocalStorage). B is simpler and more explicit.
```

**Recommended (B):** modify the route registration so plugins receive `database.scopedFor(actor)` and `database.unscoped`. The `db` accessor itself becomes deprecated. Plugin routes that need scoped writes call `ctx.database.scopedFor(c.var.actor).insert(...)`.

**Alternative (simpler if scoped-db is already actor-aware):** keep `database.db` but make it the scoped-by-actor proxy via `createScopedDb()` invocation that pulls from request context. Add `database.unscoped` as the raw handle. This requires a small AsyncLocalStorage or Hono `c.var` plumbing.

**Manager guidance:** read `scoped-db.ts` first to see what API it exposes. Pick the design that fits its existing shape. Document the choice in the commit body. If the answer is genuinely ambiguous, `STUCK` with a 3-line summary of the design choice and let manager decide.

---

## 4. Files to modify

**Modify:**
- `packages/core/src/kernel/plugin/manifest.ts` — `PluginContext` shape; route registration plumbing.
- `packages/core/src/kernel/database/scoped-db.ts` — extend if needed.

**Create:**
- `packages/core/test/plugin-scoped-db.test.ts` — test:
  - Plugin route reads `ctx.database.db` (scoped) — sees only its actor's org rows.
  - Plugin route reads `ctx.database.unscoped` — sees all rows + emits a deprecation log line.
- `packages/core/test/test-utils/scoped-db-test-helpers.ts` if needed.

**Do not touch:**
- Existing plugins (no plugin code changes in this story; the scoped-by-default is opt-out via `unscoped` for legitimate cases).
- The kernel's `serviceContainer.database` — that stays as the raw adapter (used by core service container for repo construction).

---

## 5. Acceptance criteria

1. `PluginContext.database.db` returns the scoped Drizzle handle for the request's actor.
2. `PluginContext.database.unscoped` returns the raw handle and logs a deprecation warning on every access (rate-limited to once per N requests if cheap).
3. Tests cover both scoped (sees only own org) and unscoped (sees all + warning) paths.
4. No existing plugin tests break in obvious ways (verify by inspection — `git grep "ctx.database.db"` in `packages/plugins/`).
5. No `as any`, no `@ts-ignore`.

---

## 6. DoD

- [ ] All AC met.
- [ ] Atomic commit `[S1-05] PluginContext.database scoped by default`.
- [ ] Sentinel `.handoff/result-s1-05-scoped-plugin-db.done`.

---

## 7. What NOT to do

- Do NOT modify any plugin's source. Plugins that need unscoped access will adapt in a future sprint.
- Do NOT add `pgPolicy` RLS — backlog (B-05).
- Do NOT change the public adapter contract (`DatabaseAdapter`).
