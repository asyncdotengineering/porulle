# Story Brief — `S0-04` `compensation_failures` table + repository

> **You are the IC engineer (`cursor` worker, fresh process; clean context).** Branch: `foundation-repair`.
>
> **Atomic-commit policy:** ONE commit `[S0-04] compensation_failures schema + repository`. No push. **Sentinel mandatory:** as the very last action, `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s0-04-compensation-schema.done` (or `STUCK <reason>`). Read `/ship-it` §7 carefully.

---

## 1. Goal

Create a persistent table + repository for compensation-chain failures, so that money-captured-but-order-cancelled scenarios stop disappearing into stdout. **No wiring this story** — that's S0-05. This story is schema + repository + tests only.

---

## 1.5 Validation policy (sprint-wide)

**Do NOT run `bun run test`, `bun run check-types`, or `bun run lint`.** Manager runs the full validation chain in the consolidated review gate at end of Sprint 4. Your DoD: write the code + tests, stage, commit atomically, sentinel.

Fix anything that's obviously broken by inspection (missing import, syntax error). Do not run the full suite. Trust the gate.

---

## 2. Required reading

1. `sprints/sprint-0/PLAN.md` § S0-04.
2. `FRAMEWORK-WIKI-PHASE-2.md` §6 F-1 (root cause).
3. `packages/core/src/kernel/compensation/executor.ts` — full file. Note where the compensation error is currently swallowed (lines 47–52). DO NOT modify this file in S0-04.
4. `packages/core/src/kernel/compensation/types.ts` — `CompensationContext`, `Step` types.
5. `packages/core/src/kernel/database/schema.ts` — schema barrel; you'll add `compensation/schema.js` to it.
6. `packages/core/src/modules/audit/schema.ts` AND `packages/core/src/modules/audit/service.ts` — **the model pattern** for a kernel-level append-only log table. Mirror its column conventions (uuid pk via `randomUUID()`, `text` for org id, jsonb for payload, `timestamp` with default `now()`).
7. `packages/core/src/kernel/result.ts` — `Result<T, CommerceError>`, `Ok()`, `Err()`. All repo methods return `Result<T>`.
8. `packages/core/src/auth/org.ts` — `resolveOrgId()` for the current actor's org.

---

## 3. Files to create

**Create:**
- `packages/core/src/kernel/compensation/schema.ts` — Drizzle pgTable.
- `packages/core/src/kernel/compensation/repository.ts` — `CompensationFailuresRepository` class.
- `packages/core/test/compensation-failures-repository.test.ts` — repo unit tests.

**Modify:**
- `packages/core/src/kernel/database/schema.ts` — add `export * from "../compensation/schema.js";`.

