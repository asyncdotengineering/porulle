# Story Brief — Phase B Fix-Pass: Typecheck

> **You are the IC engineer (`cursor` worker, fresh process; clean context).** Branch: `foundation-repair`.
>
> **Atomic-commit policy:** ONE commit `[fix-pass] Phase B typecheck — 32 errors`. **Sentinel:** `echo "DONE $(git rev-parse HEAD)" > .handoff/result-fix-typecheck.done`.

---

## 1. Goal

Resolve all 32 TypeScript errors surfaced by `bun run check-types` after Phase A landed. **Surgical fixes only — do not refactor, do not introduce new abstractions.**

The full error log is at `sprints/phase-b/artifacts/check-types.txt` — 175 lines. Read it first.

---

## 1.5 Validation policy

You **may** run `bun run check-types` (focused on `packages/core`) iteratively to verify your fixes. Do NOT run the full test suite or lint — that's a separate fix-pass.

---

## 2. Required reading

1. `sprints/phase-b/artifacts/check-types.txt` — full error log.
2. The 5 affected files (read each in full):
   - `packages/core/src/modules/fulfillment/service.ts` — **biggest single source: 14 errors** (duplicate `FulfillmentRecord` identifier + cascading type-widening in strategy classes).
   - `packages/core/src/interfaces/rest/routes/admin/compensation-failures.ts` — 3 errors (Hono handler return-type union + exactOptionalPropertyTypes on `resolved` and `notes`).
   - `packages/core/src/config/define-config.ts` line 72 — 1 error (jobs config exactOptionalPropertyTypes).
   - `packages/core/src/kernel/jobs/builtin-job-tasks.ts` line 6 — 1 error (TaskDefinition variance).
   - `packages/core/src/interfaces/rest/customer-portal.ts` line 163 — 1 error (`lineItems` missing on entity type).
   - `packages/core/test/webhooks-single-retry.test.ts` lines 44, 72 — 2 errors (Map TaskDefinition variance).

---

## 3. Categories + suggested fixes (manager analysis)

### Category A — `fulfillment/service.ts` duplicate identifier + strategy return-type mismatch (14 errors)

**Root cause:** `FulfillmentRecord` is declared twice — once on line 14 (as an import) and once on line 18 (as a local type alias). All 4 fulfillment strategies (`PhysicalFulfillmentStrategy`, `DigitalDownloadFulfillmentStrategy`, `DigitalAccessFulfillmentStrategy`, `ShipmentFulfillmentStrategy`) declare their `fulfill()` to return `Promise<Result<FulfillmentRecord>>` per the base class — but they actually return inline literal types (e.g., `{ id, orderId, type, status, lineItems: [...] }`) that don't have all the fields of the actual `fulfillment_records` table row (`createdAt`, `updatedAt`, `metadata`, etc.).

**Suggested fix:**
1. Remove the duplicate declaration (decide which one to keep — likely the import is correct; the local alias was meant as a different intermediate type).
2. The strategies return a **summary record** of the fulfillment, not the DB row. Either:
   - (a) Define a `FulfillmentStrategyResult` type with the fields the strategies actually produce (`id`, `orderId`, `type`, `status`, `lineItems`, `downloadUrl?`, etc.) and have `FulfillmentStrategy.fulfill` return `Promise<Result<FulfillmentStrategyResult>>`. Mappers convert to `FulfillmentRecord` when persisting.
   - (b) Have strategies hydrate with the full DB shape (use placeholders / empty values for `createdAt`/`updatedAt`/`metadata`).
3. Pick (a) — it's more honest. Strategies aren't producing DB rows; they're producing fulfillment events. Document the rename in the commit body.

### Category B — `compensation-failures.ts` admin route (3 errors)

