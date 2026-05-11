# Security Testing SOP — UnifiedCommerce Engine

**Version:** 1.1
**Date:** 2026-03-21
**Audience:** External security team / penetration testers

---

## 1. Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Bun | >= 1.1 | JavaScript runtime + package manager |
| PostgreSQL | >= 15 | Local PostgreSQL instance (no Docker) |
| curl | any | Manual endpoint testing |
| jq | any | JSON response parsing |
| Git | any | Clone the repository |

```bash
# Verify prerequisites
bun --version && psql --version && curl --version | head -1 && jq --version
```

---

## 2. Environment Setup

### 2.1 Clone & Install

```bash
git clone https://github.com/octalpixel/unified-commerce.git
cd unified-commerce
bun install
```

### 2.2 Create the Database (Local PostgreSQL)

Use your local PostgreSQL instance. No Docker required.

```bash
# Create the database (adjust user/host if your local PG uses different defaults)
createdb runvae

# Or via psql:
psql -c "CREATE DATABASE runvae;"

# Verify connection
psql -d runvae -c "SELECT 1;"
```

Set the connection string in your environment:

```bash
# Option A: Export for this terminal session
export DATABASE_URL="postgres://localhost:5432/runvae"

# Option B: Create a .env file in apps/runvae/
echo 'DATABASE_URL=postgres://localhost:5432/runvae' > apps/runvae/.env
```

If your local PostgreSQL requires a username/password:

```bash
export DATABASE_URL="postgres://your_user:your_password@localhost:5432/runvae"
```

### 2.3 Initialize Database & Seed Data

```bash
cd apps/runvae
bun run setup
# Equivalent to: bun run db:reset && bun run seed
```

This pushes all schemas and populates:
- 7 product categories (tops, dresses, bottoms, sarees, accessories, footwear, activewear)
- 5 marketplace vendors (Aviha by Design, Colombo Threads, Island Weave, Selyn Fair Trade, Embark Studio)
- Products with variants, pricing (LKR cents), inventory
- 1 warehouse: "Colombo Central" (CMB)
- Influencer profiles, subscription plans
- Default organization: `org_default`

### 2.4 Start the Application Server

```bash
bun run dev
# Server starts on http://localhost:4001
```

Verify:

```bash
curl -s http://localhost:4001/api/health | jq
# Expected: { "status": "ok" }
```

### 2.5 Full Reset (if needed)

```bash
# Drop and recreate the database
dropdb runvae && createdb runvae
cd apps/runvae && bun run setup && bun run dev
```

> **Note:** Redis is optional. The system falls back to in-memory stores when `REDIS_URL` is not set. This is fine for security testing.

---

## 3. Authentication

The system supports three auth mechanisms. For security testing, use the **dev key**.

### 3.1 Dev Key (Admin Access)

```bash
# All API calls use this header for full admin access:
curl -H "x-api-key: dev-staff-key" http://localhost:4001/api/catalog/entities | jq
```

This grants:
- Role: `owner`
- Permissions: `["*:*"]` (wildcard — full access)
- Organization: `org_default`

### 3.2 Create a Regular User (for privilege escalation tests)

```bash
# Sign up a customer
curl -X POST http://localhost:4001/api/auth/sign-up/email \
  -H "Content-Type: application/json" \
  -d '{
    "email": "attacker@test.com",
    "password": "Test1234!",
    "name": "Attacker"
  }' | jq

# Sign in — capture the session cookie
curl -X POST http://localhost:4001/api/auth/sign-in/email \
  -H "Content-Type: application/json" \
  -c cookies.txt \
  -d '{
    "email": "attacker@test.com",
    "password": "Test1234!"
  }' | jq

# Use the session cookie for subsequent requests
curl -b cookies.txt http://localhost:4001/api/me/orders | jq
```

### 3.3 Create an API Key (for scoped access tests)

```bash
# Create an API key via Better Auth (requires admin session)
curl -X POST http://localhost:4001/api/auth/api-key \
  -H "x-api-key: dev-staff-key" \
  -H "Content-Type: application/json" \
  -d '{ "name": "security-test-key" }' | jq

# Use the returned key:
curl -H "x-api-key: <returned-key>" http://localhost:4001/api/catalog/entities | jq
```

---

## 4. API Surface Map