**Do not touch:**
- `packages/core/src/kernel/compensation/executor.ts` (S0-05's territory).
- Routes / controllers (S0-05).
- Any other module.

---

## 4. Schema spec (table `compensation_failures`)

| Column | Type | Notes |
|--------|------|-------|
| `id` | `text("id").primaryKey().$defaultFn(() => randomUUID())` | UUID pk |
| `organizationId` | `text("organization_id").notNull()` | Actor's org at failure time |
| `correlationId` | `text("correlation_id").notNull()` | Free-form linker (order id, request id, job id, etc.) |
| `chainName` | `text("chain_name").notNull()` | e.g., `"checkout"` |
| `stepName` | `text("step_name").notNull()` | The step whose `compensate()` threw |
| `originalError` | `jsonb("original_error").$type<{ message: string; code?: string; details?: unknown }>().notNull()` | The error that triggered compensation |
| `compensationError` | `jsonb("compensation_error").$type<{ message: string; stack?: string; details?: unknown }>().notNull()` | The error compensation itself threw |
| `occurredAt` | `timestamp("occurred_at").notNull().defaultNow()` | |
| `resolvedAt` | `timestamp("resolved_at")` | nullable |
| `resolvedBy` | `text("resolved_by")` | actor.userId of resolver, nullable |
| `resolutionNotes` | `text("resolution_notes")` | nullable |

Indexes:
- `idx_compensation_failures_org_unresolved` on `(organizationId, occurredAt DESC) WHERE resolvedAt IS NULL` — partial index for the common operator query "show me unresolved failures for my org."
- `idx_compensation_failures_correlation` on `(correlationId)` for cross-referencing.

Export shape:
```typescript
export const compensationFailures = pgTable("compensation_failures", { ... }, (table) => ({
  orgUnresolvedIdx: index("idx_compensation_failures_org_unresolved")...,
  correlationIdx: index("idx_compensation_failures_correlation")...,
}));
export type CompensationFailure = typeof compensationFailures.$inferSelect;
export type NewCompensationFailure = typeof compensationFailures.$inferInsert;
```

---

## 5. Repository spec

```typescript
// packages/core/src/kernel/compensation/repository.ts
export interface RecordFailureInput {
  organizationId: string;
  correlationId: string;
  chainName: string;
  stepName: string;
  originalError: { message: string; code?: string; details?: unknown };
  compensationError: { message: string; stack?: string; details?: unknown };
}

export interface ListFailuresInput {
  organizationId: string;
  resolved?: boolean;
  limit?: number;   // default 50, max 200
  offset?: number;  // default 0
}

export interface MarkResolvedInput {
  id: string;
  organizationId: string; // for org guard
  resolvedBy: string;
  notes?: string;
}

export class CompensationFailuresRepository {
  constructor(private db: DrizzleDatabase) {}
  async record(input: RecordFailureInput, ctx?: TxContext): Promise<Result<CompensationFailure>>;
  async list(input: ListFailuresInput, ctx?: TxContext): Promise<Result<{ items: CompensationFailure[]; total: number }>>;
  async getById(id: string, organizationId: string, ctx?: TxContext): Promise<Result<CompensationFailure | null>>;
  async markResolved(input: MarkResolvedInput, ctx?: TxContext): Promise<Result<CompensationFailure>>;
}
```

Patterns to follow (from `modules/audit/service.ts`):
- `getDb(ctx)` helper that returns `ctx?.tx ?? this.db`.
- Drizzle `eq()`, `and()`, `desc()` for queries. **Never pass `null` to `eq()`** — use `isNull(col)` (per MEMORY.md).
- Always scope reads/writes by `organizationId`.
- `markResolved` with org-guard: `WHERE id = ? AND organizationId = ? AND resolvedAt IS NULL` — refuses to double-resolve and refuses cross-org resolution.

---

## 6. Acceptance criteria

1. `compensationFailures` table is exported from the schema barrel and pickable by `drizzle-kit push` (verify via your existing test kernel — `pushSchema` should create it).
2. Indexes (`idx_compensation_failures_org_unresolved`, `idx_compensation_failures_correlation`) exist after push.
3. Repository has all four methods, all return `Result<T>`, all accept optional `ctx?: TxContext`.
4. `markResolved` returns `Err()` (not throws) when the row doesn't exist OR is already resolved OR belongs to a different org.
5. Tests cover: `record()` → row exists; `list({resolved: false})` filters correctly; `list({resolved: true})` shows resolved only; `getById` returns null for foreign-org id; `markResolved` happy path; `markResolved` rejects re-resolve; `markResolved` rejects cross-org.
6. No `as any`, no `@ts-ignore`, no public-surface changes elsewhere.

---

## 7. DoD

- [ ] All AC met (by inspection — manager runs the suite at the gate).
- [ ] No `as any`, no `@ts-ignore`.
- [ ] Atomic commit `[S0-04] compensation_failures schema + repository`.
- [ ] Sentinel `.handoff/result-s0-04-compensation-schema.done` with `DONE <sha>`.

---

## 8. What NOT to do

- Do NOT modify `executor.ts` — that's S0-05.
- Do NOT add admin routes — that's S0-05.
- Do NOT instantiate the repository in `runtime/kernel.ts` — that's S0-05.
- Do NOT use raw SQL migration files. Push via Drizzle.
- Do NOT skip the org-guard in `markResolved` and `getById` — multi-tenancy is sprint-1's territory but S0-04 must not write code that S1 then has to retrofit.

You are the IC. Sincere work only. If `pgSequence` patterns or `randomUUID()` defaults aren't quite right, use whatever the audit module uses today — that's the canonical pattern.
