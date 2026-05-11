# Security Audit v2 Mediums — Closure Report

Source: `SECURITY-AUDIT-V2-SYNTHESIS.md` → “Gaps requiring follow-up work”

Current SHA: `48af016bfe532f4ba7ce56f441ace7c9c1549401`

## Closed Mediums

1. plugin-reviews IDOR (defense in depth) — CLOSED
- Fix: `ReviewService.submit(orgId, input, actor)` now requires actor, resolves customer-role `customerId` from `customers.getByUserId(actor.userId, actor)`, ignores spoofed body `customerId` for customer role, rejects anonymous.
- Files: `packages/plugins/plugin-reviews/src/services/review-service.ts`, `packages/plugins/plugin-reviews/src/routes/reviews.ts`, `packages/plugins/plugin-reviews/src/index.ts`
- Regression: `packages/plugins/plugin-reviews/test/reviews.test.ts` (`ignores spoofed customerId for customer-role actor`)

2. Refund > captured amount — CLOSED
- Fix: Added `orders.amountCaptured` and refund cap in order status change path using `Math.min(grandTotal, amountCaptured ?? grandTotal)`.
- Files: `packages/core/src/modules/orders/schema.ts`, `packages/core/src/modules/orders/service.ts`, `packages/core/src/hooks/checkout-completion.ts`, `apps/store-example/drizzle/0001_add-orders-amount-captured.sql`
- Regression: `packages/core/test/vapt-r2-mediums.test.ts` (`caps refund amount to amountCaptured`)

3. Media upload MIME magic-byte validation — CLOSED
- Fix: Added magic-byte detection + declared/detected mismatch validation, default MIME allow-list, and SVG rejection unless `config.media.allowSvg === true`.
- Files: `packages/core/src/modules/media/service.ts`, `packages/core/src/modules/media/module.ts`, `packages/core/src/config/types.ts`
- Regression: `packages/core/test/vapt-r2-mediums.test.ts` (`validates media mime by magic bytes and svg policy`)

4. requireEmailVerification production warning — CLOSED
- Fix: `createAuth()` logs loud production warning when `requireEmailVerification === false`.
- Files: `packages/core/src/auth/setup.ts`, `apps/store-example/commerce.config.ts`
- Regression: `packages/core/test/vapt-r2-mediums.test.ts` (`warns when requireEmailVerification is false in production`)

5. Per-account rate limit on `/api/auth/sign-in/email` — CLOSED
- Fix: Added per-email limiter on `POST /api/auth/sign-in/email` with SHA-256 email keying and default `10` attempts / `15` minutes, configurable via `config.rateLimits.signInPerEmail`.
- Files: `packages/core/src/runtime/server.ts`, `packages/core/src/config/types.ts`
- Regression: `packages/core/test/vapt-r2-mediums.test.ts` (`enforces per-email sign-in rate limit and applies csp header`)

6. CSP hook for adopters — CLOSED
- Fix: Added optional `config.security.csp` with `default` + `perRoute` policies and response header injection.
- Files: `packages/core/src/config/types.ts`, `packages/core/src/runtime/server.ts`
- Regression: `packages/core/test/vapt-r2-mediums.test.ts` (`enforces per-email sign-in rate limit and applies csp header`)

## Verification Log
- `packages/plugins/plugin-reviews`: `bunx tsc --noEmit` ✅, `bun test` ✅ (12 pass)
- `packages/core`: `bunx tsc --noEmit` ✅
- `packages/core`: `bunx vitest run` ⚠️ `388 pass / 1 skip / 3 fail` (existing webhook DNS/network-dependent failures in `test/webhooks.test.ts` and `test/webhooks-single-retry.test.ts`)
- `packages/core`: `bun test` ⚠️ same 3 pre-existing webhook failures