### 4.1 Core Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/health` | None | Health check |
| GET | `/api/doc` | None (dev only) | OpenAPI spec |
| GET | `/api/catalog/entities` | None/Auth | List products |
| GET | `/api/catalog/entities/:idOrSlug` | None/Auth | Get product |
| POST | `/api/catalog/entities` | `catalog:create` | Create product |
| GET | `/api/carts/:id` | `cart:read` | Get cart |
| POST | `/api/carts` | `cart:create` | Create cart |
| POST | `/api/carts/:id/items` | `cart:update` | Add cart item |
| POST | `/api/checkout` | `orders:create` | Checkout |
| GET | `/api/orders` | `orders:read` | List orders |
| GET | `/api/orders/:id` | `orders:read` | Get order |
| PATCH | `/api/orders/:id/status` | `orders:update` | Change status |
| GET | `/api/inventory/check` | `inventory:read` | Check stock |
| POST | `/api/inventory/adjust` | `inventory:adjust` | Adjust stock |
| POST | `/api/promotions` | `promotions:manage` | Create promo |
| POST | `/api/promotions/validate` | Any | Validate code |
| GET | `/api/customers` | `customers:read` | List customers |
| POST | `/api/media/upload` | `media:write` | Upload file |
| GET | `/api/audit` | `audit:read` | Audit log |
| GET | `/api/jobs/run` | `*:*` | Trigger job runner |

