# RFC-017: Adversarial Review Remediation

- **Status:** Proposed
- **Author:** Engineering
- **Date:** 2026-03-17
- **Scope:** Cross-cutting — core, plugins, adapters, deployment
- **Trigger:** Adversarial code review conducted 2026-03-17 surfaced 10 findings (3 critical, 4 medium, 3 low). The 3 critical findings were fixed immediately (commit `24c53e0`). This RFC tracks the remaining 7 findings as a structured remediation checklist.
- **Estimated effort:** 3-4 engineering-days total across all items

---

## 1. Summary of All Findings

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | Webhook idempotency TOCTOU race | CRITICAL | **FIXED** (atomic INSERT RETURNING) |
| 2 | Dev key active when NODE_ENV unset | MEDIUM | Open |
| 3 | SELECT FOR UPDATE without transaction | CRITICAL | **FIXED** (wrapped in db.transaction) |
| 4 | 35+ `as unknown as` double-casts | MEDIUM | Open |
| 5 | Resend template path uses wrong API | LOW | Open |
| 6 | Appointment hooks were dead code | CRITICAL | **FIXED** (moved to BookingService) |
| 7 | Zero tests for email adapters, webhook idempotency, order-emails hook | MEDIUM | Open |
| 8 | processedWebhookEvents schema barrel inclusion | OK | No action needed |
| 9 | SDK path parameter naming inconsistency | LOW | Open |
| 10 | Unknown task slugs fail silently with no log output | MEDIUM | Open |

---

## 2. Finding 2: Dev Key Active When NODE_ENV Unset (MEDIUM)

### Problem

The dev key bypass in `packages/core/src/auth/middleware.ts` is guarded by `config.auth?.enableDevKey` which defaults to `process.env.NODE_ENV !== "production"` in app configs. If `NODE_ENV` is not set at all (common in Docker containers without explicit env config), this evaluates to `true`, and the dev key backdoor is active in production.

Additionally, both example apps hardcode the same dev key value (`"dev-staff-key"`), and the dev key grants `permissions: ["*:*"]` with `role: "owner"` and `type: "user"` --- making it indistinguishable from a real owner session in audit logs.

### Checklist

- [ ] Add a startup warning in `createServer()` when `enableDevKey` is true and `NODE_ENV` is not `"development"`: `logger.warn("Dev key is enabled in non-development environment. Set enableDevKey: false in production.")`
- [ ] Change the dev actor `type` from `"user"` to `"dev"` so audit logs can distinguish dev key access from real user sessions
- [ ] Add a comment in the auth middleware recommending unique dev key values per app and documenting the NODE_ENV dependency
- [ ] Verify the `apps/runvae` and `apps/store-example` configs explicitly set `enableDevKey: process.env.NODE_ENV !== "production"` (they do, but confirm)

### Pseudocode

```
FUNCTION createServer(config):
    // ... existing setup ...

    IF config.auth.enableDevKey AND process.env.NODE_ENV !== "development":
        logger.warn("Dev key is enabled outside development. Disable in production via enableDevKey: false.")

    // ... rest of server setup ...
```

### Blueprint

```typescript
// packages/core/src/runtime/server.ts — after logger creation, before routes
if (config.auth?.enableDevKey && process.env.NODE_ENV !== "development") {
  logger.warn(
    "Dev key is enabled outside NODE_ENV=development. " +
    "Set auth.enableDevKey: false in production config."
  );
}

// packages/core/src/auth/middleware.ts — change dev actor type
// BEFORE:
c.set("actor", { type: "user", userId: "dev-staff", ... });
// AFTER:
c.set("actor", { type: "api_key", userId: "dev-staff", ... });
```

### Effort

1 hour.

---

## 3. Finding 4: `as unknown as` Double-Casts (MEDIUM)

### Problem

There are 35+ instances of `as unknown as` across the codebase. These bypass TypeScript's type checker entirely --- the first cast erases the source type, the second asserts a target type with zero structural validation. If the source shape diverges from the target (e.g., after a schema change), the mismatch is invisible at compile time and surfaces as a runtime crash.

The most concerning patterns are:

1. **Core routes** (`catalog.ts`, `orders.ts`, etc.): `c.req.valid("json") as unknown as SomeInput` --- 10+ instances. These bypass Zod's inferred types from the OpenAPI route definitions.
2. **Manifest route registration** (`manifest.ts`): `(app as unknown as OpenAPIHono).openapi(...)` --- the app type is `Hono` but the cast forces `OpenAPIHono`. This is structurally sound today but fragile.
3. **Admin jobs route**: Database queries cast through hand-rolled type signatures.

### Checklist

