# Security Model

Adopter-facing security documentation for Porulle. This document describes what the framework defends against, how it is configured, and what it does not cover.

## Threat model

The framework defends against:

- OWASP Top 10 (injection, broken auth, sensitive data exposure, XXE, broken access control, misconfig, XSS, deserialization, known-vuln components, logging gaps)
- OWASP Business Logic Top 10 (mass assignment, race conditions, IDOR, privilege escalation)
- Commerce-specific severity classes: cross-tenant data leak, cross-customer IDOR, payment over-refund, inventory double-release, order status race, webhook forgery

The framework does **not** defend against:

- **Magecart at adopter checkout pages.** Requires CSP configuration by the adopter. The framework provides the hook (`config.security.csp`); the adopter must use it.
- **Data residency.** Single-region database today. No per-org region routing. Multi-region data sovereignty is Phase 2.
- **Agent identity verification.** The `Actor` type has no agent principal. API keys are the only non-human identity. Agent attestation (Web Bot Auth, KYA) is Phase 2.

## Org resolution profiles

The framework supports two tenant resolution modes.

### B2C single-storefront

```ts
auth: {
  defaultOrganizationId: "org_default",
}
```

Customers without explicit org membership fall through to the default org. All data is scoped to one tenant. Used in `apps/store-example/commerce.config.ts`. This is the right mode for single-store deployments.

### B2B multi-tenant

```ts
auth: {
  strictOrgResolution: true,
  storeResolver: async (request) => {
    const storeId = request.headers.get("x-store-id");
    return storeId ?? null;
  },
}
```

No fallback. Customers must be members of an org via Better Auth's organization plugin. The `storeResolver` callback maps incoming requests to org IDs (header-based, domain-based, or path-based). If resolution fails and `strictOrgResolution` is true, the request is rejected with HTTP 503.

Production B2B deployments must configure `storeResolver`. Without it, all requests fall into the same default org and cross-tenant isolation breaks.

Reference: `packages/core/src/auth/org.ts`.

## Rate limit layers

Four rate limiters are applied in sequence. All are per-IP unless noted. Defaults can be overridden via `config.rateLimits`.

| Layer | Scope | Default | Config key |
|---|---|---|---|
| `/api/auth/*` | Per-IP | 10/min | `rateLimits.auth` |
| `/api/auth/sign-in/email` | Per-email (SHA-256 keyed) | 10/15min | `rateLimits.signInPerEmail` |
| `/api/checkout` | Per-IP | 5/min | `rateLimits.checkout` |
| `/api/*` | Per-IP | 100/min | `rateLimits.api` |

The per-email limiter hashes the email with SHA-256 before using it as the rate limit key, so raw emails are not stored in the rate limit state. Reference: `packages/core/src/runtime/server.ts:47--51`.

**Limitation:** Rate limit storage is in-memory. Limits are per-process and do not hold across multiple instances. For multi-instance deployments (ECS, Cloud Run, multiple Fly machines), a `RateLimitStoreAdapter` backed by Redis or Durable Objects is needed. This is not yet implemented. See agent-native audit Gap F4.

## Cookie hygiene

Session cookies are configured with:

- `__Secure-` prefix in production (via `useSecureCookies: true` when `NODE_ENV === "production"`)
- `HttpOnly` (managed by Better Auth)
- `Secure` flag in production
- `SameSite: lax` -- blocks CSRF on POST/PUT/DELETE while allowing top-level GET navigation (needed for OAuth redirects)

Reference: `packages/core/src/auth/setup.ts:157--166`.

## CSP recommendations

The framework exposes `config.security.csp` for Content-Security-Policy header injection.

```ts
security: {
  csp: {
    default: "default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    perRoute: {
      "/api/checkout": "default-src 'self'; script-src 'self' https://js.stripe.com; frame-src https://js.stripe.com https://hooks.stripe.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    },
  },
},
```

The `/api/checkout` route should have a strict CSP when integrating Stripe Elements or Braintree Hosted Fields. The policy above allows only the provider's script and frame origins. Adjust for your payment provider.

Reference: `packages/core/src/runtime/server.ts:252--265`.

## Trusted origins and CSRF

`config.auth.trustedOrigins` sets the allowed origins for CORS and CSRF protection. In development, `http://localhost:*` is allowed by default. In production, an empty `trustedOrigins` array blocks all cross-origin requests.

CSRF middleware is scoped to `/api/*` via Hono's `csrf()` middleware. Better Auth handles CSRF on `/api/auth/*` routes separately.

Reference: `packages/core/src/runtime/server.ts:168--184`.

## Body limit

1 MB default via Hono's `bodyLimit` middleware. Applied globally.

```ts
app.use("*", bodyLimit({
  maxSize: 1024 * 1024,
  onError: (c) => c.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds 1MB limit." } }, 413),
}));
```

Override for media uploads is not yet a first-class config option. The media module has `config.media.allowedMimeTypes` and `config.media.allowSvg` for MIME validation, but no separate body size override.

Reference: `packages/core/src/runtime/server.ts:187--192`.

## SSRF guards

Webhook URL registration validates against private, loopback, and metadata IPs:

- Loopback: `127.x.x.x`, `::1`, `localhost`
- Link-local: `169.254.x.x`, `fe80:`
- Private (RFC 1918): `10.x`, `172.16--31.x`, `192.168.x`
- Cloud metadata: `169.254.169.254`, `metadata.google.internal`
- Invalid URLs are blocked (returns `true`)

