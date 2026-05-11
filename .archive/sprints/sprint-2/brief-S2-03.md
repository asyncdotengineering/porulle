# Story Brief — `S2-03` Remove webhook double-retry (3×5=15)

> **You are the IC engineer (`cursor` worker, fresh process; clean context).** Branch: `foundation-repair`.
>
> **Atomic-commit policy:** ONE commit `[S2-03] webhook delivery uses single retry strategy`. **Sentinel:** `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s2-03-webhook-retry.done`.

---

## 1. Goal

Fix LB-5: webhook delivery does 3 inner retries × 5 outer job retries = up to 15 attempts back-to-back with no sleep between the inner three. Receivers see 15 rapid duplicates. Pick one strategy.

---

## 1.5 Validation policy

Do NOT run `bun run test`, `bun run check-types`, or `bun run lint`. Manager runs at gate.

---

## 2. Required reading

1. `FRAMEWORK-WIKI-PHASE-2.md` §2 LB-5.
2. `packages/core/src/modules/webhooks/worker.ts` — full file. The inner `while (attempt < maxAttempts)` loop with `maxAttempts = 3`.
3. `packages/core/src/modules/webhooks/tasks.ts` — `webhookDeliveryTask` with `retries: { attempts: 5, backoff: { type: "exponential", delay: 2000 } }`.
4. `packages/core/src/kernel/jobs/runner.ts` — to understand how the job runner invokes retries with backoff.
5. `packages/core/src/modules/webhooks/repository/index.ts` — `createDelivery` semantics (what state we want recorded for each attempt).

---

## 3. Decision (manager) — single retry strategy

**Keep the job-level retry (5 attempts, exponential 2s backoff). Remove the inner `while` loop in `worker.ts`.**

Rationale:
- Job-level retry has proper backoff (exponential 2s) — back-to-back inner retries don't.
- Job runner handles retry orchestration via `nextRetryAt` / `attempts` columns — single source of truth.
- Inner loop's only "value" was speed of first retry — counterproductive for receivers.

Worker's `deliver()` becomes a single attempt:
- Validate URL + DNS.
- POST once with timeout.
- If response OK → record success delivery, return.
- If response not-OK or fetch throws → record failed delivery (with `nextRetryAt` ONLY IF this isn't the last job-level attempt, which the worker doesn't know about).

The job-level retry will fire `deliver()` again with a fresh attempt number. The `attemptCount` recorded in `webhook_deliveries` should come from the job's current attempt number (passed via task ctx if available), not the inner loop's local counter.

---

## 4. Files to modify

**Modify:**
- `packages/core/src/modules/webhooks/worker.ts` — rewrite `deliver()` to a single attempt. Drop the `while` loop and the local `attempt`/`maxAttempts` vars. Keep URL/DNS validation. Keep signature signing. Keep the `createDelivery` call but record `attemptCount` from the job context (or `1` if not available — document the caveat).
- `packages/core/src/modules/webhooks/tasks.ts` — pass the job's current attempt number into `worker.deliver()` (extend the worker signature to accept it; default to 1).

**Create:**
- `packages/core/test/webhooks-single-retry.test.ts`:
  - Mock the fetch to fail 3 times then succeed on 4th.
  - Assert: 4 fetch calls total (job-level retries) — NOT 12 (3 × 4 inner-and-outer combined).
  - Assert: backoff between attempts ≥ 1.5s (exponential 2s with some tolerance).
  - Assert: 4 entries in `webhook_deliveries` (one per attempt with proper `attemptCount`).

**Do not touch:**
- The HMAC signing logic.
- The SSRF prevention helpers.
- Schema.

---

## 5. Acceptance criteria

1. `worker.deliver()` performs at most ONE fetch per call.
2. `tasks.ts` retry config remains `attempts: 5, backoff: exponential 2s`.
3. `attemptCount` recorded matches the job's attempt number.
4. Test `webhooks-single-retry.test.ts` confirms exactly N attempts where N matches the job-level retry count, with backoff between them.
5. The `Webhook-Id` / event-uuid for receiver-side dedupe was discussed in the prior wiki — adding it is **out of scope** here (defer to backlog B-02). Do NOT add it; just remove the duplicate-attempt regression.

---

## 6. DoD

- [ ] All AC met.
- [ ] Atomic commit `[S2-03] webhook delivery uses single retry strategy`.
- [ ] Sentinel `.handoff/result-s2-03-webhook-retry.done`.

---

## 7. What NOT to do

- Do NOT add idempotency keys to the payload (backlog B-02).
- Do NOT change the `webhook_deliveries` schema.
- Do NOT change `tasks.ts` retry config beyond passing attempt number.
