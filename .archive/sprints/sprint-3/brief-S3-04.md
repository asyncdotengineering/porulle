# Story Brief — `S3-04` Wire catalog `beforeRead/afterRead/beforeList/afterList` hooks

> **You are the IC engineer (`cursor` worker, fresh process; clean context).** Branch: `foundation-repair`.
>
> **Atomic-commit policy:** ONE commit `[S3-04] catalog read/list hooks wired`. **Sentinel:** `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s3-04-catalog-hooks.done`.

---

## 1. Goal

`EntityHooks` types declare `beforeRead`, `afterRead`, `beforeList`, `afterList`, but `CatalogServiceImpl` never invokes them. Plugin authors registering these hooks see them silently dropped. Wire them into the catalog service's `getById` and `list` paths.

---

## 1.5 Validation policy

Do NOT run `bun run test`, `bun run check-types`, or `bun run lint`. Manager runs at gate.

---

## 2. Required reading

1. `FRAMEWORK-WIKI-PHASE-2.md` §4.
2. `packages/core/src/config/types.ts` — `EntityHooks` interface (lines ~33-44). Confirms 10 hook events declared.
3. `packages/core/src/modules/catalog/service.ts` — find `getById`, `list` (or whatever the read paths are). Confirm they currently DO NOT call `runBeforeHooks` / `runAfterHooks` for read/list events. Compare to `create`/`update` which do.

---

## 3. Approach

For each of the 4 hooks:

```typescript
// catalog.beforeRead — runs before getById query
async getById(id: string, actor?: Actor | null, ctx?: TxContext): Promise<...> {
  const hookCtx = createHookContext({ ... context: { moduleName: "catalog" } });
  const beforeHooks = this.deps.hooks.resolve(`catalog.${entityType}.beforeRead`);
  await runBeforeHooks(beforeHooks, { id }, "read", hookCtx); // can transform { id }
  // ... existing logic ...
  const afterHooks = this.deps.hooks.resolve(`catalog.${entityType}.afterRead`);
  await runAfterHooks(afterHooks, null, entity, "read", hookCtx);
  return Ok(entity);
}
```

Same pattern for `list` with `beforeList`/`afterList`. Note: the hook key includes `entityType` (e.g., `catalog.product.beforeRead`), matching the existing convention for create/update.

Define typed payload interfaces:
- `BeforeReadInput = { id: string }` 
- `AfterReadInput = SellableEntity` (or whatever the entity type is)
- `BeforeListInput = { filter: ListFilter; limit: number; offset: number; ... }`
- `AfterListInput = { items: SellableEntity[]; total: number }`

Document them in JSDoc on `EntityHooks` so plugin authors know the payload shapes.

---

## 4. Files to modify

**Modify:**
- `packages/core/src/modules/catalog/service.ts` — add hook invocations to `getById` and `list`.
- `packages/core/src/config/types.ts` — JSDoc on `EntityHooks` for read/list payload shapes.

**Create:**
- `packages/core/test/catalog-read-list-hooks.test.ts` — register a `catalog.product.beforeList` hook + a `catalog.product.afterList` hook; perform a list; assert both hooks fire with correct payloads.

---

## 5. Acceptance criteria

1. `getById` invokes `beforeRead` + `afterRead` for the entity type.
2. `list` invokes `beforeList` + `afterList`.
3. Test confirms hooks fire with expected payloads.
4. No `as any`, no `@ts-ignore`.
5. Existing catalog create/update behavior unchanged (verify by inspection).

---

## 6. DoD

- [ ] All AC met.
- [ ] Atomic commit `[S3-04] catalog read/list hooks wired`.
- [ ] Sentinel.

---

## 7. What NOT to do

- Do NOT add similar hooks to other modules (orders, inventory, etc.) — those have their own conventions; out of scope.
- Do NOT change the `EntityHooks` interface shape (4 hook fields already declared; this story uses them).
- Do NOT add hook invocations for `delete` if catalog already has them — verify first.
