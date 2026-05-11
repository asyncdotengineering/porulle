# Story Brief — `S2-02` Thread `kernel` through services so `HookContext.db` is non-null

> **You are the IC engineer (`cursor` worker, fresh process; clean context).** Branch: `foundation-repair`.
>
> **Atomic-commit policy:** ONE commit `[S2-02] HookContext.db wired for every service`. **Sentinel:** `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s2-02-hookctx-db.done`.

---

## 1. Goal

Fix LB-3: `HookContext.db` is typed `PluginDb` (non-null) but is `null` for every module except `orders` because only `OrderService` threads `kernel` through `createHookContext`. Plugin authors writing hook handlers against catalog/cart/customers/etc. and doing `await ctx.db.insert(...)` get a runtime crash. The type system actively hides this.

---

## 1.5 Validation policy

Do NOT run `bun run test`, `bun run check-types`, or `bun run lint`. Manager runs at gate.

---

## 2. Required reading

1. `FRAMEWORK-WIKI-PHASE-2.md` §2 LB-3.
2. `packages/core/src/kernel/hooks/types.ts` line ~38 — `db: PluginDb` (typed non-null).
3. `packages/core/src/kernel/hooks/create-context.ts` — `createHookContext`: `db: args.db ?? args.kernel?.database?.db ?? null` (cast to `PluginDb` even when null — the lying cast).
4. `packages/core/src/modules/orders/service.ts` — **the model**: receives `kernel` in deps, threads it through to `createHookContext`.
5. `packages/core/src/runtime/kernel.ts` — where services are instantiated. Look at `OrderService` instantiation: `kernel: { database: { db: ... } }`. Other services don't get this.
6. The 16 services missing `kernel`:
   - catalog, inventory, cart, customers, payments, fulfillment, pricing, promotions, tax, shipping, search, media, analytics, webhooks, audit, organization

---

## 3. Approach (concrete)

The structural fix:
- Every `*ServiceDeps` interface gets an optional `kernel?: { database: { db: PluginDb } }` field (for backwards compat) OR a required one (cleaner).
- Every service that calls `createHookContext` passes `kernel: this.deps.kernel` (or `{ database: this.deps.database }` if `database` is already on deps).
- `kernel.ts` instantiation passes the kernel reference (or just `database`) when constructing each service.

**Recommended (cleaner):** since `database` already lives on `Kernel`, and many service deps already accept `database`, the simplest move is:
- Modify `createHookContext` to accept `database?: { db: PluginDb }` directly (in addition to or instead of the `kernel` shape).
- Each service passes `database: this.deps.database` to `createHookContext`.
- Services that don't have `database` in their deps yet: add it.

This avoids leaking the `Kernel` type into service signatures.

---

## 4. Files to modify

**Modify:**
- `packages/core/src/kernel/hooks/create-context.ts` — accept `database?: { db: PluginDb }` arg; resolve `db` from it. Keep the `kernel` arg as a deprecated alias for one release.
- `packages/core/src/kernel/hooks/types.ts` — keep `db: PluginDb` as the type (post-fix it's truly non-null in practice). Add a JSDoc note.
- For each of the 16 services: add `database` (or `kernel`) to the `*Deps` interface if absent. Pass it to every `createHookContext({ ... })` call.
- `packages/core/src/runtime/kernel.ts` — at each service instantiation, pass `database: database` (or already-existing `database` field; verify by reading kernel.ts in full).

**Create:**
- `packages/core/test/hooks-db-non-null.test.ts` — for each of the 6 modules from S2-01 (catalog, cart, customers, pricing, promotions, fulfillment) plus orders/inventory: register an after-hook that calls `await ctx.db.execute(sql\`SELECT 1\`)` and assert it does not throw. Catches the null-crash regression.

**Do not touch:**
- Plugin source (`packages/plugins/`).
- The `PluginDb` type definition.

---

## 5. Acceptance criteria

1. Every of the 17 services that calls `createHookContext` passes `database` (or `kernel`).
2. `HookContext.db` is non-null in tests for every module.
3. The "lying cast" `db as PluginDb` (when null) is replaced with non-null in normal paths; if a fallback null is genuinely needed (e.g., test env without a kernel), the type becomes `PluginDb | null` and the cast is removed.
4. New test `hooks-db-non-null.test.ts` passes with the new wiring.
5. No `as any`, no `@ts-ignore`. The fix should make types HONEST — either truly non-null or properly nullable.

---

## 6. DoD

- [ ] All AC met.
- [ ] Atomic commit `[S2-02] HookContext.db wired for every service`.
- [ ] Sentinel `.handoff/result-s2-02-hookctx-db.done`.

---

## 7. What NOT to do

- Do NOT preserve the lying cast (`db as PluginDb` when null). Pick: type as nullable OR enforce non-null at the wiring layer.
- Do NOT touch service public method signatures.
- Do NOT introduce AsyncLocalStorage (S1-05's territory; different concern).

This is the largest Sprint 2 story by diff size (17 services). Read `kernel.ts` carefully before modifying — there are many service constructors. Take it module by module.
