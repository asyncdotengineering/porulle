---
"@porulle/core": minor
---

Two integrator quick wins from the ordereka-fashion-pos field study: `config.routes(app, kernel, auth)` now receives the Better Auth instance (no more module-global auth-holder shims) and `requirePerm` is a public export for authorizing custom routes; orders and checkout accept an `idempotencyKey` (new `orders.idempotency_key` column + unique org-scoped index — consumers regenerate migrations) so offline POS queues and network retries replay safely instead of double-charging — a checkout replay returns the original order without re-authorizing payment.