- [ ] Audit all `as unknown as` in `packages/core/src/interfaces/rest/routes/*.ts` --- determine if the Zod schema inference can replace the double-cast (use `z.infer<typeof routeSchema>` instead of `c.req.valid("json") as unknown as SomeInput`)
- [ ] Audit all `as unknown as` in `packages/core/src/kernel/plugin/manifest.ts` --- document why the cast is needed (OpenAPIHono requirement for plugin route registration) and add a code comment
- [ ] Audit all `as unknown as` in `packages/core/src/interfaces/rest/routes/admin-jobs.ts` --- replace with typed Drizzle query results
- [ ] Reduce the count from 35+ to under 10 justified instances, each with a code comment explaining why the cast is necessary
- [ ] Add an eslint rule or grep-based CI check that flags new `as unknown as` introductions

### Effort

Half day (4 hours). Most instances are mechanical replacements.

---

## 4. Finding 5: Resend Template Path Uses Wrong API (LOW)

### Problem

In `packages/adapters/adapter-resend/src/index.ts`, lines 89-98, the Resend template send path uses `headers: { "X-Template-Id": resendTemplateId }`. This is not the correct Resend API for server-side template rendering. The Resend SDK expects a `template` property in the `emails.send()` call, not a custom header. The current code path sends an empty `html: ""` body with a non-functional header.

Additionally, the error result from the template path's `resend.emails.send()` call is not checked --- if it fails, the error propagates as an unhandled rejection instead of a clean thrown error.

### Checklist

- [ ] Replace the `headers: { "X-Template-Id" }` approach with the correct Resend template API: `template: { id: resendTemplateId, variables: data }`
- [ ] Remove the `html: ""` placeholder (not needed when using templates)
- [ ] Add `{ error }` destructuring and throw on failure (matching the non-template path)
- [ ] Add a unit test that verifies the template path constructs the correct API call (mock the Resend SDK)

### Pseudocode

```
FUNCTION send(input):
    IF resendTemplateId exists for input.template:
        result = await resend.emails.send({
            from: options.from,
            to: [input.to],
            subject: subject,
            template: {
                id: resendTemplateId,
                variables: data,
            },
        })
        IF result.error:
            THROW "Resend template email failed: " + result.error.message
        RETURN

    // ... existing local HTML template path ...
```

### Blueprint

```typescript
// packages/adapters/adapter-resend/src/index.ts — replace lines 89-98
if (resendTemplateId) {
  const { error } = await resend.emails.send({
    from: options.from,
    to: [input.to],
    subject,
    template: {
      id: resendTemplateId,
      variables: data,
    },
  });
  if (error) {
    throw new Error(`Resend template email failed: ${error.message}`);
  }
  return;
}
```

### Effort

1 hour.

---

## 5. Finding 7: Zero Tests for Email Adapters, Webhook Idempotency, Order-Emails Hook (MEDIUM)

### Problem

Four production-facing features have zero test coverage:

1. `packages/adapters/adapter-resend/` --- no test files
2. `packages/adapters/adapter-ses/` --- no test files
3. Webhook idempotency (`processedWebhookEvents` + atomic INSERT RETURNING) --- no test references
4. Order-emails hook (`sendOrderStatusEmail`) --- no test references

The webhook idempotency fix (Finding 1) was shipped without a test verifying that concurrent duplicate events are actually deduplicated. The email adapters have no tests verifying that the correct Resend/SES API calls are made. The order-emails hook has no test verifying that email failure does not crash the order status change flow.

### Checklist

- [ ] `adapter-resend`: Write unit test with mocked `Resend` class. Verify `send()` calls `resend.emails.send()` with correct `from`, `to`, `subject`, `html`. Verify error handling (throw on failure). Verify template path.
- [ ] `adapter-ses`: Write unit test with mocked `SESv2Client`. Verify `send()` calls `SendEmailCommand` with correct `FromEmailAddress`, `Destination.ToAddresses`, `Content.Simple`. Verify error handling.
- [ ] `webhook idempotency`: Write integration test using `createTestServer`. Send two webhook requests with the same `event.id`. Assert first returns `{ received: true }`, second returns `{ received: true, duplicate: true }`. Assert `changeStatus` is called exactly once.
- [ ] `order-emails hook`: Write unit test. Mock `email.send()` to throw. Assert order status change still succeeds. Assert warning is logged.
- [ ] `consoleEmailAdapter`: Write unit test. Mock `console.log`. Assert output contains template name and recipient.

### Effort

1 day (8 hours). Most tests are straightforward mock-and-assert patterns.

---

## 6. Finding 9: SDK Path Parameter Naming Inconsistency (LOW)

### Problem

The SDK wrapper methods use different parameter names for the same conceptual entity:

- `sdk.me.orders.downloads(orderId)` --- parameter named `orderId`
- `sdk.me.orders.get(idOrNumber)` --- parameter named `idOrNumber`
- `sdk.orders.get(idOrNumber)` --- same entity, same name

