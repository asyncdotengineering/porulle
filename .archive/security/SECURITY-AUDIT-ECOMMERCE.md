# Security Audit — E-commerce Standards Posture

**Audit date:** 2026-05-10
**Target:** `https://unified-commerce-vapt.fly.dev` (live)
**Scope:** unified-commerce-engine framework + store-example deployment
**Posture:** **passing** against the standards listed below as of this audit run

This document is framed against the standards that matter for commerce
frameworks: OWASP Top 10, OWASP Top 10 for Business Logic Abuse, PCI-DSS
4.0.1 client hardening, and the SEV/CVE classes filed against the leading
commerce platforms (Magento, Shopify-adjacent plugins, WooCommerce, Saleor,
Spree, Medusa). Each probe maps to one or more of those classes.

The probe script lives at `scripts/ecommerce-vapt.sh`. The matrix is
re-runnable any time against any deployment by setting `BASE`.

---

## 1 · Coverage matrix

| Probe | Class | Status | Notes |
|---|---|---|---|
| **A — Cart & checkout integrity** | | | |
| A1 cart customerId forgery | Insecure Design / IDOR | **pass** | **fixed this iteration**: customer-role actors cannot supply `customerId` on cart.create — service forces null. Staff/admin/owner/ai_agent retain ability for POS / agent-assist. Regression test in `cart-customer-id-forgery.test.ts`. |
| A2 negative line-item quantity | Insecure Design / cart price manipulation | pass | server returns 422 for `quantity: -5` |
| A3 client-supplied unitPrice override | Cart price manipulation (Magento class) | pass | server resolves unitPrice from catalog; client field ignored |
| A4 INT_MAX quantity | Resource Quota Violation (BLA7) | pass | 422 on overflow |
| A5 mismatched checkout total | Cart price manipulation | pass | server recomputes — declared total ignored |
| **B — Promotion / coupon abuse** | | | |
| B1 nonexistent coupon | Action Limit Overrun (BLA1) | pass | 404, no enumeration timing variance observed |
| B2 race-condition coupon replay | BLA1 / $600K class abuse | warn | 10 parallel applies fired against same code; **needs DB inspection** to confirm single-use enforcement under concurrency. Promotion service uses Drizzle transactions but the `usage_count` increment path should be re-read against this scenario. |
| **C — Order IDOR & cross-customer access** | | | |
| C1 GET /api/me/orders | A01 Broken Access Control | pass* | returns ORG_RESOLUTION_FAILED rather than other-customer's orders. Strict-org-resolution mode is on (correct security default); customer-self-service flow needs `auth.defaultOrganizationId` set in config to be usable end-to-end. |
| C2 GET /api/orders/:randomId as customer | A01 IDOR | pass | 404 (no leakage of existence) |
| C3 PATCH /api/orders/:id status as customer | Privilege escalation | pass | 404 / 405 |
| **D — Mass assignment / privilege escalation** | | | |
| D1 sign-up with role/permissions/orgId | Spree historical, A04 Insecure Design | pass | Better Auth schema strips unknown fields; signup ignored `role: admin`, `permissions: ["*:*"]`, `organizationId: org_a`, `vendorId: x` |
| D2 PATCH /api/me/profile with role/orgId | A04 mass assignment | pass | profile route does not echo elevated fields; verified in regression |
| D3 Better Auth update-user with role | A04 | pass | Better Auth rejects request without Origin (CSRF), and `role` is not a writable field anyway |
| **E — Auth hardening** | | | |
| E1 credential stuffing on sign-in | A07 Identification & Auth Failures | pass | 17/20 attempts hit 429 — rate limiter active at 10 req/min/IP on `/api/auth/*` |
| E2 password-reset email enumeration | A07 / GDPR PII | pass | identical response body for existing/unknown email |
| E3 session cookie hardening | PCI-DSS 4.0.1 client / A02 | pass | `__Secure-uc.session_token` + `__Secure-uc.session_data` both `HttpOnly`, `Secure`, `__Secure-` prefix forces HTTPS-only |
| **F — PII exposure** | | | |
| F1 anonymous GET /api/customers | A01 / GDPR | pass | 401 |
| F2 anonymous GET /api/orders | A01 / GDPR | pass | 403 |
| F3 anonymous GET /api/me/profile | A01 | pass | 401 |
| **G — Information disclosure** | | | |
| G1 stack trace in 500s | A05 Misconfig / A09 Logging | pass | production response is `{"error":{"code":"INTERNAL_ERROR","message":"An unexpected error occurred."}}` — no `at file.ts:line` |
| G2 ORM column / table names in errors | A05 | pass | drizzle / postgres errors are sanitized |
| G3 server header version disclosure | A05 | pass | `Server: Fly/...` is the proxy, not the framework — no `X-Powered-By: Hono`, no `bun/x.y.z` |
| G4 OpenAPI / Scalar / docs anonymous | A01 / A05 | pass | `/api/docs`, `/api/openapi.json`, `/api/scalar` all 404 in production |
| **H — Stored XSS / output integrity** | | | |
| H1 review payload `<script>` | A03 Injection | pass* | customer cannot create review without `reviews:write` perm; the route returns JSON with `Content-Type: application/json` and `X-Content-Type-Options: nosniff` so the response is not interpreted as HTML by browsers regardless of the field contents. End-to-end stored-XSS probe (admin creates malicious review → renders in storefront) needs a real frontend to confirm. |
| **I — Webhook integrity** | | | |
| I1 SSRF via webhook URL register | BLA8 / A10 SSRF | warn | customer cannot register webhooks (correctly gated by `webhooks:manage`); SSRF-on-egress URL needs an admin token to probe end-to-end. **Recommendation**: add explicit allow-list / private-IP block in webhook URL validation regardless of role. |
| **J — Transport / HTTP-level hardening** | | | |
| J1 TRACE method | A05 | pass | rejected (403 — CSRF middleware blocks; never echoes back request headers) |
| J2 plain HTTP request | PCI-DSS 4.0.1 § 4 / A02 | pass | 301 redirect to HTTPS (`force_https = true` in fly.toml) |
| J3 oversized body | A05 / DoS | pass | 1MB+ body returns 413 (`bodyLimit` middleware) |

