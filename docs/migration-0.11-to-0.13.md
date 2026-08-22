# Migrating from @porulle/core 0.11.x to 0.13.0

**Read this first: there is no 0.12.0 on npm.** It was versioned in the
repository and never published, so `latest` went `0.11.0 → 0.13.0`. Everything
0.12.0 would have shipped is folded into this release. If you pinned `0.12.0`
and it resolved, you were installing from a local build, not the registry.

This release is mostly about authorization: who may read what, who may grant a
role, and how long a guest credential is good for. Several defaults tightened.
None of the changes are silent — every one of them turns a previously-successful
call into an explicit error, so a broken integration announces itself rather
than degrading.

Budget an hour. The two changes most likely to bite a storefront are the guest
order-read window and the required `actor` argument on catalog reads.

---

## 1. Schema

Two additive migrations. Both are safe to apply before deploying the new code.

**`carts.checkout_claim_token`** — nullable `text`, no backfill.

```sql
ALTER TABLE "carts" ADD COLUMN "checkout_claim_token" text;
```

**better-auth 1.7 columns** — apply `0003_add-better-auth-1-7-columns.sql` from
the example migrations. Every statement is idempotent. `jwks` gains `alg` and
`crv`; the `jwt` plugin is enabled unconditionally, so this affects every
deployment. `user` gains `twoFactorEnabled`, `phoneNumber` and
`phoneNumberVerified`, and the `twoFactor` table is declared — those are
config-gated and latent until you enable two-factor or phone auth.

If you use `pushSchema()` rather than migration files, both are applied for you.

Carts sitting in `checking_out` at deploy time have no claim token. They will
not be released by a failing checkout — abandon or reset any that are stuck.

---

## 2. `Actor.userId` is now `string | null`

The single most invasive type change. An actor with no user identity — an API
key with no operator, a store resolver serving an anonymous visitor — now
carries `null` rather than the empty string.

If you key a per-person resource on it, handle the absent case:

```ts
import { requireUserId } from "@porulle/core";

// Before — every keyless API key looked like the same person
const operatorId = actor.userId;

// After — refuses an absent identity instead of returning one that reads as a person
const operatorId = requireUserId(actor);
```

Grep your codebase for `actor.userId` and `.userId` on anything actor-shaped.
TypeScript will find most of them; the ones it will not are `as` casts and
`Record<string, unknown>` bags.

---

## 3. Catalog reads require an explicit `actor`

`catalog.list`, `catalog.getById` and `catalog.getBySlug` take `actor` as a
required argument, and `options` must be passed explicitly when absent.

```ts
// Before
await catalog.getById(id);

// After — pass null to mean "anonymous, deliberately"
await catalog.getById(id, undefined, null);
```

Omitting it previously meant "anonymous storefront-filtered" by accident. Now
you say which you meant. Anonymous storefront reads keep working; you just
declare them.

Reads also need a scope. An unauthenticated visitor resolved through
`storeResolver` receives the customer permission set, which includes
`catalog:read`, so public storefronts are unaffected. **If you trim
`auth.customerPermissions`, keep `catalog:read` in it** or every public catalog
read returns 401.

Unpublished catalog reads need `catalog:read:unpublished` explicitly — a
staff-shaped role name or `catalog:update` no longer implies it. The default
`manager` role has it.

---

## 4. Guest order reads expire after seven days

**The change most likely to surprise a storefront.** A cart secret used to read
its placed order for as long as the cart row existed. It is now bounded to a
window after the order was placed, defaulting to seven days.

Affects `GET /api/orders/:id` and every document route that authorizes through
it — invoice HTML, invoice PDF, receipt, invoice email. Past the window a guest
bearer receives 403.

Authenticated customers are unaffected. Account ownership grants access and the
window never applies to it.

If your storefront lets a guest revisit an order later — an order-status page
linked from a shipping email, say — widen it:

```ts
import { windowedGuestOrderAccess } from "@porulle/core";

export default defineConfig({
  orders: {
    guestAccessStrategy: windowedGuestOrderAccess("30d"),
  },
});
```

The window is anchored on the order's `placed_at`, not on the cart, so checking
out on the sixth day of a seven-day cart still leaves a full week.

Replace the policy entirely by implementing `GuestOrderAccessStrategy`:

```ts
import type { GuestOrderAccessStrategy } from "@porulle/core";

const businessHoursOnly: GuestOrderAccessStrategy = {
  canAccessOrder(order, now) {
    return now.getTime() - order.placedAt.getTime() <= 86_400_000;
  },
};
```

A malformed window string throws at boot rather than being read as unbounded,
so `windowedGuestOrderAccess("7 days")` fails fast. Use `7d`, `2h`, `30m`, `45s`.

---

## 5. Invoice email goes to the order, not to the request

`POST /api/orders/:id/invoice/email` resolves the recipient from the order's
customer profile. A caller-supplied `to` is honoured only for an actor holding
organization-wide `orders:read`; a self-service or guest caller may pass one
only when it matches the address already on the order.

An order with no address of its own — a guest checkout with no customer profile
— cannot be emailed at all. Render it instead; the PDF, HTML and receipt routes
are unchanged and take no destination.

If you offer a "email this invoice to someone else" feature, route it through a
staff-permissioned actor.

---

## 6. Membership changes go through `/api/admin/staff`

These Better Auth endpoints now return 403 pointing at the admin staff routes:

| Refused | Use instead |
| --- | --- |
| `POST /api/auth/organization/invite-member` | `POST /api/admin/staff/invitations` |
| `POST /api/auth/organization/update-member-role` | `PATCH /api/admin/staff/:id` |
| `POST /api/auth/organization/remove-member` | `DELETE /api/admin/staff/:id` |
| `POST /api/auth/organization/leave` | `DELETE /api/admin/staff/:id` |
| `create-role` / `update-role` / `delete-role` | roles are configured in `auth.roles` |

