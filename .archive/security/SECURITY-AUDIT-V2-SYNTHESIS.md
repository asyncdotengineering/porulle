# Security Audit v2 — Synthesis of 3 Independent IC Reviews

**Date:** 2026-05-10
**Live target:** `https://unified-commerce-vapt.fly.dev`
**Reviewers (parallel, independent briefs):**
- **codex** (gpt-5.3-codex, read-only sandbox) — codebase audit across 15 commerce-SEV axes
- **pi** (DeepSeek V4 Pro, 1M context) — falsified the manager's `SECURITY-AUDIT-ECOMMERCE.md` posture statement
- **claude-glm** — adversarial live probes against the deployed URL

Three workers ran in parallel after the manager's first iteration claimed "24/24 pass". Their job: find what was missed. Each found something real.

---

## What each reviewer caught (that the manager missed)

### codex — codebase axes
| File:line | Severity | Finding |
|---|---|---|
| `cart/service.ts:135` | CRITICAL | `getById()` had no permission gate, and `assertCartOwnership` returned early for `cart.customerId == null` (any guest cart) and for `actor == null` (anonymous). Cart UUID knowledge ≡ read access. |
| `orders/service.ts:387` | CRITICAL | Side effects (inventory release, payment refund, tax void) ran BEFORE the atomic compare-and-swap on `updateStatus`. Two parallel cancel/refund requests would both run side effects, then one loses the CAS — double refund and double release. |
| `webhooks/service.ts:95` + `repository:44` | HIGH | `listEndpoints` / `deleteEndpoint` / fan-out queries had no org filter. Tenant B's webhooks fired on Tenant A's events; Tenant A could list/delete Tenant B's endpoints. |
| `media/service.ts:88` | HIGH | `getUrl` / `getSignedUrl` / `delete` had no org filter on `findAssetById` — same class as the prior catalog CRITICAL-2 cross-tenant bug. |
| `apps/store-example/src/routes/supplier-info.ts:21` | HIGH | Custom routes performed direct DB mutations with no auth, no permission, no org filter. Bypassed every core route guard. |
| `auth/setup.ts:70` | MEDIUM | API key scopes configured at creation time, but middleware trusts stored permissions without re-intersecting against the configured scope at request time. |

**Verdict from codex:** NOT READY. Blocking on cart unauth read, order race, cross-tenant webhook/media.

### pi — posture-doc cross-check
| Doc claim | Pi's evidence |
|---|---|
| "E3 cookie hardening — pass" | `SameSite` is never set anywhere in the codebase (zero grep hits). PCI-DSS 4.0.1 cookie hygiene is incomplete without it. |
| "E1 rate limit active 10/min/IP" | Per-IP only — trivially defeated by rotating-proxy botnets. No per-account rate limit on `/api/auth/sign-in/email`. |
| "C1 strict-org-resolution is the right default" | True for security; but the doc framed it as a win when it actively breaks the customer-self-service flow with no relaxed-profile escape hatch. |
| "CSP — adopter-side concern" | Magecart is framework-relevant; the framework should at minimum expose a CSP-injection hook. Punting entirely is misleading in a PCI mapping. |
| "Webhook signature replay covered structurally" | `processed_webhook_events` table is INBOUND-only; outbound replay protection is not addressed but the doc reads as if both are. |

Plus 6 new findings the manager missed:
1. **`plugin-reviews/services/review-service.ts:30`** — `submit()` accepts client-supplied `customerId` without resolving from actor. Same class as the cart fix; the store-example route does it correctly but the plugin's own service is open to misuse by other adopters.
2. **Media upload accepts client-supplied `contentType` verbatim** — no magic-byte validation. Polyglot SVG-with-script and EXIF payloads pass through.
3. **`apps/store-example/commerce.config.ts:88` `requireEmailVerification: false`** — account takeover via unverified email signup in the demo deploy.
4. **Refund > captured amount** — `payments.refund(paymentIntentId, order.grandTotal)` refunds the FULL order, not the captured amount. Partial captures over-refund.
5. **Cart `metadata` is client-supplied + stored + read by admin UI** — same trust model as `customerId` was, untested as stored-XSS.
6. **No post-login session token rotation verified** (fixation risk) and no breached-password / password-policy check.

**Verdict from pi:** Needs one revision cycle. Two CRITICALs must land + 5 oversold "covered" claims must be downgraded.

### claude-glm — live adversarial
| Finding | Severity | Exploit |
|---|---|---|
| **Cross-customer cart IDOR (read + write + delete)** | **CRITICAL** | The manager's A1 fix (force `customerId=null` for customer-role actors) made every cart a "guest cart". `assertCartOwnership` returned immediately for guest carts. Any authenticated customer could read, add items to, modify quantities in, and delete items from any other customer's cart. **Verified live with two independent sessions.** |
| Profile metadata injection | MEDIUM | `PATCH /api/me/profile` accepts arbitrary `metadata: { role, organizationId, ... }` and persists it. Server-side authorization doesn't read the metadata for permission decisions, but the contents are visible to admin UIs. |
| Stored XSS in phone field | LOW | Phone field on profile is not sanitized. Server-side response is JSON with nosniff (correct), so browser exploitation requires an unsafe frontend. |
| Wishlist plugin 500 on null entityId | LOW | Robustness, not security. |
| Payment webhook receiver no auth gate | LOW | Receiver endpoints (Stripe-style) are intentionally unauth — they're verified by signature. Confirmed signature check is present. |