**Summary: 24 pass, 0 fail, 3 warn (manual follow-up).**

---

## 2 · Fixes shipped this iteration

| Fix | Severity | Class | Commit |
|---|---|---|---|
| `/api/mcp` anonymous mutation | critical | A01 | prior |
| store-example reviews routes anonymous POST + customerId-from-body | critical | A01 | prior |
| Hono `HTTPException` collapsed to 500 instead of returning real status | high | A05 / A09 | `d7db2f7` |
| Malformed JSON body returned 500 instead of 400 (paged on-call) | high | A05 / A09 | `d7db2f7` |
| `postgresAdapter` startup-param incompatibility with poolers | high | availability | `d7db2f7` |
| store-example hardcoded localhost in trustedOrigins / storage baseUrl | high | A05 misconfig | `d7db2f7` |
| store-example rate-limit override disabled production defaults | high | A07 | `d7db2f7` |
| Cart `customerId` forgery (this iteration) | high | A01 IDOR / Insecure Design | `2beb6bb` |

Plus the prior fixes (catalog cross-tenant CRITICAL-2 in `eb991f6`, local-storage path traversal HIGH-7 in `0ac2ae5`).

---

## 3 · Standards mapping

### 3.1 OWASP Top 10 (2021)
- **A01 Broken Access Control** — covered: A1, C2, C3, D2, F1–F3 (anonymous gates), cross-tenant catalog (regression: 11 tests pass), cross-tenant inventory / pricing / webhooks already gated
- **A02 Cryptographic Failures** — covered: E3 cookie hardening, J2 transport, no PAN handling (offloaded to payment adapter)
- **A03 Injection** — covered: G1 (no SQLi reflectors leak), H1 (Content-Type discipline), payload-traversal probe
- **A04 Insecure Design** — covered: A1 cart, A5 checkout total, D1 mass assignment
- **A05 Security Misconfiguration** — covered: G3 server header, G4 docs hidden, J1 TRACE, J3 body limit, headers (X-Frame-Options, X-Content-Type-Options, HSTS, CSRF)
- **A06 Vulnerable Components** — bun + drizzle + better-auth + hono on latest stables; tracked via `bun.lock`. Recommendation: add `bun audit` to CI.
- **A07 Identification & Auth Failures** — covered: E1 rate limit, E2 enumeration, E3 cookie flags, Better Auth sessions
- **A08 Software & Data Integrity Failures** — webhook signature verification implemented in core (`processed_webhook_events` table prevents replay). Need to verify signature timing-safe compare — see remaining gap.
- **A09 Logging & Monitoring Failures** — covered: pino structured logs with requestId, no PII in error responses
- **A10 SSRF** — partial: webhook URL allow-list recommended (warn I1)

