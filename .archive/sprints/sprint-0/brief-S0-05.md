# Story Brief — `S0-05` Wire `compensation_failures` into chain + admin routes

> **You are the IC engineer (`cursor` worker, fresh process; clean context).** Branch: `foundation-repair`.
>
> **Atomic-commit policy:** ONE commit `[S0-05] compensation persistence + admin routes`. **Sentinel mandatory:** `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s0-05-compensation-wire.done` (or `STUCK <reason>`) as the very last action.
>
> **Depends on S0-04.** S0-04 created the table + repository. This story wires it in.

---

## 1. Goal

Persist every compensation-step failure to `compensation_failures` so an operator can see and resolve them. Add admin REST endpoints for list + resolve.

---

## 1.5 Validation policy (sprint-wide)

**Do NOT run `bun run test`, `bun run check-types`, or `bun run lint`.** Manager runs the full validation chain in the consolidated review gate at end of Sprint 4. Your DoD: write the code + tests, stage, commit atomically, sentinel.

Fix anything obviously broken by inspection. Don't run the full suite per story.

---

## 2. Required reading

1. `sprints/sprint-0/PLAN.md` § S0-05.
2. The S0-04 commit (read its diff): `git show <S0-04 sha>` for the schema + repository signatures.
3. `packages/core/src/kernel/compensation/executor.ts` — full file. Specifically the swallow block at lines 47–52.
4. `packages/core/src/kernel/compensation/types.ts` — extend `CompensationContext`.
5. `packages/core/src/hooks/checkout-completion.ts` — full file. Find where `runCompensationChain` is called.
6. `packages/core/src/hooks/checkout.ts` — full file.
7. `packages/core/src/runtime/kernel.ts` — the kernel composition (where to instantiate the new repo + register permissions).
8. `packages/core/src/interfaces/rest/routes/` — full directory listing. Find the existing `admin/` patterns. If none exists, mirror the existing route structure conventions (look at `webhooks.ts` or `audit.ts` if they exist; otherwise pick the cleanest single-route module as a template).
9. `packages/core/src/auth/permissions.ts` — `assertPermission` pattern.

---

## 3. Files to create/modify

**Create:**
- `packages/core/src/interfaces/rest/routes/admin/compensation-failures.ts` — Hono OpenAPI route module for the two endpoints.
- `packages/core/test/compensation-failures-integration.test.ts` — end-to-end: forced compensation failure → DB row → admin endpoint lists → resolve endpoint marks resolved.

**Modify:**
- `packages/core/src/kernel/compensation/types.ts` — extend `CompensationContext` with optional `failureRepository?: CompensationFailuresRepository`, `correlationId?: string`, `chainName?: string`. All optional to preserve existing call-site compatibility.
- `packages/core/src/kernel/compensation/executor.ts` — when a compensation step throws, persist to `failureRepository` if provided. Include the original error's message/code/details and the compensation error's message/stack. Wrap the persist call in its own `try/catch` — a failed persist must NOT mask the original error returned to the caller. Log a stderr warning if the persist itself fails.
- `packages/core/src/hooks/checkout-completion.ts` (and/or `checkout.ts` wherever the chain is invoked) — pass `failureRepository`, `correlationId: order.id` (or cart.id pre-creation), `chainName: "checkout"` to the compensation context.
- `packages/core/src/runtime/kernel.ts` — instantiate `CompensationFailuresRepository`, expose it on the service container as `services.compensationFailures` (typed in `Kernel["services"]`).
- `packages/core/src/interfaces/rest/index.ts` (or wherever route modules are registered) — register the new admin route module.

**Do not touch:**
- The schema (S0-04 owns it).
- `runCompensationChain`'s public signature beyond extending `CompensationContext`.

---

## 4. Endpoint spec

**`GET /api/admin/compensation-failures`**
- Query params: `?resolved=false|true|all` (default: `false`), `?limit=50&offset=0` (max limit 200).
- Permission: `compensation:admin`. Use `assertPermission(actor, "compensation:admin")`. Add the scope to the `auth.roles.admin.permissions` default list in the kernel's role wiring (read what's already there; just add the new scope to the admin role).
- Response: `{ items: CompensationFailure[]; total: number; limit: number; offset: number }`. Strip jsonb internals beyond `message` if they contain stack traces — keep response payload digestible.
- Org scoping: `resolveOrgId(actor)` and pass to `repository.list()`. Cross-org reads are impossible by construction.

**`POST /api/admin/compensation-failures/:id/resolve`**
- Body: `{ notes?: string }` (Zod schema, max length 2000).
- Permission: `compensation:admin`.
- Calls `repository.markResolved({ id, organizationId: resolveOrgId(actor), resolvedBy: actor.userId, notes })`.
- Response on success: `{ failure: CompensationFailure }`.
- Response on `Err`: 404 (not found), 409 (already resolved), 403 (cross-org) — map from `Err.code`.

---

## 5. Acceptance criteria

1. `CompensationContext` carries optional `failureRepository`, `correlationId`, `chainName`. Existing call sites compile without changes (the fields are optional).
2. `executor.ts` persists when a `compensate()` throws AND `failureRepository` is in ctx. Persist failure does NOT change the value returned to the caller (still the original error).
3. `kernel.ts` instantiates `CompensationFailuresRepository` and adds it to `Kernel["services"]`. Type entry added.
4. Checkout chain passes the repo + correlation id + chain name. Verify by reading the diff: every `runCompensationChain` invocation in `hooks/checkout*.ts` provides these.
5. Both admin endpoints exist, are registered, permission-gated, OpenAPI-documented (zod schemas — match the project's existing style; check `webhooks.ts` or another route for the canonical pattern).
6. `compensation:admin` scope added to the admin role's default permissions.
7. Integration test:
   - Boots a test kernel.
   - Mocks one inventory step's `compensate()` to throw.
   - Forces a checkout into the compensation path (via a payment-step failure or similar).
   - Asserts: original checkout error returned to caller; row in `compensation_failures` with the expected fields; `GET` lists it; `POST .../resolve` marks resolved; `markResolved` second time returns 409.
8. No `as any`, no public-surface drift.

---

## 6. DoD

- [ ] All AC met (by inspection — manager runs the suite at the gate).
- [ ] No `as any`, no `@ts-ignore`.
- [ ] Atomic commit `[S0-05] compensation persistence + admin routes` with body covering: (a) test files added (list paths), (b) confirmation original error semantics unchanged, (c) the `compensation:admin` scope addition.
- [ ] Sentinel `.handoff/result-s0-05-compensation-wire.done` with `DONE <sha>`.

---

## 7. What NOT to do

- Do NOT change `runCompensationChain`'s return type.
- Do NOT promote `failureRepository` from optional to required in `CompensationContext` — that breaks every existing test fixture.
- Do NOT swallow the original error if persist fails. Log to stderr; return the original error.
- Do NOT add the admin endpoints to the public API doc. They're admin-only — match how `audit` routes are exposed (likely behind `internalApiOnly` or similar conventions; mirror).
- Do NOT introduce a new service-container key beyond `services.compensationFailures`.

You are the IC. Sincere work only.
