# Story Brief — `S4-02` Tier-0 modules → `defineModule`

> **You are the IC engineer (`cursor` worker, fresh process; clean context).** Branch: `foundation-repair`. **Depends on S4-01.**
>
> **Atomic-commit policy:** ONE commit `[S4-02] tier-0 modules use defineModule`. **Sentinel:** `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s4-02-tier0.done`.

---

## 1. Goal

Convert the 4 leaf modules (no cross-service deps) to `defineModule`: **audit, webhooks, media, organization**. These are tier-0 because they don't depend on any other services; safest place to start the migration.

---

## 1.5 Validation policy

Do NOT run `bun run test`, `bun run check-types`, or `bun run lint`. Manager runs at gate.

---

## 2. Required reading

1. The S4-01 commit — read its diff for `defineModule` API.
2. The four module sources:
   - `packages/core/src/modules/audit/service.ts` + `repository/index.ts` if separate (audit is small).
   - `packages/core/src/modules/webhooks/service.ts` + `repository/index.ts`.
   - `packages/core/src/modules/media/service.ts` + `repository/index.ts`.
   - `packages/core/src/modules/organization/service.ts`.
3. `packages/core/src/runtime/kernel.ts` — see how each is currently instantiated. Note the deps each receives.

---

## 3. Approach

For each of the 4 modules, create a `<module>.module.ts` (or add to an existing `index.ts`) that exports:

```typescript
export const auditModule = defineModule({
  id: "audit",
  schema: () => ({ auditLog }),  // existing pgTable
  service: (deps) => createAuditService(deps.db),
});
```

`dependencies` is omitted for tier-0 (no deps). The `service` factory builds the existing service class from `deps`.

Then update `runtime/kernel.ts` to consume the module shape instead of manually instantiating. **Don't rewrite kernel.ts wholesale this story — that's S4-06.** For now: at the bottom of the existing manual wiring, validate that the module's `service` factory produces an equivalent instance (you can leave a TODO comment that S4-06 will replace).

Actually, simpler approach for S4-02: just **export the module definition** from each module's barrel. Don't wire it into kernel.ts yet. Wiring happens in S4-06 when all modules are defined.

---

## 4. Files to modify

**Create (per module):**
- `packages/core/src/modules/audit/module.ts` — exports `auditModule` via `defineModule`.
- `packages/core/src/modules/webhooks/module.ts`
- `packages/core/src/modules/media/module.ts`
- `packages/core/src/modules/organization/module.ts`

**Modify:**
- Each module's `index.ts` barrel — re-export the module definition.

**Do not touch:**
- The service classes themselves.
- The repositories.
- `runtime/kernel.ts` — S4-06.

---

## 5. Acceptance criteria

1. Four `module.ts` files exist with `defineModule({...})` per spec.
2. Each module's `service` factory closures over the existing service class constructor.
3. Type tests (in `packages/core/test/module-tier0.test.ts`):
   - `auditModule.id === "audit"`.
   - `auditModule.service({...mockDeps})` returns an instance assignable to the existing `AuditService` type.
   - Same for the other 3.
4. No `as any`, no `@ts-ignore`.

---

## 6. DoD

- [ ] All AC met.
- [ ] Atomic commit `[S4-02] tier-0 modules use defineModule`.
- [ ] Sentinel `.handoff/result-s4-02-tier0.done`.

---

## 7. What NOT to do

- Do NOT modify the kernel's manual wiring (S4-06).
- Do NOT change service class signatures.
- Do NOT add `dependencies` arrays — these are tier-0 (none).
