# Story Brief — `S4-01` Define `defineModule` type primitives

> **You are the IC engineer (`cursor` worker, fresh process; clean context).** Branch: `foundation-repair`.
>
> **Atomic-commit policy:** ONE commit `[S4-01] defineModule type primitives`. **Sentinel:** `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s4-01-define-module.done`.

---

## 1. Goal

Create the `defineModule` factory + types that subsequent S4-02 through S4-06 stories will use to migrate the 17 services off the `serviceContainer as Record<string, unknown>` antipattern (TD-002). **No services are migrated in this story** — pure type primitives + factory function.

---

## 1.5 Validation policy

Do NOT run `bun run test`, `bun run check-types`, or `bun run lint`. Manager runs at gate.

---

## 2. Required reading

1. `FRAMEWORK-WIKI.md` §9 (Module System API design). The recommended shape:
   ```ts
   interface AppModule<TSchema, TService, TDeps> {
     id: string;
     schema: () => TSchema;
     dependencies?: ReadonlyArray<keyof TDeps>;
     service: (deps: ModuleDeps<TDeps>) => TService;
   }
   ```
2. `packages/core/src/runtime/kernel.ts` — current manual wiring at line 218–346.
3. `packages/core/src/kernel/service-registry.ts` — existing `ServiceRegistry` interface (the unused alternative).

---

## 3. Files to create

**Create:**
- `packages/core/src/kernel/module/define.ts` — exports:
  - `AppModule<TSchema, TService, TDeps>` interface
  - `ModuleDeps<TDeps>` interface (db, hooks, services: TDeps, config, logger)
  - `defineModule<TSchema, TService, TDeps>(manifest: AppModule<...>): AppModule<...>` factory (identity function with type-inference benefits)
  - `ServiceMap<TModules>` mapped type — given a record of `AppModule`s, produce `{ [K in keyof TModules]: TService<TModules[K]> }`
- `packages/core/src/kernel/module/topo-sort.ts` — exports `topoSortModules(modules: Record<string, AppModule>): string[]` returning the instantiation order. Throws on cycles. Used by S4-06.
- `packages/core/src/kernel/module/index.ts` — barrel.

**Modify:**
- `packages/core/src/index.ts` — re-export `defineModule`, `AppModule`, `ModuleDeps`, `ServiceMap` from `kernel/module`.

**Tests:**
- `packages/core/test/define-module.test.ts`:
  - Type test: `defineModule({...})` infers TService correctly.
  - Type test: `ModuleDeps<{ pricing: PricingService }>` exposes `deps.services.pricing` as typed.
  - Topo-sort test: 3 modules with declared deps → correct order; cycle → throws.

**Do not touch:**
- `runtime/kernel.ts` — that's S4-06.
- Any service file — that's S4-02 through S4-05.

---

## 4. Acceptance criteria

1. `defineModule` is the identity factory function. Types do all the work.
2. `AppModule.dependencies` is `ReadonlyArray<keyof TDeps>` — typo on a dep name is a TypeScript error.
3. `topoSortModules` returns a valid linearization OR throws `ModuleCycleError` with the cycle named.
4. Type tests prove the inference shape (use `expectType`/`tsd` patterns or asserts).
5. No `as any`, no `@ts-ignore`.

---

## 5. DoD

- [ ] All AC met.
- [ ] Atomic commit `[S4-01] defineModule type primitives`.
- [ ] Sentinel `.handoff/result-s4-01-define-module.done`.

---

## 6. What NOT to do

- Do NOT migrate any service in this story (S4-02 through S4-05's territory).
- Do NOT introduce decorator metadata. `defineModule` is plain TypeScript.
- Do NOT remove or break `ServiceRegistry` — it stays for now (deprecated alias optional).