- Line 70 / 144: Hono handler return-type union. The `resolve` handler returns either `c.json({ error })` (404/409/403) or `c.json({ failure })` (200). This is the same OpenAPI-handler-union issue that has 73 `@ts-expect-error` suppressions across the codebase. Resolve by either: (i) adding a `@ts-expect-error -- openapi handler union return type` comment matching the existing convention; OR (ii) tightening the return so all paths produce the same shape (return `c.json({ error: { code, message } }, status)` for everything except success).
- Line 95: `resolved: boolean | undefined` — input has `?: boolean`. Pass via spread: `...(parsed.resolved !== undefined && { resolved: parsed.resolved })`. Or change the repo's `ListFailuresInput.resolved` type to `boolean | undefined` (match the actual semantics).
- Line 144: same pattern for `notes: string | undefined`. Same conditional-spread fix.

### Category C — `define-config.ts` jobs (1 error)

Line 72: jobs default merge causes exactOptionalPropertyTypes strictness fail. Likely fix: change `jobs: input.jobs ?? defaults.jobs` to `...(input.jobs && { jobs: input.jobs })` conditional spread. Match the pattern used elsewhere in `define-config.ts`.

### Category D — `builtin-job-tasks.ts` TaskDefinition variance (1 error)

Line 6: `webhookDeliveryTask` is typed `TaskDefinition<{specific webhook input}, ...>` but registered into a `TaskDefinition<Record<string, unknown>, ...>` map. TaskDefinition is invariant in its input. Fix:
- Cast at the boundary: `webhookDeliveryTask as TaskDefinition<Record<string, unknown>, Record<string, unknown>>` — narrow `as`, justify in commit body.
- OR: Define a helper that erases the input type for the registry (`asGenericTask(t: TaskDefinition<I, O>): TaskDefinition<Record<string, unknown>, Record<string, unknown>>`).

Pick the cast approach — minimal diff.

### Category E — `customer-portal.ts:163` `lineItems` missing (1 error)

Line 163 reads `entity.lineItems` but the entity type (probably an order or fulfillment) doesn't have it. This was likely a previously-working access that broke when Sprint 2's hook context refactor narrowed types. Read the surrounding 30 lines, identify what the variable actually is, and either:
- Use `(entity as OrderWithLineItems).lineItems` — cast cast.
- OR: Hydrate the line items via a separate query.
- OR: The line was checking optional behavior; gate it with `if ("lineItems" in entity)`.

Pick the least invasive fix. Surface in commit body.

### Category F — `webhooks-single-retry.test.ts` Map variance (2 errors)

Lines 44, 72: same TaskDefinition variance issue as Category D. Same cast-at-boundary fix.

---

## 4. Files you may modify

- `packages/core/src/modules/fulfillment/service.ts`
- `packages/core/src/interfaces/rest/routes/admin/compensation-failures.ts`
- `packages/core/src/config/define-config.ts`
- `packages/core/src/kernel/jobs/builtin-job-tasks.ts`
- `packages/core/src/interfaces/rest/customer-portal.ts`
- `packages/core/test/webhooks-single-retry.test.ts`
- `packages/core/src/kernel/compensation/repository.ts` IF you change `ListFailuresInput`/`MarkResolvedInput` to accept `undefined`.

**Do not touch:**
- Anything outside the above list.
- Schema files.
- Service classes besides fulfillment.
- Sprint module.ts files.

---

## 5. Acceptance criteria

1. `bun run check-types` (in `packages/core` OR at repo root) produces ZERO TS errors.
2. No `as any`, no `@ts-ignore`. The narrow casts (Category D, F) are acceptable; document them in commit body.
3. The `@ts-expect-error -- openapi handler union return type` comments are acceptable in route handlers (they match existing convention, 73+ occurrences).
4. No source-of-truth changes (no schema, no service method signatures changed).
5. The `FulfillmentRecord` rename / disambiguation is documented in the commit body.

---

## 6. DoD

- [ ] All AC met.
- [ ] `bun run check-types --filter @unifiedcommerce/core` (or equivalent) green.
- [ ] Atomic commit `[fix-pass] Phase B typecheck — 32 errors`.
- [ ] Sentinel `.handoff/result-fix-typecheck.done`.

---

## 7. What NOT to do

- Do NOT refactor the fulfillment strategy hierarchy beyond renaming a type.
- Do NOT add new abstractions or helpers beyond what the manager analysis suggests.
- Do NOT modify schemas.
- Do NOT silence errors with `as any` or `@ts-ignore`. Use narrow casts where the boundary is honest.