### 4.2 Customer Portal

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/me/orders` | Session | My orders |
| GET | `/api/me/orders/:id` | Session | My order detail |
| GET | `/api/me/orders/:id/tracking` | Session | Order tracking |

### 4.3 Plugin Endpoints

| Plugin | Base Path | Key Endpoints |
|--------|-----------|---------------|
| Marketplace | `/api/marketplace` | `/vendors`, `/sub-orders` |
| Gift Cards | `/api/gift-cards` | `/create`, `/check-balance`, `/redeem` |
| Loyalty | `/api/loyalty` | `/points`, `/redeem`, `/offers` |
| Reviews | `/api/reviews` | `/`, `/mine`, `/:id/approve` |
| Appointments | `/api/appointments` | `/book`, `/services`, `/providers` |
| POS | `/api/pos` | `/transactions`, `/sessions` |
| POS Restaurant | `/api/pos-restaurant` | `/tables`, `/kds` |

### 4.4 Webhook Endpoints (HMAC-verified, no session auth)

| Method | Path | Verification |
|--------|------|--------------|
| POST | `/webhooks/shopify/products/*` | `X-Shopify-Hmac-Sha256` |
| POST | `/webhooks/shopify/inventory_levels/*` | `X-Shopify-Hmac-Sha256` |
| POST | `/webhooks/woocommerce/product.*` | `X-WC-Webhook-Signature` |

---

## 5. Test Execution Procedures

### 5.1 BOLA/IDOR Testing

**Objective:** Verify that user A cannot access user B's resources by manipulating IDs.

```bash
# Step 1: Create two separate user accounts
# (Sign up user-a@test.com and user-b@test.com per Section 3.2)

# Step 2: As user A, create a cart and add items
CART_A=$(curl -s -b cookies-a.txt -X POST http://localhost:4001/api/carts \
  -H "Content-Type: application/json" \
  -d '{"currency":"LKR"}' | jq -r '.data.id')

echo "User A cart: $CART_A"

# Step 3: As user B, attempt to access user A's cart
curl -s -b cookies-b.txt "http://localhost:4001/api/carts/$CART_A" | jq
# EXPECTED: 404 Not Found (org isolation) or 403 Forbidden
# FAIL: 200 with cart data = BOLA vulnerability

# Step 4: Repeat for orders, customers, promotions, media assets
```

### 5.2 Multi-Org Isolation Testing

**Objective:** Verify that data from organization A is invisible to organization B.

```bash
# Step 1: Create product as admin (org_default)
PRODUCT_ID=$(curl -s -H "x-api-key: dev-staff-key" \
  -X POST http://localhost:4001/api/catalog/entities \
  -H "Content-Type: application/json" \
  -d '{
    "type": "product",
    "slug": "isolation-test-product",
    "attributes": { "title": "Secret Product" }
  }' | jq -r '.data.id')

echo "Product ID: $PRODUCT_ID"

# Step 2: Access by UUID (should succeed for same org)
curl -s -H "x-api-key: dev-staff-key" \
  "http://localhost:4001/api/catalog/entities/$PRODUCT_ID" | jq '.data.id'
# EXPECTED: Returns the product

# Step 3: Create a second organization and API key for it
# (This requires Better Auth organization creation — use the admin API)

# Step 4: With org B's API key, attempt to access org A's product
curl -s -H "x-api-key: <org-b-api-key>" \
  "http://localhost:4001/api/catalog/entities/$PRODUCT_ID" | jq
# EXPECTED: 404 Not Found
# FAIL: 200 with product data = cross-org data leak
```

### 5.3 Race Condition Testing

**Objective:** Prove that concurrent requests cannot double-spend, oversell, or corrupt state.

```bash
# Inventory oversell test
# Step 1: Set inventory to exactly 1 unit
curl -s -H "x-api-key: dev-staff-key" \
  -X POST http://localhost:4001/api/inventory/adjust \
  -H "Content-Type: application/json" \
  -d "{\"entityId\": \"$PRODUCT_ID\", \"adjustment\": -999999, \"reason\": \"reset\"}"

curl -s -H "x-api-key: dev-staff-key" \
  -X POST http://localhost:4001/api/inventory/adjust \
  -H "Content-Type: application/json" \
  -d "{\"entityId\": \"$PRODUCT_ID\", \"adjustment\": 1, \"reason\": \"set to 1\"}"

# Step 2: Fire 10 concurrent cart+checkout requests
for i in $(seq 1 10); do
  (
    # Create cart
    CART=$(curl -s -H "x-api-key: dev-staff-key" \
      -X POST http://localhost:4001/api/carts \
      -H "Content-Type: application/json" \
      -d '{"currency":"LKR"}' | jq -r '.data.id')

    # Add item
    curl -s -H "x-api-key: dev-staff-key" \
      -X POST "http://localhost:4001/api/carts/$CART/items" \
      -H "Content-Type: application/json" \
      -d "{\"entityId\": \"$PRODUCT_ID\", \"quantity\": 1}"

    # Checkout
    RESULT=$(curl -s -H "x-api-key: dev-staff-key" \
      -X POST http://localhost:4001/api/checkout \
      -H "Content-Type: application/json" \
      -d "{\"cartId\": \"$CART\", \"paymentMethodId\": \"card-mock\"}")

    echo "Request $i: $(echo $RESULT | jq -r '.data.id // .error.code')"
  ) &
done
wait

# EXPECTED: Only 1 succeeds, 9 fail with inventory/checkout errors
# FAIL: Multiple succeed = race condition / oversell
```

### 5.4 Price Manipulation Testing

**Objective:** Verify server-side price calculation cannot be bypassed.

```bash
# Step 1: Create a cart and add an item
CART=$(curl -s -H "x-api-key: dev-staff-key" \
  -X POST http://localhost:4001/api/carts \
  -H "Content-Type: application/json" \
  -d '{"currency":"LKR"}' | jq -r '.data.id')

curl -s -H "x-api-key: dev-staff-key" \
  -X POST "http://localhost:4001/api/carts/$CART/items" \
  -H "Content-Type: application/json" \
  -d "{\"entityId\": \"$PRODUCT_ID\", \"quantity\": 1}"

# Step 2: Attempt checkout with manipulated price fields
curl -s -H "x-api-key: dev-staff-key" \
  -X POST http://localhost:4001/api/checkout \
  -H "Content-Type: application/json" \
  -d "{
    \"cartId\": \"$CART\",
    \"paymentMethodId\": \"card-mock\",
    \"subtotal\": 1,
    \"grandTotal\": 1,
    \"totalDiscount\": 999999
  }" | jq

# EXPECTED: Extra fields ignored. Server calculates real totals.
# FAIL: Order created with manipulated prices
```

### 5.5 Promotion Code Brute Force

**Objective:** Verify rate limiting on promo code validation.

```bash
# Fire 20 rapid requests to enumerate promo codes
for i in $(seq 1 20); do
  CODE="GUESS${i}"
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "x-api-key: dev-staff-key" \
    -X POST http://localhost:4001/api/promotions/validate \
    -H "Content-Type: application/json" \
    -d "{\"code\": \"$CODE\", \"currency\": \"LKR\", \"subtotal\": 100000, \"lineItems\": []}")
  echo "Request $i ($CODE): HTTP $STATUS"
done

# EXPECTED: After ~10 requests, receive HTTP 429 (rate limited)
# FAIL: All 20 return 200/404 = no rate limiting
```

### 5.6 Input Validation Testing

```bash
# Negative quantity
curl -s -H "x-api-key: dev-staff-key" \
  -X POST "http://localhost:4001/api/carts/$CART/items" \
  -H "Content-Type: application/json" \
  -d "{\"entityId\": \"$PRODUCT_ID\", \"quantity\": -5}" | jq
# EXPECTED: 400/422 validation error

# Zero inventory adjustment
curl -s -H "x-api-key: dev-staff-key" \
  -X POST http://localhost:4001/api/inventory/adjust \
  -H "Content-Type: application/json" \
  -d "{\"entityId\": \"$PRODUCT_ID\", \"adjustment\": 0, \"reason\": \"test\"}" | jq
# EXPECTED: 400/422 validation error

# Integer overflow price
curl -s -H "x-api-key: dev-staff-key" \
  -X POST http://localhost:4001/api/inventory/reserve \
  -H "Content-Type: application/json" \
  -d "{\"entityId\": \"$PRODUCT_ID\", \"quantity\": 99999999999, \"orderId\": \"fake\"}" | jq
# EXPECTED: Validation error or proper handling
```

### 5.7 Security Headers Verification

```bash
curl -sI http://localhost:4001/api/health | grep -iE "x-content-type|x-frame|strict-transport|referrer-policy|permissions-policy"

# EXPECTED (all present):
# x-content-type-options: nosniff
# x-frame-options: DENY
# referrer-policy: strict-origin-when-cross-origin
# permissions-policy: camera=(), microphone=(), geolocation=()
```

### 5.8 Error Leakage Testing

```bash
# Trigger a validation error — should not expose schema details
curl -s -H "x-api-key: dev-staff-key" \
  -X POST http://localhost:4001/api/catalog/entities \
  -H "Content-Type: application/json" \
  -d '{"invalid": true}' | jq

# EXPECTED (production): {"error":{"code":"VALIDATION_FAILED","message":"Invalid input."}}
# FAIL: Response contains Zod schema details, field names, or stack traces

# Trigger a 500 error — should not expose internals
curl -s -H "x-api-key: dev-staff-key" \
  "http://localhost:4001/api/orders/not-a-uuid" | jq
# EXPECTED: Generic error, no stack trace
```

### 5.9 Webhook Replay Testing

```bash
# Attempt to send a webhook without valid HMAC
curl -s -X POST http://localhost:4001/webhooks/shopify/products/create \
  -H "Content-Type: application/json" \
  -d '{"id": 12345, "title": "Injected Product"}' | jq
# EXPECTED: 401 Invalid HMAC signature

# Attempt with forged HMAC
curl -s -X POST http://localhost:4001/webhooks/shopify/products/create \
  -H "Content-Type: application/json" \
  -H "X-Shopify-Hmac-Sha256: forged-value" \
  -d '{"id": 12345, "title": "Injected Product"}' | jq
# EXPECTED: 401 Invalid HMAC signature
```

---

## 6. Automated Test Execution

Run the existing test suites which include security-relevant assertions:

```bash
# Core tests (280+ tests: auth, permissions, BOLA, race conditions)
cd packages/core && bun test

# All plugin tests (300+ tests)
cd ../.. && for dir in packages/plugins/*/; do (cd "$dir" && bun test); done