Reference: `packages/core/src/modules/webhooks/service.ts:13--48` (`isPrivateUrl`).

## Audit log

Every mutation writes a row to `commerce_audit_log` with `organizationId`, `entityType`, `entityId`, `event`, `payload`, `actorId`, `actorType`, and `requestId`. Audit entries are written automatically via audit hooks registered during kernel boot. Services do not call `audit.record()` directly.

Schema: `packages/core/src/modules/audit/schema.ts`. Hook registration: `packages/core/src/modules/audit/hooks.ts`.

## What is coming in Phase 2

These are roadmap items, not current capabilities:

- **Agent principal model.** `Actor` will be replaced with a `Principal` discriminated union supporting `User | ApiKey | BuyerAgent | SellerAgent | System`. Authorization grants with scope, expiry, and amount caps.
- **UCP/ACP protocols.** Beyond MCP. A `/.well-known/commerce-capabilities` manifest. Multi-protocol gateway.
- **Conversation layer.** `Conversation` entity with `ChannelAdapter` for WhatsApp/SMS/web-chat.
- **Returns-as-entity.** Returns promoted from marketplace-plugin-local to a core entity with its own state machine.
- **Data residency.** Per-org region routing in the database adapter. Data classification tags. Cross-border transfer audit log.
- **Rate limit store adapter.** External store (Redis, Durable Objects) for cross-instance rate limiting.

Reference: `.audits/agent-native-audit-unified-commerce-engine-2026-05-10.md`, Migration Path.

## Guest credentials

A guest cart carries a secret returned once, at creation. It is a bearer
credential: whoever presents it is treated as the cart's owner.

```
POST /api/carts                    -> { id, secret }
GET  /api/carts/:id                x-cart-secret: <secret>
POST /api/checkout                 x-cart-secret: <secret>
GET  /api/orders/:id               x-cart-secret: <secret>
```

**What it grants.** Reading and writing that cart, checking it out, and reading
the order it produced — including the order's line items, totals and shipping
address, and the rendered invoice and receipt.

**How long.** Cart writes and checkout stop at the cart's `expires_at`
(`config.cart.ttlMinutes`, seven days by default). Reading the resulting order
is bounded separately, by `config.orders.guestAccessStrategy`, which defaults to
seven days measured from the order's `placed_at`:

```ts
import { windowedGuestOrderAccess } from "@porulle/core";

orders: {
  guestAccessStrategy: windowedGuestOrderAccess("30d"),
}
```

The two windows are independent on purpose. Anchoring order access on the cart
would give a shopper who checked out on the sixth day of a seven-day cart one
day of receipt access.

**What it does not grant.** Emailing the invoice anywhere other than the address
already on the order. Only an actor holding organization-wide `orders:read` may
name a different recipient.

**Treat it as a password.** It is a 122-bit random UUID, so it is not guessed —
the realistic exposure is leakage: a referrer header, a link shared in a chat, a
log line, a browser history on a shared device. Keep it out of URLs and out of
your logs. The access window is what limits the damage of a leak; there is no
revocation endpoint.

**Authenticated customers do not use it.** Account ownership grants access to
their own orders permanently, and no window applies.

## Membership and role grants

`/api/admin/staff` is the only surface that writes organization membership. It
enforces three rules that Better Auth's own organization endpoints do not, so
those endpoints are refused:

- **Permission containment.** Granting a role requires already holding every
  permission that role carries. A `staff:manage` holder cannot mint a role
  carrying permissions it lacks.
- **Rank floor.** The grantor must outrank or equal both the role being granted
  and the target's current role.
- **Last-owner invariant.** An organization cannot be left without an owner,
  including under concurrent revocations.

Invitations are deferred grants and run the same checks twice — when created and
again when accepted, against the inviter's authority *at that moment*. A member
who loses authority cannot have their outstanding invitations redeemed.

Role strings are single roles. Comma-separated composites are refused wherever a
role is accepted.

## Known gaps

These are documented limitations from the security audit (commit `5d18ce6` and follow-up closures):

1. **Coupon race condition.** The promotion apply endpoint has not been load-tested at the database level. A unique index on `(promotion_id, customer_id, order_id)` and a parallel-apply regression test are needed. Reference: `SECURITY-AUDIT-V2-SYNTHESIS.md`.

2. **Outbound webhook signature replay.** The inbound side has `processed_webhook_events` for replay protection. The outbound side signs payloads but does not track delivery receipts. Replay protection is the receiver's responsibility. Document this in your webhook consumer.

3. **HTTP request smuggling.** Not tested at the proxy boundary. Fly.io fronts the deployment with their own proxy. If you deploy behind a different reverse proxy, test for request smuggling with `smuggler` or equivalent.

4. **In-memory rate limiting.** Does not hold across multiple instances. See Rate limit layers above.

5. **No revocation for a guest cart secret.** A leaked secret cannot be
   invalidated; it expires with its window and not before. Narrow
   `config.orders.guestAccessStrategy` if your risk tolerance needs it shorter
   than seven days.

6. **`requireEmailVerification: false` in production.** The framework logs a warning at boot. If you run with email verification disabled in production, anyone can sign up with any email and access the account immediately. Enable it and configure `config.email.send` for production deployments.