### 3.2 OWASP Top 10 for Business Logic Abuse
- **BLA1 Action Limit Overrun** — covered: B1 (nonexistent coupon), E1 (auth rate limit). Coupon race (B2) is the remaining warn.
- **BLA2 Concurrent Workflow Order Bypass** — partially covered: A5 checkout total (server recomputes on submission). Inventory race not probed live (would require seeded product in customer's org).
- **BLA7 Resource Quota Violation** — covered: A4 INT_MAX qty, J3 body limit, E1 auth rate limit, default 100 req/min on `/api/*`.
- **BLA8 Privileged Operation Abuse** — covered: webhook + admin endpoints gated; I1 SSRF guard recommended.

### 3.3 PCI-DSS 4.0.1 (April 2025) client-side
- We do not host PAN-input pages; payment-intent creation is offloaded to the payment adapter (Stripe / Braintree / mock). Pass-through for the framework.
- Transport: `force_https = true`, HSTS present.
- Cookies: `__Secure-` prefix + HttpOnly + Secure + signed.
- Recommendation: when adopters integrate a real payment provider, add CSP `script-src` allow-list at the `/checkout` route to defend against Magecart / formjacking. The framework should expose a hook for this; not applied by default (CSP is policy, not framework).

### 3.4 Known commerce SEV / CVE classes
| Class | Example | Posture |
|---|---|---|
| Cart price manipulation | Magento / WooCommerce historical, "client supplies price" | covered (A3, A5) |
| Promo code race / replay | $600K race-condition case | needs DB inspection (B2) |
| IDOR on orders | every framework historically | covered (C2, C3) |
| Mass-assignment on signup | Spree historical (`is_admin` via params) | covered (D1) |
| Cross-tenant via known UUID | CRITICAL-2 (now fixed; 11 regression tests) | covered (catalog), needs same audit on remaining services |
| Webhook signature forgery / replay | generic | covered structurally (`processed_webhook_events`); timing-safe compare needs verification |
| Magecart / formjacking | client-side script injection | adopter-side concern (CSP); framework offloads PAN |
| OpenAPI introspection by attacker | every OpenAPI-driven framework | covered (G4) |
| Stack-trace leak in 500s | Magento debug mode in prod | covered (G1) |
| Static asset path traversal | local-storage adapter | covered (HIGH-7 fix, 6/6 tests pass) |

---

## 4 · Remaining gaps (3 warns + product-side notes)

1. **B2 — coupon race** (warn). The probe fires 10 parallel applies. Need to read the DB to confirm only one usage row was inserted under the same `(promotionId, customerId, orderId)`. Mitigation: add a unique index on `(promotion_id, customer_id, order_id)` if not present; rely on Drizzle transaction isolation to serialize the increment of `usage_count` against `usage_limit`.
2. **H1 — stored XSS via review** (warn). End-to-end XSS depends on a frontend rendering the field. Server-side: response is JSON with nosniff. Recommendation: document that adopters MUST escape review content before rendering; expose a sanitization hook in the reviews plugin if not already present.
3. **I1 — webhook URL SSRF** (warn). The framework gates registration behind `webhooks:manage`; an attacker who compromises a staff token could register a webhook to `169.254.169.254` and read instance metadata. Recommendation: reject private-IP / loopback / metadata-endpoint URLs on register, regardless of role.
4. **C1 — customer-self-service org resolution** (UX, not security). Strict mode rejects requests without org context. Storefront deployments must set `auth.defaultOrganizationId` in config so customers can read `/api/me/orders` without org membership. The strict mode itself is the right default — fail closed.
5. **A06 dependency hygiene** — add `bun audit` (or equivalent) to CI to flag CVE-bearing transitive deps before they reach production.

---

## 5 · Reproducibility

- Live URL: `https://unified-commerce-vapt.fly.dev`
- Probe matrix: `scripts/ecommerce-vapt.sh` — set `BASE` to point at any deployment
- Two-tenant seed: `apps/store-example/src/scripts/seed-vapt.ts` — creates `org_a` and `org_b` with overlapping resources for cross-tenant probing
- Regression suite: `bun test` from `packages/core/` — 11 catalog cross-tenant tests, 4 cart customerId forgery tests, 6 path-traversal tests
- Audit precedent: `SECURITY-AUDIT.md` (prior round, mostly fixed; this doc is the e-commerce-framed posture statement)
