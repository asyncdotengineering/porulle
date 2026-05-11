# Day 3b -- Contract Documents -- Closure Report

**Date:** 2026-05-10
**Branch:** `foundation-repair`

## Deliverables

| File | Summary |
|---|---|
| `docs/PLUGIN-CONTRACT.md` | Adopter-facing rules for plugin authors: required `actor` parameter, server-side `customerId` resolution, org scoping, `Result<T>` contract, hook ordering caveat, regression test requirements, and the plugin-reviews IDOR fix as canonical diff. |
| `docs/PAYMENT-ADAPTER-CONTRACT.md` | Adopter-facing contract for `PaymentAdapter` implementations: method semantics, accurate `amountCaptured` requirement, idempotency, timing-safe webhook verification, 3DS challenge flow workaround, and anti-patterns. |
| `docs/SECURITY-MODEL.md` | Adopter-facing security model: threat model scope, org resolution profiles (B2C/B2B), rate limit layers, cookie hygiene, CSP recommendations, CSRF/trusted origins, SSRF guards, audit log, Phase 2 roadmap, and documented known gaps. |

## Verification

- Every claim references a file path in the codebase.
- No source code was modified.
- No `apps/docs/` site content was touched.
- Three files created in `docs/` at repo root.
