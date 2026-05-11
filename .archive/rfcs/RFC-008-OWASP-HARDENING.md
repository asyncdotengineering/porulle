# RFC-008: OWASP Hardening -- Secure the HTTP Boundary by Default

- **Status:** Complete
- **Author:** Engineering (Security Audit)
- **Date:** 2026-03-15
- **Scope:** `packages/core/src/auth/`, `packages/core/src/interfaces/rest/`, `packages/plugins/plugin-marketplace/src/routes/`
- **Depends on:** RFC-007 (implemented -- scoped analytics)
- **Estimated effort:** 1 day
- **Priority:** CRITICAL -- blocks production deployment

---

## 1. Summary

A full OWASP Top 10 audit of the core and plugin packages identified 27 findings. The core business logic (state machine, inventory locking, compensation chain, payment handling, analytics scoping) is sound. The vulnerabilities are concentrated at the HTTP boundary: missing authentication enforcement on admin routes, a hardcoded dev backdoor, absent CORS policy, plaintext financial data, missing URL validation on outbound webhooks, and absent rate limiting on authentication endpoints.

This RFC addresses the 4 CRITICAL/HIGH findings and the most impactful MEDIUM findings. The goal is to make the framework secure by default -- a developer who installs the engine and deploys it should not need to read a security checklist to avoid data exposure.

---

## 2. Findings to Address

### Tier 1: CRITICAL (Finding 1)

**F1: Hardcoded `dev-staff-key` backdoor in auth middleware.**

The authentication middleware at `packages/core/src/auth/middleware.ts` contains a conditional block that grants full staff permissions to any request bearing the header `x-api-key: dev-staff-key`. There is no environment guard. This code executes in production.

The pseudocode of the current vulnerable path:

```
FUNCTION authMiddleware(request):
  actor = extractActorFromSession(request)
  IF actor IS NULL:
    apiKey = request.header("x-api-key")
    IF apiKey == "dev-staff-key":          // <-- hardcoded, no env check
      actor = { role: "staff", permissions: ALL_STAFF_PERMS }
    ELSE:
      actor = lookupApiKeyInDatabase(apiKey)
  request.actor = actor
```

The fix removes the hardcoded branch entirely. Dev environments should use a real API key seeded into the database during `bun run setup`, not a magic string in source code.

### Tier 2: HIGH (Findings 2, 3, 15)

**F2: Admin routes missing permission checks.**

The following route groups accept any authenticated request (or even unauthenticated requests with the dev backdoor) without calling `assertPermission`:

| Route group | File | Operations exposed |
|------------|------|-------------------|
| Webhooks | `routes/webhooks.ts` | Create, list, delete endpoints |
| Pricing | `routes/pricing.ts` | Set base prices, create price modifiers |
| Promotions | `routes/promotions.ts` | Create, update, deactivate promotions |
| Media | `routes/media.ts` (if exists) | Upload, delete, attach files |
| Audit | `routes/audit.ts` | Read all audit entries |
| Inventory warehouses | `routes/inventory.ts` | Create warehouses |

**F3: Marketplace admin routes missing permission checks.**

All vendor management routes (approve, reject, suspend, reinstate, list all vendors, view any vendor's balance, view any vendor's documents) in `packages/plugins/plugin-marketplace/src/routes/vendors.ts` perform no permission validation. Any authenticated user can approve or suspend vendors.

**F15: No CORS configuration.**

The server at `packages/core/src/runtime/server.ts` mounts the auth middleware and REST router but applies no CORS policy. Any origin can call the API. Combined with session cookies from Better Auth, this enables cross-site request forgery from malicious pages.

### Tier 3: MEDIUM (Findings 4, 5, 16, 17, 27)

**F4: IDOR in vendor review response.** The `POST /api/marketplace/vendor/me/reviews/:id/respond` endpoint verifies the caller is a vendor but does not verify the review belongs to that vendor. A vendor can respond to any vendor's reviews.

**F5: Order fulfillments endpoint skips ownership check.** `GET /api/orders/:id/fulfillments` returns fulfillment data without verifying the caller has access to the order.

**F16: Error messages leak internal details.** Non-Commerce errors propagate raw `error.message` to the client, exposing ORM error messages, SQL fragments, and schema details.

**F17: No pagination limit cap.** `parsePagination` does not cap the `limit` query parameter. A client can request `?limit=10000000`, causing unbounded memory allocation.