This is not a bug --- the underlying OpenAPI routes define these parameters differently because some accept UUID or order number while others only accept UUID. But the inconsistency in the SDK wrapper's parameter naming may confuse consumers who expect uniform naming.

### Checklist

- [ ] Audit all SDK wrapper method parameter names against the OpenAPI spec path parameters
- [ ] Document in a code comment why some use `idOrNumber` (accepts both UUID and order number format) vs `orderId` (UUID only)
- [ ] Consider normalizing the route-level path parameters in future API versions (not a breaking change for now)

### Effort

30 minutes. Documentation only; no code changes required.

---

## 7. Finding 10: Unknown Task Slugs Fail Silently With No Log Output (MEDIUM)

### Problem

In `packages/core/src/kernel/jobs/runner.ts`, lines 73-85, when a job has an unregistered `taskSlug`, the runner marks it as `failed` in the database with `error: "Unknown task slug: ..."` but does **not** log a warning to the console. The failure is recorded only in the `commerce_jobs` table. If nobody monitors that table, these failures are invisible.

This is particularly dangerous for the appointment plugin: if a developer forgets to register `APPOINTMENT_EMAIL_TASKS` in `config.jobs.tasks`, every enqueued notification job silently fails in the database. The developer sees no console output, no error, no indication that notifications are not working.

### Checklist

- [ ] Add `logger.warn()` in the runner when a task slug has no registered handler: `logger.warn("Job failed: unknown task slug", { taskSlug: job.taskSlug, jobId: job.id })`
- [ ] Add `logger.error()` when a task handler throws: `logger.error("Job handler failed", { taskSlug: job.taskSlug, jobId: job.id, error: err.message })`
- [ ] Consider adding a boot-time validation that cross-references all task slugs enqueued by hooks against registered task handlers --- emit a warning for any unmatched slugs
- [ ] Add a test that verifies the runner logs a warning for unknown task slugs

### Pseudocode

```
FUNCTION runPendingJobs(args):
    // ... existing claim logic ...

    FOR EACH job IN claimed:
        task = tasks.get(job.taskSlug)

        IF NOT task:
            logger.warn("Unknown task slug — job will be marked as failed", {
                taskSlug: job.taskSlug,
                jobId: job.id,
            })
            // ... existing mark-as-failed logic ...
            CONTINUE

        TRY:
            result = await task.handler({ input, ctx })
            // ... existing success logic ...
        CATCH error:
            logger.error("Job handler threw an exception", {
                taskSlug: job.taskSlug,
                jobId: job.id,
                error: error.message,
            })
            // ... existing retry/fail logic ...
```

### Blueprint

```typescript
// packages/core/src/kernel/jobs/runner.ts — after line 73
if (!task) {
  logger.warn("Unknown task slug — job marked as failed", {
    taskSlug: job.taskSlug,
    jobId: job.id,
  });
  await db.update(commerceJobs).set({
    status: "failed",
    error: `Unknown task slug: ${job.taskSlug}`,
    updatedAt: new Date(),
    completedAt: new Date(),
  }).where(eq(commerceJobs.id, job.id));
  failed++;
  continue;
}

// ... in the catch block (after line 105):
} catch (err) {
  logger.error("Job handler failed", {
    taskSlug: job.taskSlug,
    jobId: job.id,
    error: err instanceof Error ? err.message : String(err),
    attempts: job.attempts + 1,
    maxAttempts: job.maxAttempts,
  });
  // ... existing retry/fail logic unchanged ...
}
```

### Effort

1 hour.

---

## 8. Implementation Priority

| Priority | Finding | Effort | Rationale |
|----------|---------|--------|-----------|
| 1 | #10 Silent task failures | 1 hour | Invisible failures are the hardest bugs to diagnose |
| 2 | #7 Missing tests | 1 day | Validates the critical fixes we already shipped |
| 3 | #2 Dev key guard | 1 hour | Security hygiene |
| 4 | #5 Resend template API | 1 hour | Broken feature path |
| 5 | #4 Double-casts | 4 hours | Type safety debt |
| 6 | #9 SDK naming | 30 min | Documentation only |
| **Total** | | **~14 hours (2 days)** | |

---

## 9. Success Criteria

- [ ] Job runner logs warnings for unknown task slugs and errors for handler failures
- [ ] Email adapter tests exist and pass (Resend, SES, console)
- [ ] Webhook idempotency integration test verifies dedup under concurrent delivery
- [ ] Order-emails hook test verifies email failure does not crash order flow
- [ ] Dev key startup warning emitted when enabled outside NODE_ENV=development
- [ ] Dev key actor type changed from `"user"` to `"api_key"` in audit logs
- [ ] Resend template path uses correct API (`template: { id, variables }`)
- [ ] `as unknown as` count reduced from 35+ to under 10 with justification comments
- [ ] SDK path parameter naming documented in code comments