`accept-invitation` stays available. Reads, `set-active`, and invitation
reject/get are untouched.

The admin staff routes enforce permission containment, the role rank floor, and
the last-owner invariant, which the plugin's own writers do not. Having one
membership surface is the point.

**Role strings must be single roles.** A comma-separated composite such as
`"owner,admin"` is refused wherever a role is accepted.

---

## 7. Role grants require containment

Granting a role now requires already holding every permission that role carries,
plus outranking or equalling it. A custom role that could previously grant a peer
custom role can no longer grant one whose permissions are not a subset of its own.

Invitations are deferred grants and run the same checks — **at creation and
again at acceptance**. An invitation confers a role only while the member who
sent it can still grant it. Pending invitations whose inviter has since lost that
authority are refused and marked `canceled` on the next acceptance attempt.
Re-issue them from an account that currently holds the authority.

Audit your custom roles before upgrading:

```ts
// This can no longer grant `warehouse_lead` unless it holds every
// permission `warehouse_lead` carries.
roles: {
  shift_lead: { permissions: ["staff:manage", "orders:read"] },
  warehouse_lead: { permissions: ["staff:manage", "inventory:adjust"] },
}
```

---

## 8. Order attribution follows `orders:read:own`

An actor holding neither `orders:create:on-behalf` nor `orders:read:own` now
creates a **guest order** rather than having a customer profile minted for it.
This previously happened to operators, silently attributing every walk-in sale
to the cashier.

Two things to check:

- A shopper role carrying `orders:create` **without** `orders:read:own` now
  produces guest orders. Grant `orders:read:own` to restore self-attribution.
  This includes any deployment that trims `auth.customerPermissions`, or that
  grants unscoped `orders:read` instead.
- An actor lacking `orders:create:on-behalf` that supplies a `customerId` has it
  **ignored** rather than refused — so a missing scope shows up as lost
  attribution, not an error. Grant the scope where you meant assisted sale.

Every supplied `customerId` must now identify an existing customer in the
caller's organization. Dangling ids, cross-organization ids, and older
integrations that stored an auth user id directly as `customerId` receive a
validation error. Resolve those to the organization's customer profile id first.

---

## 9. Organization resolution refuses rather than guessing

`resolveOrgId` no longer falls back to the deprecated `org_default` constant for
an actor-less request, and no longer consults the boot-time
`auth.defaultOrganizationId` ahead of strict resolution.

- **Single-tenant deployments** that set `auth.defaultOrganizationId` resolve the
  same organization as before. Nothing to do.
- **Multi-tenant deployments** must resolve the organization per request through
  `auth.storeResolver`. An actor-less call with strict resolution on now throws
  `OrgResolutionError` (503 `ORG_RESOLUTION_FAILED`) instead of quietly serving
  one merchant's data.

To stage the change, set `auth.strictOrgResolution: false` or
`STRICT_ORG_RESOLUTION=false` temporarily, then remove it.

---

## 10. Route coverage is asserted at boot

Every route in the production table must be guarded or named in an explicit
allowlist with a written justification. **An unguarded route now fails server
construction** rather than passing an isolated test.

If you add custom routes and the server refuses to boot, that is this check.
Guard the route or add it to the allowlist with a reason.

---

## 11. `claimForCheckout` / `releaseCheckoutClaim` signatures

Only relevant if you call `CartService` directly; the REST checkout route
handles this itself.

```ts
// Before
await cart.claimForCheckout(cartId, ctx);
await cart.releaseCheckoutClaim(cartId, ctx);

// After — the claim belongs to an attempt, and only its holder may release it
await cart.claimForCheckout(cartId, claimToken, ctx);
await cart.releaseCheckoutClaim(cartId, claimToken, ctx);
```

Use any stable per-attempt id as the token; the REST route uses its checkout id.

---

## 12. `@porulle/plugin-pos`: returns require a payment

`POST /api/pos/returns` now requires a `payment` object in the request body. The
refund ledger move and the first payout are recorded in one transaction, so a
return can no longer be abandoned between the ledger and the cash drawer.

Split tender is unchanged — keep using
`POST /api/pos/returns/{id}/payments` for subsequent payouts.

---

## Upgrade checklist

- [ ] Apply both migrations, or run `pushSchema()`.
- [ ] Grep for `actor.userId`; adopt `requireUserId` where an identity is required.
- [ ] Pass `actor` explicitly to `catalog.list` / `getById` / `getBySlug`.
- [ ] Confirm `catalog:read` is still in `auth.customerPermissions`.
- [ ] Grant `catalog:read:unpublished` and `orders:create:on-behalf` where roles relied on them implicitly.
- [ ] Grant `orders:read:own` to shopper roles that should self-attribute orders.
- [ ] Decide the guest order-read window; widen it if your storefront needs longer than seven days.
- [ ] Move any membership writes off the Better Auth organization endpoints.
- [ ] Check custom roles still satisfy containment for the roles they grant.
- [ ] Re-issue pending staff invitations whose inviter has since changed role.
- [ ] Multi-tenant: confirm `auth.storeResolver` covers every actor-less path.
- [ ] Boot the server — route coverage and window parsing fail fast if anything is wrong.
- [ ] POS: add `payment` to your returns call.

## Rolling back

0.13.0 is additive at the schema level, so `0.11.x` runs against a 0.13.0
database. The `checkout_claim_token` column and the better-auth columns are
simply unused by the older code. No down-migration is required.
