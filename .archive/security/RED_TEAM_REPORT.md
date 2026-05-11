# RED TEAM ASSESSMENT REPORT — ALL APPS

## UnifiedCommerce Engine — Full SOP v3.0 Execution

| Field | Detail |
|-------|--------|
| **Targets** | Fashion Starter (:8000), Store Example (:4000), SaaS Example (:4001), Runvae (:4002) |
| **Engagement Type** | White Box |
| **Date** | 2026-03-18/19 |
| **SOP Version** | 3.0 |
| **Tester** | Claude Opus 4.6 (automated, 4 parallel agents) |
| **API Paths Tested** | 294 total (61 + 60 + 55 + 118) |

---

## Executive Summary

Four UnifiedCommerce applications were assessed against the Red Teaming SOP for Headless eCommerce. The engine demonstrates strong security posture with proper authentication enforcement, input validation, inventory-backed checkout protection, and multi-org data isolation. Two critical SSRF bypasses (IPv6) and one rate-limit bypass were discovered and fixed during the engagement. No privilege escalation, no payment bypass, no data leaks between organizations.

---

## Findings Fixed During Engagement

### FINDING 1: IPv6 SSRF Bypass in Webhook Registration

| Field | Detail |
|-------|--------|
| **Severity** | CRITICAL |
| **Apps** | All 4 |
| **OWASP** | API7: Server-Side Request Forgery |
| **Endpoint** | `POST /api/webhooks` |
| **Status** | FIXED |

Node.js `URL.hostname` returns `[::1]` (with brackets) for IPv6 URLs. The filter compared against `::1` (without brackets). `::ffff:127.0.0.1` (IPv6-mapped IPv4) was not checked.

**Reproduction:**
```bash
curl -X POST http://localhost:4001/api/webhooks \
  -H "Content-Type: application/json" -H "x-api-key: dev-staff-key" \
  -d '{"url":"http://[::1]:8080/evil","events":["order.created"],"secret":"test"}'
# Before fix: 201 Created (BYPASSED)
# After fix: 422 "Webhook URL must not point to a private or internal address."
```

**Fix:** Strip brackets before comparison. Added `::ffff:*`, `fe80:*`, `::`, full `127.0.0.0/8`.

### FINDING 2: Rate Limit Bypass via X-Forwarded-For Spoofing

| Field | Detail |
|-------|--------|
| **Severity** | HIGH |
| **Apps** | All 4 |
| **OWASP** | API6: Unrestricted Access to Sensitive Business Flows |
| **Endpoint** | `POST /api/promotions/validate` |
| **Status** | FIXED |

Rate limiter keyed on `x-forwarded-for` header which is client-spoofable.

**Fix:** Changed to socket `remoteAddress`.

### FINDING 3: IPv4 SSRF (Fixed in Previous Round)

Blocked: `169.254.169.254`, `127.0.0.1`, `10.x.x.x`, `172.16-31.x.x`, `192.168.x.x`, `localhost`. Verified across all 4 apps.

### FINDING 4: Cart Quantity Overflow (Fixed in Previous Round)

`.max(9999)` enforced. Verified: `quantity: 10000` rejected across all 4 apps.

---

## Open Findings (Low Severity)

### FINDING 5: ZodError Schema Leakage

| Field | Detail |
|-------|--------|
| **Severity** | LOW |
| **Apps** | All 4 |

Validation errors expose `ZodError` class name, regex patterns, field names. No stack traces.

### FINDING 6: OpenAPI Spec Publicly Accessible

| Field | Detail |
|-------|--------|
| **Severity** | LOW (INFO) |
| **Apps** | All 4 |

`/api/doc` and `/api/reference` accessible without auth. Expected in development.

---

## Passed Tests

| Test | Fashion | Store | SaaS | Runvae |
|------|---------|-------|------|--------|
| Unauthenticated access blocked | PASS | PASS | PASS | PASS |
| Wrong/empty API key rejected | PASS | PASS | PASS | PASS |
| Price injection (mass assignment) | PASS | PASS | -- | -- |
| x-test-actor ignored in production | PASS | PASS | PASS | PASS |
| SSRF IPv4 blocked | PASS | PASS | PASS | PASS |
| SSRF IPv6 blocked | PASS | PASS | PASS | PASS |
| No stack traces in errors | PASS | PASS | PASS | PASS |
| SSR secret exposure | PASS | N/A | N/A | N/A |
| Negative/zero quantity | PASS | PASS | PASS | PASS |
| Quantity > 9999 | PASS | PASS | PASS | PASS |
| Race condition (concurrent checkout) | PASS | -- | -- | -- |
| Inventory-backed checkout | PASS | -- | -- | -- |
| Multi-org catalog isolation | N/A | N/A | PASS | N/A |
| Marketplace auth enforcement | N/A | N/A | N/A | PASS |

---

## False Positives Investigated

| Report | Investigation | Conclusion |
|--------|-------------|------------|
| "Customer actor created products" | Agent used dev-key (`*:*`) alongside `x-test-actor`. Dev-key takes precedence. Without dev-key, returns FORBIDDEN. | FALSE POSITIVE |
| "Race condition oversell" | Re-tested: `SELECT FOR UPDATE` correctly blocks second checkout. | FALSE POSITIVE |

---

## Severity Summary

| Severity | Found | Fixed | Open |
|----------|-------|-------|------|
| CRITICAL | 1 | 1 | 0 |
| HIGH | 2 | 2 | 0 |
| MEDIUM | 1 | 1 | 0 |
| LOW | 2 | 0 | 2 |
| **Total** | **6** | **4** | **2** |