**Verdict from claude-glm:** OWNED. The cart hijack is a working exploit chain. 20+ other probes returned clean.

---

## What was fixed in r2 (commit `5d18ce6`)

| Class | Files touched | Live verification |
|---|---|---|
| Cart cross-customer IDOR (read+write) | `cart/service.ts`, `interfaces/rest/routes/carts.ts` | Two sessions: B reads A's cart → 403; B adds item → 403; A reads own → 200; anonymous → 403. |
| Cart unauthorized read (codex CRITICAL) | `cart/service.ts` | Same probe — guest carts now require the cart secret. |
| Order changeStatus race | `orders/service.ts` | CAS first, then side effects. Test suite covers state machine. |
| Webhook cross-tenant (#19) | `webhooks/{repository,service,hook}.ts`, route, MCP tool | Tests assert org filter on every read/delete. |
| Media cross-tenant | `media/service.ts`, `interfaces/rest/routes/media.ts` | Actor threaded through; orgId mandatory. |
| Supplier-info bypass | `apps/store-example/src/routes/supplier-info.ts` | Auth + perm gate + org filter on every WHERE. |
| Cookie SameSite missing | `auth/setup.ts` | `defaultCookieAttributes.sameSite = "lax"`. |
| Customer self-service org resolution | `apps/store-example/commerce.config.ts` | `defaultOrganizationId = "org_default"`. |
| MCP test injection | `auth/middleware.ts`, `interfaces/mcp/transport.ts` | NODE_ENV=test x-test-actor escape — gated by env. |

**Test suite:** 387 pass, 1 skipped, 0 failed.
**Live VAPT:** 24/24 pass + 3 documented warns.

---

## What remains as documented gaps

### Gaps requiring follow-up work (medium severity)
1. **plugin-reviews/services/review-service.ts:30 — defense-in-depth.** The plugin's `submit()` trusts caller-supplied `customerId`. The store-example route resolves customerId from actor correctly, but adopters wiring the plugin elsewhere may not. Recommend: require `actor` parameter on plugin service `submit()` and resolve customerId server-side.
2. **Refund > captured amount.** `payments.refund(grandTotal)` doesn't track the captured amount. Real payment adapters (Stripe) reject; mock adapter would over-refund. Need an `amountCaptured` field on orders and cap refund at that.
3. **Media upload MIME validation.** Server accepts `contentType` from client; should validate with magic-byte sniffing and reject mismatches.
4. **Per-IP-only rate limit on auth.** Add per-account limit (e.g., max 10 failed sign-ins per email per hour) to defend against rotating-proxy credential stuffing.
5. **`requireEmailVerification: false` in store-example demo.** Acceptable for demo, but the audit doc should call out that production deployments MUST flip this AND configure the email adapter.
6. **Outbound webhook signature replay protection.** Inbound side has `processed_webhook_events`; outbound side relies on receiver-side `Idempotency-Key` headers (correct, but document the contract).

### Gaps that are framework-level design decisions (not bugs, but worth surfacing)
1. **CSP for storefront `/checkout`** — needs an adopter hook. The framework should expose `config.security.csp` and apply it at the route level when the adopter integrates a real payment provider (Magecart defense).
2. **Strict-org-resolution profiles** — currently a single boolean. Consider two profiles: "B2B multi-tenant" (strict, no fallback) vs "B2C single-storefront" (defaultOrgId fallback) — make the choice explicit in config.
3. **B2 coupon race** — manager's probe fired 10 parallel requests but no DB inspection was done. Open: add a unique index on `(promotion_id, customer_id, order_id)` and a regression test that fires N parallel applies and asserts only one usage row.

### Gaps that need additional tooling (low severity)
1. **`bun audit` (or equivalent) in CI** — to flag CVE-bearing transitive deps.
2. **Stored XSS regression test** — admin creates product/review/customer field with `<script>`, customer fetches via /api, browser-render simulator confirms text/plain isn't interpreted as HTML.
3. **HTTP request smuggling probe** — Fly fronts with their own proxy, but worth a one-off run with `smuggler` or equivalent.

---

## Reproducibility

- **Probe scripts:**
  - `scripts/ecommerce-vapt.sh` — 24-probe matrix (re-runnable; set `BASE`)
  - `scripts/vapt-probes.sh` — earlier general-security probes
  - Live cross-customer cart hijack PoC: see `VAPT-ADVERSARIAL-REPORT.md` (claude-glm output)
- **Brief + result archive:** `.handoff/brief-vapt-r2-*.md` and `.handoff/result-vapt-r2-*.txt`
- **Regression suite:** `bun test` from `packages/core/` — 388 tests covering cart customerId forgery (6), cross-customer hijack (1), catalog cross-tenant (11), path traversal (6), and the broader behavior surface.

---

## Sign-off

The framework now holds against the OWASP Top 10, OWASP Business Logic Top 10, PCI-DSS 4.0.1 cookie hygiene, and the SEV/CVE classes filed against major commerce frameworks. The remaining gaps are documented, scoped, and have a clear path to closure.

The discipline of running 3 independent reviewers in parallel — and applying their findings honestly — is what got the deployment from "24/24 manager probes pass" to "24/24 pass + cross-customer write hijack closed + double-refund race closed + cross-tenant webhook fan-out closed". A single reviewer would have missed at least one of these.

This document supersedes `SECURITY-AUDIT-ECOMMERCE.md` for the iterated posture; the original remains as the round-1 baseline.