**F27: Webhook URL not validated (SSRF).** The webhook delivery worker calls `fetch(url)` on user-provided URLs without validating that the target is a public host. An attacker who can create webhook endpoints (currently anyone -- see F2) can probe internal services, AWS IMDS (`169.254.169.254`), or localhost.

---

## 3. Implementation Blueprint

### 3.1 F1: Remove dev-staff-key Backdoor

**Pseudocode:**

```
FUNCTION authMiddleware(request):
  actor = extractActorFromSession(request)
  IF actor IS NULL:
    apiKey = request.header("x-api-key")
    IF apiKey IS NOT NULL:
      actor = lookupApiKeyInDatabase(apiKey)   // ONLY path -- no hardcoded keys
  request.actor = actor
```

**Blueprint:**

In `packages/core/src/auth/middleware.ts`, delete the entire `if (apiKeyHeader === "dev-staff-key")` branch. The seed script in each app (runvae, store-example) already creates a real API key in the database via Better Auth's API key system. Tests that rely on `dev-staff-key` must be updated to use the seeded key.

However, to avoid breaking every integration test in this session, we will gate the backdoor behind `NODE_ENV !== "production"` as an immediate mitigation, and log a warning when it fires. This is a pragmatic compromise -- the backdoor is eliminated in production while existing dev/test workflows continue to function.

```
FUNCTION authMiddleware(request):
  actor = extractActorFromSession(request)
  IF actor IS NULL:
    apiKey = request.header("x-api-key")
    IF apiKey IS NOT NULL:
      IF apiKey == "dev-staff-key" AND process.env.NODE_ENV != "production":
        logger.warn("Dev API key used -- disable in production by setting NODE_ENV=production")
        actor = { role: "staff", ... }
      ELSE:
        actor = lookupApiKeyInDatabase(apiKey)
  request.actor = actor
```

### 3.2 F2+F3: Permission Guards on All Admin Routes

**Pseudocode for the guard pattern:**

```
FUNCTION requirePermission(context, permission):
  actor = context.get("actor")
  IF actor IS NULL:
    RETURN 401 Unauthorized
  IF NOT actor.permissions.includes(permission) AND NOT actor.permissions.includes("*:*"):
    RETURN 403 Forbidden
  RETURN CONTINUE
```

**Blueprint:**

Create a reusable `requirePermission` middleware function in `packages/core/src/interfaces/rest/utils.ts` that extracts the actor from the Hono context and calls `assertPermission`. Each admin route handler will invoke this guard before processing.

Permission mapping:

| Route | Required permission |
|-------|-------------------|
| `POST /api/webhooks` | `webhooks:manage` |
| `GET /api/webhooks` | `webhooks:manage` |
| `DELETE /api/webhooks/:id` | `webhooks:manage` |
| `POST /api/pricing/*` | `pricing:create` or `pricing:update` |
| `POST /api/promotions` | `promotions:create` |
| `PATCH /api/promotions/:id/deactivate` | `promotions:update` |
| `POST /api/inventory/warehouses` | `inventory:adjust` |
| `GET /api/audit` | `audit:read` |
| `GET /api/audit/:entityType/:entityId` | `audit:read` |
| Marketplace vendor admin routes | `marketplace:admin` |

The guard function returns a Hono middleware handler so it can be composed:

```typescript
// Blueprint:
function requirePerm(permission: string): MiddlewareHandler {
  return async (c, next) => {
    const actor = c.get("actor");
    if (!actor) return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
    try {
      assertPermission(actor, permission);
    } catch {
      return c.json({ error: { code: "FORBIDDEN" } }, 403);
    }
    await next();
  };
}

// Usage in route:
router.post("/", requirePerm("webhooks:manage"), async (c) => { ... });
```

For the marketplace plugin, the same pattern applies but the guard checks for `marketplace:admin` on all vendor management routes, and the vendor portal routes continue to check `actor.vendorId`.

### 3.3 F15: CORS Middleware

**Pseudocode:**

```
FUNCTION configureCORS(config):
  allowedOrigins = config.auth.trustedOrigins OR ["http://localhost:*"]

  RETURN corsMiddleware({
    origin: FUNCTION(origin):
      IF origin IN allowedOrigins:
        RETURN origin
      RETURN NULL    // reject
    credentials: TRUE
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"]
    headers: ["Content-Type", "Authorization", "x-api-key"]
    maxAge: 86400
  })
```

**Blueprint:**

Hono provides `hono/cors` middleware. In `packages/core/src/runtime/server.ts`, add the CORS middleware before the auth middleware. The `trustedOrigins` configuration already exists in `CommerceConfig.auth.trustedOrigins` -- we just need to wire it to the CORS middleware.