# Runvae integration tests (300+ tests: checkout, BNPL, promotions)
cd apps/runvae && bun test
```

---

## 7. Teardown

```bash
# Stop the server (Ctrl+C in the dev terminal)

# Drop the test database
dropdb runvae

# Remove session cookies
rm -f cookies*.txt
```

---

## 8. Reporting

All findings should follow the template in `SECURITY-AUDIT-PROMPT.md` (included in this repository). At minimum, each finding must include:

1. **Severity** (CRITICAL / HIGH / MEDIUM / LOW)
2. **File path and line number**
3. **Concrete reproduction steps** (curl commands from this SOP)
4. **Expected vs actual behavior**
5. **Recommended fix** (code diff)

Submit the report as a Markdown file named `SECURITY-AUDIT-YYYY-MM-DD.md` in the repository root.

---

## 9. Quick Reference

```bash
# One-liner: full setup from zero (local PG must be running)
createdb runvae 2>/dev/null; cd apps/runvae && DATABASE_URL=postgres://localhost:5432/runvae bun run setup && bun run dev

# Auth header for all curl commands
-H "x-api-key: dev-staff-key"

# Base URL
http://localhost:4001

# API docs (dev only)
http://localhost:4001/api/doc

# OpenAPI JSON
curl http://localhost:4001/api/doc | jq

# Database connection (for manual inspection)
psql -d runvae
```
