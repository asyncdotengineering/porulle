# Story Brief — `S2-06` Stale-job reaper

> **You are the IC engineer (`cursor` worker, fresh process; clean context).** Branch: `foundation-repair`.
>
> **Atomic-commit policy:** ONE commit `[S2-06] stale-job reaper`. **Sentinel:** `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s2-06-stale-reaper.done`.

---

## 1. Goal

Fix F-6: jobs stuck in `processing` state (because a lambda timed out mid-handler) sit there forever. No heartbeat, no reaper, no visibility timeout. Add a scheduled task that re-enqueues `processing` jobs older than a configurable threshold.

---

## 1.5 Validation policy

Do NOT run `bun run test`, `bun run check-types`, or `bun run lint`. Manager runs at gate.

---

## 2. Required reading

1. `FRAMEWORK-WIKI-PHASE-2.md` §6 F-6.
2. `packages/core/src/kernel/jobs/runner.ts` — the runner. Specifically the claim phase (sets `status='processing'`, `processingStartedAt=NOW()`) vs the execute phase. A row stuck in `processing` means the worker died between these phases.
3. `packages/core/src/kernel/jobs/schema.ts` — `commerce_jobs` table. Confirm `processing_started_at` column exists.
4. `packages/core/src/kernel/jobs/types.ts` — `TaskDefinition` shape.
5. Other built-in tasks for the convention: `packages/core/src/modules/webhooks/tasks.ts`, `packages/core/src/modules/orders/stale-order-cleanup.ts` (mirrors a scheduled task pattern).

---

## 3. Approach

New task: `jobs/reap-stale`. Schedule: every 60 seconds (or configurable via env `JOBS_REAPER_INTERVAL_MS`).

Logic:
```sql
UPDATE commerce_jobs
SET status = 'pending',
    processing_started_at = NULL,
    attempts = attempts - 1  -- so we don't burn through retry budget on reaper bumps
WHERE status = 'processing'
  AND processing_started_at < NOW() - INTERVAL '<threshold> minutes'
RETURNING id, task_slug, attempts;
```

Default threshold: 5 minutes. Configurable via env `JOB_REAP_THRESHOLD_MS` (default 300000).

Race safety:
- The runner's claim uses `FOR UPDATE SKIP LOCKED` which is atomic.
- The reaper's UPDATE with `WHERE status = 'processing'` is also atomic; if a worker is mid-write committing `succeeded` simultaneously, one of:
  - Worker wins → row goes from `processing` → `succeeded`; reaper's WHERE no longer matches; no-op.
  - Reaper wins → row goes from `processing` → `pending`; worker's later UPDATE WHERE id=? AND status='processing' fails; worker logs warning.
- This is acceptable: at-most-once becomes at-least-once on borderline cases. Document in commit body.

Log every reaped job: `id`, `task_slug`, `processing_started_at`, attempts decremented to.

---

## 4. Files to create

**Create:**
- `packages/core/src/kernel/jobs/reaper.ts` — exports `staleJobReaperTask: TaskDefinition` and a cleanup-runner helper `runStaleJobReaper(db, thresholdMs)`.
- `packages/core/test/jobs-reaper.test.ts`:
  - Insert a row with `status='processing'` and `processing_started_at = NOW() - 10 minutes`.
  - Run the reaper.
  - Assert: row's status is now `pending`, `attempts` decremented by 1.
  - Insert a row with `status='processing'` and `processing_started_at = NOW() - 1 minute`.
  - Run the reaper.
  - Assert: row UNCHANGED (within threshold).

**Modify:**
- `packages/core/src/kernel/jobs/types.ts` — add a section in the canonical task list (or wherever built-in tasks are exposed) that registers `staleJobReaperTask`.
- `packages/core/src/runtime/kernel.ts` (or wherever built-in tasks are auto-registered) — ensure the reaper task is in the default task list so any deployment running the job runner gets it.

**Do not touch:**
- `commerce_jobs` schema columns (no new columns needed).
- The runner's claim/execute logic.
- Other tasks.

---

## 5. Acceptance criteria

1. `staleJobReaperTask` exists, slug `jobs/reap-stale`, schedule every 60s.
2. Threshold configurable via env `JOB_REAP_THRESHOLD_MS` (default 300000 = 5 min).
3. Reaper UPDATE atomic; race-safe with concurrent runner UPDATE.
4. Test covers reaped + not-reaped rows.
5. Logging covers each reaped job.
6. No `as any`, no `@ts-ignore`.

---

## 6. DoD

- [ ] All AC met.
- [ ] Atomic commit `[S2-06] stale-job reaper`.
- [ ] Sentinel `.handoff/result-s2-06-stale-reaper.done`.

---

## 7. What NOT to do

- Do NOT add a heartbeat column (`processing_heartbeat_at`) — that's a separate refactor; threshold-based reap is sufficient.
- Do NOT make the reaper threshold configurable per-task. Global threshold is fine for now.
- Do NOT delete reaped rows; just bounce them back to `pending`.
- Do NOT mask the at-least-once semantic — document in commit body.