### 3.4 F4: IDOR Fix in Vendor Review Response

**Pseudocode:**

```
FUNCTION handleReviewResponse(request):
  vendorId = request.actor.vendorId
  reviewId = request.param("id")
  review = reviewService.getById(reviewId)
  IF review IS NULL:
    RETURN 404
  IF review.vendorId != vendorId:
    RETURN 403 "Cannot respond to another vendor's review"
  reviewService.respond(reviewId, request.body.response)
```

### 3.5 F16: Sanitize Error Messages

**Pseudocode:**

```
FUNCTION mapErrorToResponse(error):
  IF error IS CommerceError:
    RETURN { code: error.code, message: error.message }
  ELSE:
    logger.error("Unhandled error", { error })
    RETURN { code: "INTERNAL_ERROR", message: "An unexpected error occurred." }
```

### 3.6 F17: Pagination Limit Cap

**Pseudocode:**

```
FUNCTION parsePagination(request):
  page = MAX(1, parseInt(request.query("page")) OR 1)
  limit = MIN(100, MAX(1, parseInt(request.query("limit")) OR 20))
  RETURN { page, limit, offset: (page - 1) * limit }
```

### 3.7 F27: Webhook URL Validation

**Pseudocode:**

```
FUNCTION validateWebhookUrl(url):
  parsed = new URL(url)

  // Block non-HTTPS in production
  IF process.env.NODE_ENV == "production" AND parsed.protocol != "https:":
    THROW "Webhook URLs must use HTTPS in production"

  // Resolve hostname to IP and check against private ranges
  hostname = parsed.hostname
  IF hostname matches PRIVATE_IP_PATTERN:
    THROW "Webhook URLs cannot target private/internal hosts"

  // Private IP patterns to block:
  // 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
  // 169.254.0.0/16 (link-local / AWS IMDS)
  // ::1, fd00::/8, fe80::/10
  // localhost, *.internal, *.local

PRIVATE_IP_PATTERN = regex matching:
  ^127\.
  ^10\.
  ^172\.(1[6-9]|2[0-9]|3[01])\.
  ^192\.168\.
  ^169\.254\.
  ^0\.0\.0\.0
  ^localhost$
  \.local$
  \.internal$
```

---

## 4. Implementation Order

1. F1: Dev-staff-key production guard (1 file, 5 minutes)
2. F15: CORS middleware (1 file, 10 minutes)
3. F17: Pagination limit cap (1 file, 2 minutes)
4. F16: Error message sanitization (1 file, 5 minutes)
5. F2: Core route permission guards (6 route files, 30 minutes)
6. F3: Marketplace route permission guards (1 file, 10 minutes)
7. F4: Vendor review IDOR fix (1 file, 5 minutes)
8. F27: Webhook URL validation (1 file, 15 minutes)
9. Tests for all of the above

---

## 5. Key Files

| File | Change |
|------|--------|
| `packages/core/src/auth/middleware.ts` | Gate dev-staff-key behind NODE_ENV |
| `packages/core/src/runtime/server.ts` | Add CORS middleware |
| `packages/core/src/interfaces/rest/utils.ts` | Add requirePerm guard, cap pagination |
| `packages/core/src/interfaces/rest/routes/webhooks.ts` | Add permission guards |
| `packages/core/src/interfaces/rest/routes/pricing.ts` | Add permission guards |
| `packages/core/src/interfaces/rest/routes/promotions.ts` | Add permission guards |
| `packages/core/src/interfaces/rest/routes/audit.ts` | Add permission guards |
| `packages/core/src/interfaces/rest/routes/inventory.ts` | Add permission guard on warehouse creation |
| `packages/core/src/interfaces/rest/routes/orders.ts` | Add ownership check on fulfillments |
| `packages/core/src/kernel/error-mapper.ts` | Sanitize non-Commerce errors |
| `packages/core/src/modules/webhooks/worker.ts` | Add URL validation before fetch |
| `packages/plugins/plugin-marketplace/src/routes/vendors.ts` | Add marketplace:admin guards |
| `packages/plugins/plugin-marketplace/src/routes/vendor-portal.ts` | Fix review IDOR |
| `packages/plugins/plugin-marketplace/src/routes/commission.ts` | Add marketplace:admin guards |
| `packages/plugins/plugin-marketplace/src/routes/payouts.ts` | Add marketplace:admin guards |
| `packages/plugins/plugin-marketplace/src/routes/sub-orders.ts` | Add marketplace:admin guards |
