# Story Brief — `S1-04` Inventory repo enforces `organization_id`

> **You are the IC engineer (`cursor` worker, fresh process; clean context).** Branch: `foundation-repair`. **Depends on S1-03 (schema must land first).**
>
> **Atomic-commit policy:** ONE commit `[S1-04] inventory repo enforces organization_id`. **Sentinel:** `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s1-04-inventory-org-enforce.done`.

---

## 1. Goal

Wire `InventoryRepository` writes to populate the new `organization_id` column and reads to filter by it. Make cross-org reads return zero rows by construction.

---

## 1.5 Validation policy

Do NOT run `bun run test`, `bun run check-types`, or `bun run lint`. Manager runs at gate.

---

## 2. Required reading

1. `FRAMEWORK-WIKI-PHASE-2.md` §3 MT-3.
2. The S1-03 commit — read its diff for the column shape.
3. `packages/core/src/modules/inventory/repository/index.ts` — full file. Pay attention to `findLevelByKey`, `findLevelForUpdate`, `createLevel`, `createMovement`, `updateLevel`, `adjustWithLock`, `reserveWithLock`, `releaseWithLock`, `findLevelsByEntityAndVariant` (and any other read methods).
4. `packages/core/src/modules/inventory/service.ts` — to understand which repo methods receive `actor` for resolving org. The service-level convention is `resolveOrgId(actor)` at the call boundary.
5. The MEMORY.md note on null-vs-undefined for variantId — preserve that logic.

---

## 3. Approach (concrete)

**Writes** (`createLevel`, `createMovement`, all `update*`):
- Accept `organizationId` as part of the input shape (NOT NULL, no default). Service callers must compute it via `resolveOrgId(actor)` and pass it explicitly. Update `InventoryService.adjust()`, `reserve()`, `release()`, `pickWarehouse()`, etc., to pass `resolveOrgId(actor)`.

**Reads** (every `findLevel*`, `findLevelsBy*`):
- Add a required `organizationId: string` parameter. Add `eq(table.organizationId, organizationId)` to every `WHERE` clause.
- Service callers add `resolveOrgId(actor)` to their queries.

**Sanity guard** (defensive but cheap):
- For `findLevelByKey` / `findLevelForUpdate`, also assert `level.organizationId === organizationId` post-fetch (would already be true via `WHERE`, but a defensive `if (level.organizationId !== organizationId) throw` is reasonable for a tier-1 isolation primitive).

---

## 4. Files to modify

**Modify:**
- `packages/core/src/modules/inventory/repository/index.ts` — every method's input + WHERE clause.
- `packages/core/src/modules/inventory/service.ts` — every call site that hits the repo. The pattern: `const orgId = resolveOrgId(actor)` at function entry; pass `orgId` to every repo call.

**Create:**
- `packages/core/test/inventory-cross-org-isolation.test.ts` — a focused test:
  - Seed two orgs (A and B) with their own warehouses.
  - Create `inventory_levels` for entity X under org A.
  - As actor for org B, attempt `inventory.adjust({ entityId: X, ... })` — assert it doesn't see A's row (creates a new B row OR errors, depending on entity ownership).
  - As actor for org A, attempt cross-org read by passing org B's warehouse id explicitly — assert it returns zero rows.

**Do not touch:**
- Schema (`schema.ts`) — S1-03's territory.
- Other modules.

---

## 5. Acceptance criteria

1. Every repo write populates `organization_id` from a required input field.
2. Every repo read filters by `organization_id` in the `WHERE` clause.
3. Service callers pass `resolveOrgId(actor)` consistently.
4. Cross-org read test passes (seed A, read as B, see nothing of A's).
5. Existing inventory tests still pass (manager validates at gate; you verify by inspection).
6. No `as any`, no `@ts-ignore`.

---

## 6. DoD

- [ ] All AC met.
- [ ] Atomic commit `[S1-04] inventory repo enforces organization_id`.
- [ ] Sentinel `.handoff/result-s1-04-inventory-org-enforce.done`.

---

## 7. What NOT to do

- Do NOT change the public service signatures of `adjust`/`reserve`/`release` — internal call sites only.
- Do NOT ship a `pgPolicy` row-level-security setup — that's a backlog item (B-05). Code-level enforcement is the deliverable here.
- Do NOT touch other modules' repos (catalog, orders, etc.). Inventory only.
