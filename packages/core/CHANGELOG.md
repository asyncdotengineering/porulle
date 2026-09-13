# @porulle/core

## 0.25.0

### Minor Changes

- [#106](https://github.com/asyncdotengineering/porulle/pull/106) [`45b8c18`](https://github.com/asyncdotengineering/porulle/commit/45b8c18fa6ab40664794c0e8c7cefb69d60ba69c) Thanks [@octalpixel](https://github.com/octalpixel)! - Address payment webhooks by provider, and let an order be created in a declared initial status.

  > **This is a breaking change shipping as a minor, deliberately.** `@porulle/*` is pre-1.0, and
  > semver reserves 0.x for exactly this: "Major version zero is for initial development. Anything
  > MAY change at any time. The public API SHOULD NOT be considered stable." Going to 1.0.0 would
  > declare the API stable, which is not yet true — further core seams are already planned. Every
  > break is documented below and every caller is migrated in the same cycle.

  **Breaking: `POST /api/payments/webhook` is now `POST /api/payments/webhook/:provider`.**

  The old route resolved `config.payments[0]` — whichever payment adapter happened to be registered
  first — verified the incoming body with it, and recorded the result in `processed_webhook_events`
  under the hardcoded literal `provider: "stripe"`. An application whose only adapter is not Stripe
  therefore had its notifications verified by its own adapter, filed under a gateway it does not use,
  and answered `200`.

  The inert `200` was not the problem. The row had been written, and `event_id` is unique, so a
  delivery to that path consumed the id the application's own webhook route was going to deduplicate
  on: a later, genuine delivery read as a duplicate and was silently skipped.

  _To migrate:_ repoint each gateway's webhook URL from `/api/payments/webhook` to
  `/api/payments/webhook/<providerId>` — `/api/payments/webhook/stripe` for the bundled Stripe
  adapter. The segment must match the adapter's `providerId`; an unregistered provider returns `404`
  and records nothing. There is deliberately no alias for the old path: an alias would preserve
  exactly the ambiguity this change removes.

  `processed_webhook_events.provider` is now taken from the resolved adapter rather than a literal.
  Rows written before this release carry `"stripe"` whatever the adapter actually was, so that
  column's historical values are not a reliable fact about which gateway delivered the event.

  The `payment_intent.succeeded` handling is now explicitly Stripe's, reached only through
  `/api/payments/webhook/stripe`. Another gateway's events are verified and recorded but do not
  transition an order; core does not interpret a vocabulary it does not own.

  **Breaking (types): `StateDefinition` gains a required `initialStates`.**

  Only code that constructs a `StateDefinition` by hand is affected — in practice, an application
  passing a custom `stateMachine` to `OrderService`. Add `initialStates` listing the states an entity
  may be _created_ in. Applications using `orders.customTransitions`, or the default machine, need no
  change.

  **Added: `CreateOrderInput.status`.**

  `orders.create` always started an order at the state machine's initial status, because the status
  was a literal in the service. An application that needs an order to exist before it is paid — any
  hosted-redirect gateway produces one — could only create it in the normal initial status and
  transition immediately, leaving a window in which an unpaid order is indistinguishable from a
  healthy one.

  `status` is optional and validated against `initialStates` — the states an order may _start_ in,
  which is deliberately not `states`: validating against `states` would let a caller create an order
  directly in `fulfilled`, past its whole lifecycle, with no transition recorded and no status-change
  hook fired. Omitting `status` is unchanged behaviour. A status the machine does not declare, and a
  status it declares but not as a starting point, are refused with distinct messages — never silently
  downgraded to the initial status.

  The order's first status-history row now records the status it was actually created in, rather than
  always claiming `pending`.

  **Added: `pending_payment` is a core order state**, with `pending_payment -> confirmed` and
  `pending_payment -> cancelled`, and it is a legal initial state. There is no `expired`: an expiry is
  a cancellation carrying a reason, and `changeStatus` already carries one.

  **Added: `CreatePaymentIntentParams` is exported**, so an adapter author outside core can name the
  argument its own `createPaymentIntent` receives.

## 0.24.1

### Patch Changes

- [#105](https://github.com/asyncdotengineering/porulle/pull/105) [`37c51fe`](https://github.com/asyncdotengineering/porulle/commit/37c51feb3dfad82fd6cf8e63dc18b07ea1b5caf5) Thanks [@octalpixel](https://github.com/octalpixel)! - Let a granted permission win before a plugin route decides the caller's class.

  0.24.0 gave the plugin-route guard the new `isUnauthenticatedActor` test while leaving its original ordering — auth first, then permission — in place. That ordering was correct for as long as the test was `!actor`, and wrong the moment the test began recognising an actor that exists but carries no identity: such a caller was refused `401` before anything read what it was allowed to do.

  **An actor can hold a permission without holding an identity.** A storefront widget posting search signals carries only a publishable key, so it resolves to the anonymous actor the store resolver builds and is authorized by that actor's permissions. Under 0.24.0 that flow answered `401` where it had answered `201`.

  The grant is now read first, which is the order `requirePerm` already used; the caller's class is decided only on a refusal, where it is the question actually being asked. Pinned by a test that fails with `expected 401 to be 200` when the grant check is disabled.

## 0.24.0

### Minor Changes

- [#103](https://github.com/asyncdotengineering/porulle/pull/103) [`6832853`](https://github.com/asyncdotengineering/porulle/commit/6832853d83b02b5ba83c8e4008e4ec36b5e210eb) Thanks [@octalpixel](https://github.com/octalpixel)! - Tell a caller with no credential to authenticate, and let a route declare it needs no identity.

  Two additive authorization seams, shipped together because both are about what an actor means on a request that has no identity.

  **A caller with no credential was told it was personally forbidden.** Once a `storeResolver` is configured, an unauthenticated request no longer arrives without an actor — the middleware sets an anonymous customer actor so the public storefront can read a catalog — and it then reached the permission guard and was refused `403 Permission 'cart:manage' is required.` RFC 9110 §15.5.4 reserves 403 for a refusal that holds whatever credentials accompany the request, and this one does not hold: signing in resolves it. The body also named a permission to a caller with no identity.

  A new `isUnauthenticatedActor` predicate separates _no credential_ from _a credential that lacks the permission_, and the refusal is now `401 UNAUTHORIZED` with no permission named. An **API key keeps its 403**, whatever its `referenceId`: it did present a credential, and telling it to authenticate is advice it cannot act on. The same rule applies in `requirePerm`, `requireAnyPerm`, the plugin router's guard, `assertPermission`, and the customer-cart read, so the three copies of it cannot drift. `CommerceUnauthorizedError` is exported and maps to 401; it deliberately does **not** extend `CommerceForbiddenError`, which would make every `toThrow(CommerceForbiddenError)` unable to tell the two apart.

  The customer portal separates them too, and that clause is load-bearing rather than cosmetic: every route under its guard reads `actor.userId` as a `string`, so an API key with no person is refused `403 The customer portal requires a signed-in user, not an API key.` rather than being let through to a null.

  **`authMiddleware` resolved an actor for every route.** Mounted `app.use("*", …)`, it issued three database statements before any handler, including for routes that read no actor at all — measured on a deployed Worker as 146 ms for `GET /api/health` with no credential against 176 ms with one, purely for an actor the route never consults.

  A route can now declare it needs none. `GET /api/health`, `/api/doc` and `/api/doc-ext` are declared by core, each verified against its handler; an app adds its own with `auth.identityFreeRoutes: ["POST /api/payments/notify"]`. Matching is exact on method and path — no globs, because a glob is how one entry silently widens to cover a route that does need an identity — and config entries are additive and cannot remove a default. **The default is to resolve:** a route that declares nothing keeps its actor, and that direction is pinned by a test rather than assumed.

  One consequence is worth knowing before declaring a route. The wrapper that opens the plugin database scope derives its organization from the resolved actor, so a route with no actor gets no scope, and plugin reads and writes on it run with no organization predicate while the handler still answers normally. Such a route must open its own scope, the way a signed webhook builds its actor from the payload it verified.

## 0.23.0

### Minor Changes

- [#102](https://github.com/asyncdotengineering/porulle/pull/102) [`cf30ee4`](https://github.com/asyncdotengineering/porulle/commit/cf30ee485b8050f393452a1bed7adf3e2bacc558) Thanks [@octalpixel](https://github.com/octalpixel)! - Price a cart line from the pricing step, and refuse the add when it has no answer.

  `cart.addItem` wrote `unitPriceSnapshot: processed.unitPriceSnapshot ?? 1000` — a literal — whenever no `cart.beforeAddItem` hook supplied a price. Nothing in the response, the logs or the schema disclosed that the number was invented, so an integrator could only learn it by comparing a cart against a catalog. One did: a deployed cart reading 1000 against a catalog priced 14500–22800.

  A new line is now priced by `services.pricing.resolve` — the same step `resolveCurrentPrices` uses in the checkout quote — so a cart and its order agree by construction rather than by an integrator remembering to install a hook. Modifiers apply, because they are part of that step and were never part of the literal.

  When no price can be resolved, the add is refused with `Cannot resolve a unit price for <entityId> (<currency>). Configure a price for it, or supply unitPriceSnapshot from a cart.beforeAddItem hook.` A value the system cannot determine is refused rather than substituted; a second literal would be the same defect wearing a different number.

  A `cart.beforeAddItem` hook that supplies `unitPriceSnapshot` still wins, so bespoke pricing keeps its seam, and merging into an existing line still leaves that line's snapshot alone.

  **This changes behaviour for callers who never configured prices**, which is why it is a minor rather than a patch: an add that used to succeed at 1000 now either carries the real price or refuses. Nineteen fixtures in this repository's own suite were adding unpriced entities and passing on the literal; each now configures a price. If you rely on a cart line for an entity with no price row, supply `unitPriceSnapshot` from a hook, or set a base price — including zero, which is a decision, where 1000 was not.

  `test/cart-add-item-pricing.test.ts` pins all three directions: a priced entity with no hook carries its price, an unpriced one is refused with the price named, and a hook still overrides.

## 0.22.0

### Minor Changes

- [#101](https://github.com/asyncdotengineering/porulle/pull/101) [`0a719cd`](https://github.com/asyncdotengineering/porulle/commit/0a719cd9cbf6836f513b642e566e82d16ea3e97c) Thanks [@octalpixel](https://github.com/octalpixel)! - Resolve an actor's organization membership with one indexed read instead of the organization plugin's endpoints.

  `resolveActor` discovered a caller's role by calling `getFullOrganization` — which loads the organization row, its invitations and its entire member list, then scans in JavaScript for a single membership — and then `getActiveMemberRole`, which looks for the same membership again. Both take `headers` and re-resolve the session from them, so each also re-read `session` and `user`, and the plugin wrote `active_organization_id` back to the session row on every request, putting a write on the hot path of every GET.

  For a shopper every one of those lookups is a guaranteed miss: a shopper is not a member of the platform organization and never will be. The member-by-organization scan also grew with the member list, so the busiest request on the platform got slower as the platform got bigger.

  Membership is now read once, directly, by `(user_id, organization_id)`. An authenticated request costs three statements where it cost around a dozen, and resolving an actor no longer writes.

  The `Actor` shape, the `resolveActor` signature and all permission semantics are unchanged, `sessionCreatedAt` included. `test/auth-resolve-actor-query-count.test.ts` pins the counts per table so a future change cannot trade one wasteful read for another and keep the total looking healthy.

## 0.21.0

### Minor Changes

- [#100](https://github.com/asyncdotengineering/porulle/pull/100) [`f6d69fb`](https://github.com/asyncdotengineering/porulle/commit/f6d69fbe64165b2e9a6bd892ba433f69273f8dee) Thanks [@octalpixel](https://github.com/octalpixel)! - Step-up re-authentication: a typed refusal and the session's authentication time on the actor.

  An app can now require that a caller authenticated _recently_, not merely that it is
  authenticated, and say so in a way a client can act on.

  - `CommerceReauthRequiredError` carries `code: "REAUTH_REQUIRED"` and maps to **401**.
    It exists because the alternatives are all lossy: returning `Err` lets each route
    translate the refusal into its own status (a customer-portal address write becomes
    422, a delete becomes 404 — "that address does not exist"), an unrecognised
    `CommerceError` code falls through to 500, and an `HTTPException(401)` has its body
    rebuilt as `UNAUTHORIZED` with the message scrubbed in production. Discriminate on
    the code, never the message.
  - `Actor.sessionCreatedAt` is the `createdAt` of the Better Auth session behind the
    actor, as an ISO string, set by `resolveActor` from the session it already fetches.
    A guard that needs the authentication time no longer has to resolve the session a
    second time, which on a serverless database is a second round trip per guarded call.

  `sessionCreatedAt` is **optional** on `Actor`, deliberately. Making it required is the
  louder design and was tried first: it produced 96 type errors across roughly fifty
  hand-built actor literals, every one of which would have written `null`. That is noise
  that proves nothing, so the field is optional and absence carries the meaning. A guard
  must read an absent value as **"cannot establish, refuse"** and never as "recent" —
  an API key, a store resolver and a hand-built test actor all legitimately have no
  session. `createSystemActor` states `sessionCreatedAt: null` explicitly rather than
  omitting it, so the one constructed identity in the package that runs privileged work
  says out loud that it proved nothing to anybody.

## 0.20.3

### Patch Changes

- [#99](https://github.com/asyncdotengineering/porulle/pull/99) [`17f743c`](https://github.com/asyncdotengineering/porulle/commit/17f743c2c4a7c08f111561748d140f84c214a60d) Thanks [@octalpixel](https://github.com/octalpixel)! - **Behaviour change, shipped as a patch because it is a defect in what the session already promised.** Sign-out now invalidates on the very next request.

  `session.cookieCache` was enabled with a five-minute `maxAge`, which made the signed `uc.session_data` cookie a second source of truth for session liveness. A revoked session therefore kept authorizing every route that resolves an actor, and kept `get-session` answering with the user, for up to five minutes after sign-out. The cache is removed: liveness is read from the session table, which is the only place a session is revoked.

  **What a consumer loses:** the cached read. Every request that resolves an actor now performs one indexed read of the session table, as does `get-session`. For scale, the cached baseline on a deployed Cloudflare Worker over Hyperdrive → Neon was `get-session` p50 134 ms / p95 157 ms (n = 20, warm), on a route whose cost is dominated by the round trip rather than by the read this adds. There is no configuration option to restore the cache; if one is added, `resolveActor` must pass `query.disableCookieCache` so authorization keeps reading the table.

## 0.20.2

### Patch Changes

- [#98](https://github.com/asyncdotengineering/porulle/pull/98) [`ad671d2`](https://github.com/asyncdotengineering/porulle/commit/ad671d223368be15e1517917527dc2aa9c0f105e) Thanks [@octalpixel](https://github.com/octalpixel)! - `catalog.list` accepts `filter.sourceStoreIds` and narrows the result to entities imported by those connected stores, in the repository query so pagination and totals stay exact; an empty list matches nothing. Lets an app confine a shared-organization catalog list to the stores an actor owns.

## 0.20.1

### Patch Changes

- [#97](https://github.com/asyncdotengineering/porulle/pull/97) [`8ba7ebf`](https://github.com/asyncdotengineering/porulle/commit/8ba7ebfe90286c9bbc07651458c596aaa004b070) Thanks [@octalpixel](https://github.com/octalpixel)! - A join-then-where chain could replace the pre-applied organization predicate with the caller's condition.
  A scoped handle now keeps its organization predicate through every fluent method.

## 0.20.0

### Minor Changes

- [#96](https://github.com/asyncdotengineering/porulle/pull/96) [`e99bf87`](https://github.com/asyncdotengineering/porulle/commit/e99bf873d09fcb00bae42845b04f23e126e1293c) Thanks [@octalpixel](https://github.com/octalpixel)! - Apps can support hosted payment redirects, declare custom route access, and use wildcard permissions consistently.

## 0.19.0

### Minor Changes

- [#95](https://github.com/asyncdotengineering/porulle/pull/95) [`d98a0cf`](https://github.com/asyncdotengineering/porulle/commit/d98a0cf04578f4c89a758a3544a5a7bc99e9444c) Thanks [@octalpixel](https://github.com/octalpixel)! - Routes can declare what they return. `RouteChain.output(schema)` fills the `data` slot of the success envelope in the generated OpenAPI document, so `openapi-typescript` emits a real type instead of `data?: unknown` for every route in the app. Routes that do not call it generate exactly what they generated before. The schema documents the response; it does not validate the handler's return.

## 0.18.0

### Minor Changes

- [#94](https://github.com/asyncdotengineering/porulle/pull/94) [`7ca0da4`](https://github.com/asyncdotengineering/porulle/commit/7ca0da4237e05f890d403397d839eccc27bb5900) Thanks [@octalpixel](https://github.com/octalpixel)! - `@porulle/jobs-cloudflare` is now production-ready for Cloudflare Workflows:

  - `TaskContext.step` gives a task handler durable, per-phase execution (`do`/`sleep`). A task that sets the new `TaskDefinition.durableSteps: true` runs in the Workflow body and the Cloudflare engine backs `ctx.step` with the Workflow's own top-level steps (named `porulle:<slug>:<name>`, each with its own retries and timeout) instead of retrying the whole handler as one unit; other tasks keep the single retried step and get a pass-through `ctx.step`, as does every task on the drizzle engine, so a handler written against `ctx.step` runs unchanged on both. Retry counts now follow Porulle's `attempts` (Cloudflare's `limit` is `attempts - 1`).
  - `TaskNonRetryableError` (new in `@porulle/core`, also exported from the new leaf entry `@porulle/core/jobs`) lets a handler or step refuse a retry outright. The Cloudflare engine rethrows it inside the step as the `NonRetryableError` class the Worker passes in through the new required `nonRetryableError` option; the drizzle runner fails the job immediately, ignoring remaining attempts.
  - `DurableObjectConcurrencyCoordinator` and the `porulleJobCoordinator(DurableObject)` Durable Object mixin give Cloudflare Workflows a real coordinator for keyed tasks: `supersedes` terminates pending same-key instances at enqueue, and `exclusive` serializes same-key instances through the Durable Object, parking a losing instance with `step.waitForEvent` until its turn.
  - `adaptWorkflowBinding(env.PORULLE_WORKFLOW)` wraps the real binding, folding Cloudflare's instance status onto `JobInstanceStatus`.
  - `CloudflareExecutionEngine.status`/`.cancel` (and the matching optional `JobsAdapter.status`/`.cancel`, implemented by the drizzle adapter) report an instance's state and terminate it.
  - `EnqueueOptions.jobId` is used verbatim as the job id — the Workflow instance id on Cloudflare, the `commerce_jobs` row id on the drizzle engine — so a caller can address the job it created ("one generation, one instance").
  - `DrizzleJobsAdapter.cancel` marks a pending row `cancelled` (a new `commerce_jobs.status` value) instead of deleting it, so `status()` reports it as `terminated`.

  Breaking for implementers of this package's interfaces (0.x): `CloudflareExecutionEngineOptions.nonRetryableError` is required; `WorkflowBinding.get`, `WorkflowStep.waitForEvent` and `CloudflareJobPayload.jobId` are now required; `CloudflareConcurrencyCoordinator.run` takes `(payload, step, handler)` instead of `(key, handler)`. Apps that only consume `CloudflareExecutionEngine` with the real bindings need to add the `nonRetryableError` option.

## 0.17.0

### Minor Changes

- [#93](https://github.com/asyncdotengineering/porulle/pull/93) [`4bc5a61`](https://github.com/asyncdotengineering/porulle/commit/4bc5a6137a01a2f221c4d1ba0c8d22d7e80b7f56) Thanks [@octalpixel](https://github.com/octalpixel)! - Write product images on Shopify catalog push.

  `pushCatalog` refused any item carrying `images` with
  `SHOPIFY_IMAGES_NOT_WRITTEN`, so media attached through `MediaService` could
  never reach the Shopify product. The adapter now creates or updates product
  images through the Admin REST API: the `primary` image is written first at
  position 1, the rest follow `sortOrder`, `alt` and `variantExternalIds` map to
  `alt` and `variant_ids`, and `video` / `document` roles fail the item with
  `SHOPIFY_IMAGE_ROLE_UNSUPPORTED`.

  `ChannelPushCatalogItemOutcome` gains `images?: ChannelPushCatalogImageOutcome[]`
  — one entry per image with `ok`, the Shopify image id as `externalId`, and the
  error when a write failed. Persist that id and send it back as
  `image.externalId` to update in place; without it the adapter matches by the
  uploaded file name against Shopify's CDN path before creating a new image.

  Callers that treated `SHOPIFY_IMAGES_NOT_WRITTEN` as the signal to fall back to
  a manual upload should read the per-image outcomes instead.

## 0.16.0

### Minor Changes

- [`983bc69`](https://github.com/asyncdotengineering/porulle/commit/983bc696af361445cf5d19b4d69b1a9f4a25fb83) Thanks [@octalpixel](https://github.com/octalpixel)! - Stop reporting a failed auth check as a rejected credential.

  `authMiddleware` wrapped `getSession` and `verifyApiKey` in bare catches and
  fell through to anonymous. A credential better-auth rejected and a check that
  could not run were both answered `401 "Authentication required."` and logged
  nowhere, so a fault in the auth stack presented as the caller's credential
  being wrong.

  A rejection (`APIError`, matched structurally so it survives two better-auth
  copies in one tree) still falls through to anonymous, unchanged. Anything else
  is logged at `error` with the stage, path, and method, then propagates as a 500.

  If a route starts returning 500 after this upgrade, it was already broken — the
  log line names the fault. See `docs/migration-0.15-to-0.16.md`.

## 0.15.0

### Minor Changes

- [`dd59c5c`](https://github.com/asyncdotengineering/porulle/commit/dd59c5cd0d456d90b0cfb0af6b744a2520dc8f57) Thanks [@octalpixel](https://github.com/octalpixel)! - Give `config.routes` a tenant-scoped database handle.

  `config.routes` receives the kernel, and `kernel.database.db` is unscoped — nothing resolves an organization and nothing warned. It is the simplest way to add an endpoint, so it was the easiest place to write a query that silently reads every tenant's rows.

  The handle passed to `config.routes` now carries both:

  ```ts
  routes: (app, kernel) => {
    app.get("/api/reviews", async (c) => {
      // Scoped: constrained to the request's organization, even with no WHERE.
      const rows = await kernel.database.scoped.select().from(reviews);
      return c.json({ data: rows });
    });
  };
  ```

  `kernel.database.db` is **unchanged** and still returns the raw handle, so no existing behaviour moves — but accessing it now emits a rate-limited warning naming `scoped`. Reach for it deliberately when you need cross-organization access, and filter by `organizationId` yourself.

  Note that raw `db.execute()` is never tenant-scoped on either handle: the scoping proxy wraps `select`, `insert`, `update` and `delete`, and cannot inject a predicate into arbitrary SQL.

## 0.14.0

### Minor Changes

- [`3f1de20`](https://github.com/asyncdotengineering/porulle/commit/3f1de204f0ebb07f634fe702ddc8a6f1d6fd7f22) Thanks [@octalpixel](https://github.com/octalpixel)! - Let `pgSearchAdapter` use the configured database instead of requiring a second connection.

  `PgSearchAdapterOptions.query` was required, so every consumer hand-wired raw SQL execution — typically by opening a second pool against the database porulle was already connected to.

  `SearchAdapter` gains an optional `init?(deps: { db })` hook, called by the search module when it wires the adapter, and `pgSearchAdapter()` now takes no required argument:

  ```ts
  search: {
    adapter: pgSearchAdapter();
  }
  ```

  A supplied `query` callback still takes precedence and is never overwritten by `init`, so pointing search at a separate database remains possible. Adapters that do not define `init` — including the meilisearch adapter — are unaffected.

- [`0583eab`](https://github.com/asyncdotengineering/porulle/commit/0583eab02f80869f3aba3fdc2ae847712cbd6959) Thanks [@octalpixel](https://github.com/octalpixel)! - Refuse to construct a server when no request could resolve an organization.

  Strict organization resolution fails closed by default. A deployment configuring neither `auth.defaultOrganizationId` nor `auth.storeResolver` previously booted cleanly and then returned 503 `ORG_RESOLUTION_FAILED` on the first actor-less request — in production, on a path an operator may not exercise until a real visitor does.

  `createServer` now refuses at construction, naming both remedies and the opt-out. An empty or whitespace-only `defaultOrganizationId` counts as absent, since that is what an unset environment variable produces.

  **Breaking:** a deployment relying on the permissive fallback will now fail to start rather than fail per-request. Set `auth.defaultOrganizationId` for single-tenant, `auth.storeResolver` for multi-tenant, or `auth.strictOrgResolution: false` (or `STRICT_ORG_RESOLUTION=false`) to keep the previous behaviour during a migration.

- [`f476b2c`](https://github.com/asyncdotengineering/porulle/commit/f476b2c2687dc4bed24de65a1ab1abdf08853066) Thanks [@octalpixel](https://github.com/octalpixel)! - Export `resolveActor`, so code outside the request pipeline can resolve a porulle `Actor` from request headers.

  Going from a better-auth session to an `Actor` — organization resolved, permissions resolved — was reachable only from inside `authMiddleware`. A server function, a script, or a job had to re-derive it by hand.

  That mapping is now `auth/actor.ts` and is exported. `authMiddleware` calls the same function, so the two paths cannot drift:

  ```ts
  import { resolveActor } from "@porulle/core";

  const actor = await resolveActor(request.headers, auth, config);
  if (!actor) return redirectToSignIn();
  ```

  Returns `null` for an absent, malformed or expired session rather than throwing — "signed out" is an ordinary answer. `AUTH_COOKIE_PREFIX` and `SESSION_COOKIE_NAME` are exported alongside it for consumers managing the cookie themselves.

  Note that resolving a _session_ needs no porulle helper: better-auth already provides `auth.api.getSession({ headers })` in-process and `createAuthClient` from `better-auth/client` for a separate frontend. The documentation now points at both.

- [`32136d4`](https://github.com/asyncdotengineering/porulle/commit/32136d49df43995e167e1198d1b768976e1eb85f) Thanks [@octalpixel](https://github.com/octalpixel)! - Give session reads their own rate-limit budget, separate from the credential endpoints.

  `GET /api/auth/get-session` previously shared the `/api/auth/*` bucket with sign-in, so an app resolving the session per navigation exhausted a 10-per-minute budget in ten screens. The call then returned 429, and a client treating any non-ok response as "no session" signed the operator out.

  Session reads now use `config.rateLimits.session`, defaulting to 120 per minute, and are skipped by the shared limiter so a single request is never counted twice. `rateLimits.auth` and `rateLimits.signInPerEmail` are unchanged — the per-email sign-in limit is the credential control and stays where it is.

  Widen or tighten it like any other limit:

  ```ts
  rateLimits: {
    session: 300;
  }
  ```

## 0.13.0

### Minor Changes

- [`98e75bb`](https://github.com/asyncdotengineering/porulle/commit/98e75bb0222d9079589d97dca74de0f0dda4e12c) Thanks [@octalpixel](https://github.com/octalpixel)! - Harden the catalog read path and make the class of defect it belonged to structurally harder to reintroduce.

  **Three changes matter more than any individual fix.**

  Route coverage is asserted at server construction. Every route in the production table must be either guarded or named in an explicit allowlist with a written justification, so an unguarded route fails startup instead of passing an isolated test. The previous guard did not cover `/api/me`.

  Organization resolution refuses rather than guessing. `resolveOrgId` previously fell back to the deprecated `org_default` constant for any request with no actor. It now throws instead. Note the precise scope: a configured `auth.defaultOrganizationId` is still consulted first and still answers, which is correct for a single-tenant deployment. Deployments that set `auth.defaultOrganizationId` therefore resolve the same organization as before; the improvement is that resolution no longer depends on exported mutable module state. Deployments that set no default now genuinely refuse actor-less resolution. Set `auth.strictOrgResolution: false` (or `STRICT_ORG_RESOLUTION=false`) to restore the previous permissive behaviour during a migration.

  Guest identity is a positive credential rather than an absence. A guest cart carries a secret that must be presented to read it, an actor with no user identity carries `null` instead of a shared placeholder, and internal service reads use explicit `getByIdForInternalUse` paths rather than impersonating the caller.

  **Breaking for consumers.**

  `Actor.userId` is now `string | null`. Any code that keys a per-person resource on it — an `operatorId`, a `requestedBy`, a `purchaserId` — must handle the absent case. Use the new `requireUserId(actor)` export, which refuses a null or blank identity rather than returning one that reads as a person. An API key that carries neither an operator nor a reference now has no user identity at all; previously it carried the empty string, which every such key shared.

  `catalog.list` and `catalog.getById` apply the storefront visibility policy: a caller without `catalog:update` sees only entities that are `active` and visible. Service-layer calls that previously omitted an actor and received drafts must now pass the actor they are acting for. `catalog.getAttributes` takes an `actor` argument and asserts `catalog:read`.

  Order creation validates line-item entities through an internal organization-scoped read, so an operator can still sell an unpublished product, while an unprivileged buyer cannot. The refusal is indistinguishable from a not-in-organization refusal, so nothing new is discoverable.

- [`4f9e5b9`](https://github.com/asyncdotengineering/porulle/commit/4f9e5b939b72849b943de6fe2d2751dac8d6caba) Thanks [@octalpixel](https://github.com/octalpixel)! - Bound a guest's order read to a window after the order is placed.

  A cart secret previously read its placed order for as long as the cart row existed. Guest access is now decided by `config.orders.guestAccessStrategy`, defaulting to `windowedGuestOrderAccess("7d")` and anchored on the order's `placed_at` — so checking out on the sixth day of a seven-day cart still leaves a full week of receipt access. Authenticated customers are unaffected: account ownership grants access and the window never applies to it.

  `windowedGuestOrderAccess`, `defaultGuestOrderAccess`, `parseAccessWindow` and the `GuestOrderAccessStrategy` type are exported for adopters who want a different policy. A malformed window throws at configuration time rather than being treated as unbounded.

  **Breaking:** a guest presenting a cart secret more than seven days after placement now receives 403 where it previously received 200. This covers `GET /api/orders/:id` and the document routes that authorize through it — invoice HTML, invoice PDF, receipt, and invoice email. Widen it if your storefront needs longer:

  ```ts
  import { windowedGuestOrderAccess } from "@porulle/core";

  orders: {
    guestAccessStrategy: windowedGuestOrderAccess("30d");
  }
  ```

- [`cf611f9`](https://github.com/asyncdotengineering/porulle/commit/cf611f9f6b21a4dd3eaee7e3cab8c9f7d2faf431) Thanks [@octalpixel](https://github.com/octalpixel)! - Replace implicit role and write-permission authorization with explicit permissions for unpublished catalog reads and assisted order customer attribution.

  Merchants whose custom roles relied on `catalog:update` or a staff-shaped role name must grant `catalog:read:unpublished` and/or `orders:create:on-behalf` explicitly. The default `manager` role receives both scopes; `customer` receives neither.

  This release also tightens `customerId` validation for on-behalf order creation. Every supplied customer ID must now identify an existing customer in the caller's organization; dangling IDs, cross-organization IDs, and older integrations that stored an auth user ID directly as `customerId` now receive a validation error. Those integrations must resolve or migrate the value to the organization's customer profile ID before creating orders.

  Self-attribution at order creation now follows `orders:read:own`. An actor that holds neither `orders:create:on-behalf` nor `orders:read:own` creates a **guest order** rather than having a customer profile minted for it — which is what previously happened to operators, silently attributing every walk-in sale to the cashier. Two consequences to check before upgrading. A custom shopper role carrying `orders:create` without `orders:read:own` — including any deployment that trims `auth.customerPermissions`, or grants unscoped `orders:read` instead — now produces guest orders where it previously self-attributed; grant `orders:read:own` to restore it. And an actor lacking `orders:create:on-behalf` that supplies a `customerId` has it ignored rather than refused, so a missing scope shows up as lost attribution rather than an error.

  This is a proxy and it is deliberately a stopgap: the honest discriminator is caller intent, which a storefront route knows and the order service cannot see. It is recorded here rather than left implicit because a change whose whole thesis is replacing implicit permission semantics should not ship a new one silently.

- [`7688ce2`](https://github.com/asyncdotengineering/porulle/commit/7688ce2eb4e1eea74a9ec0bfab90cdb74078bcc6) Thanks [@octalpixel](https://github.com/octalpixel)! - Make `actor` a required argument on `catalog.list`, `catalog.getById`, and `catalog.getBySlug`.

  **Breaking for consumers** calling these methods directly: `actor` is now required (pass `null` to mean anonymous deliberately), and `options` must be passed explicitly as `undefined` when absent.

  Previously, omitting `actor` silently treated the read as anonymous storefront-filtered. Callers must now pass the actor they are acting for, or `null` when anonymous access is intentional.

- [`bc5c825`](https://github.com/asyncdotengineering/porulle/commit/bc5c825919d3f0cbbf4849cdefb72b61c430fb0d) Thanks [@octalpixel](https://github.com/octalpixel)! - Replace custom-role grant checks with permission containment, so granting a role requires already holding every permission that role carries (including `*:*`). Invitations are deferred grants, so they now use the same containment and rank checks as immediate role changes.

  Restore the rank floor for new-role grants, so a grant must satisfy both containment and rank. `owner` becomes unreachable for every role below it: an `admin` can no longer grant `owner`, and neither can a custom role carrying `*:*`. A custom `*:*` role still _can_ grant `admin`, because it is floored at admin rank deliberately — that floor is what stops a lesser role revoking it — and granting `admin` hands out nothing the minter does not already hold. API-key actors regain grant ability based on their stamped permission list rather than their `api_key` role name, which limits them to contained custom roles at their own rank.

  **Breaking:** a custom role that could previously grant a peer custom role can no longer grant one whose permissions are not a subset of its own.

- [`d6f27f6`](https://github.com/asyncdotengineering/porulle/commit/d6f27f6b24cb0de70b77529f81d0677d0b235a5f) Thanks [@octalpixel](https://github.com/octalpixel)! - **Breaking:** `resolveOrgId` no longer consults the boot-time `auth.defaultOrganizationId` before strict resolution. An actor-less call with strict org resolution enabled now throws `OrgResolutionError` where it previously resolved to the configured default organization.

  Explicit `defaultOrgId` arguments and actor `organizationId` are unchanged. Set `auth.strictOrgResolution: false` or `STRICT_ORG_RESOLUTION=false` to restore the previous behaviour where the boot default answers actor-less calls.

  `resolveOrgIdForCommerce(actor, config)` is the sanctioned migration path for callers that hold `CommerceConfig`. Hand-built `HookContext` values should thread `commerceConfig`; without it, an orgless actor throws under strict resolution.

  Published plugin packages now use the same config-aware organization resolution, including checkout hooks and plugin routes, so upgrading core and these plugins together preserves actor-less requests on deployments that declare a default organization.

### Patch Changes

- [`6cfb51d`](https://github.com/asyncdotengineering/porulle/commit/6cfb51debf27bb2f9bac26320d95414bf3443905) Thanks [@octalpixel](https://github.com/octalpixel)! - Declare every column better-auth 1.7 writes, and make the parity guard actually derive its scope from better-auth instead of a hand-written list.

  Email/password sign-up returned 500 on a clean install against better-auth 1.7. `account.issuer` was fixed in the previous release. The next call then failed the same way on `jwks.alg`, which was still missing — better-auth validates its field map against the Drizzle schema object and throws before reaching the database, so the auth route is non-functional rather than degraded.

  `jwks` gains `alg` and `crv`. The `jwt` plugin is enabled unconditionally, so this affected every deployment. `user` gains `twoFactorEnabled`, `phoneNumber` and `phoneNumberVerified`, and the `twoFactor` table is declared; those plugins are config-gated, so the columns were latent until a merchant enabled two-factor or phone auth. Deployments using the example migrations should apply `0003_add-better-auth-1-7-columns.sql`; every statement is idempotent.

  **The guard is the real fix.** `auth-schema-guard.ts` existed to stop exactly this, and missed it twice. It passed `plugins: []` under a comment claiming it mirrored the plugins `createAuth` enables, so `getAuthTables()` never reported a single plugin-contributed table. It then walked a hand-maintained list of four model names — the four whose columns had already been repaired. It now passes the maximal plugin set and iterates every model better-auth reports, resolving Drizzle tables by their declared model name. A column added by any enabled plugin now fails the build.

- [`8c2c116`](https://github.com/asyncdotengineering/porulle/commit/8c2c1160acf87b981b3be8606918cde057fed833) Thanks [@octalpixel](https://github.com/octalpixel)! - Scope a cart's checkout claim to the attempt that holds it.

  `carts` gains a nullable `checkout_claim_token` column recording which checkout attempt claimed the cart. `CartService.claimForCheckout(cartId, claimToken, ctx?)` and `CartService.releaseCheckoutClaim(cartId, claimToken, ctx?)` both take the token, and releasing only succeeds for the holder. A shopper whose own checkout fails still gets their cart back and can retry.

  **Breaking** for direct callers of those two service methods: both signatures gain a required `claimToken` argument before the optional transaction context. The REST checkout route is unaffected — it passes the checkout id automatically.

  **Migration:** the new column is nullable and applied by `pushSchema`; no data migration is required.

- [`5ee7ae3`](https://github.com/asyncdotengineering/porulle/commit/5ee7ae3628acb29ea56738423c8cfe5e10d26182) Thanks [@octalpixel](https://github.com/octalpixel)! - Re-check an inviter's authority when a staff invitation is accepted.

  Permission containment and the role rank floor were previously evaluated only when an invitation was created. They now run again at acceptance against the inviter's current membership, so an invitation confers a role only while the member who sent it can still grant that role. Changing or revoking a member's role additionally cancels the pending invitations their new role could not issue.

  The grant arithmetic moved to `auth/role-authority.ts` so the admin staff routes and the organization endpoints resolve it identically. Two consequences: a comma-separated composite role string (`"owner,admin"`) is refused wherever a role is accepted, and owner counting reads every part of a role string, matching how the auth layer interprets it.

  **Migration:** deployments holding pending invitations should expect any whose inviter no longer holds the necessary authority to be refused and marked `canceled` on the next acceptance attempt. Re-issue them from an account that currently holds it.

- [`0948324`](https://github.com/asyncdotengineering/porulle/commit/0948324c22f1468dfeb73707f6f77d182bc58494) Thanks [@octalpixel](https://github.com/octalpixel)! - Resolve an invoice email's recipient from the order rather than the request.

  `DocumentsService.emailInvoice` now sends to the address on the order — its customer profile's email. A caller-supplied `to` is honoured only for an actor holding organization-wide `orders:read`; a self-service or guest caller may pass one only when it matches the order's own address. An order with no address of its own cannot be emailed. Rendering the invoice or receipt is unchanged.

  **Breaking:** a non-staff caller naming a different recipient now receives 403 where the request previously succeeded. Storefronts that let a shopper forward their own invoice to an arbitrary address must route that through a staff-permissioned actor. The PDF, HTML and receipt routes take no destination and are unaffected.

- [`54bf6cf`](https://github.com/asyncdotengineering/porulle/commit/54bf6cfcb5f45b46cecdd9a1568a104ae647817c) Thanks [@octalpixel](https://github.com/octalpixel)! - Make the last-owner guard atomic on the staff revoke and demote paths.

  Both handlers now read the organization's membership with `SELECT … FOR UPDATE` inside the transaction that performs the write, ordered by id so concurrent membership writes take the same lock order. Concurrent requests are serialised and the second is refused with the existing 422, so an organization cannot be left without an owner.

  No schema-level constraint backs this. "At least one row in a group" is not expressible as a check or partial-unique constraint; only a trigger could enforce it, and this schema has none. The lock is held at the single place both mutations pass through instead.

  Membership mutations are serialised per organization for the duration of the write. They are infrequent administrative operations, so the contention cost is negligible.

- [`f36de3a`](https://github.com/asyncdotengineering/porulle/commit/f36de3a4524c67eb79badeeb2a33f3502c75bf18) Thanks [@octalpixel](https://github.com/octalpixel)! - Make `/api/admin/staff` the only membership-writing surface.

  Better Auth's organization plugin exposes a parallel set of membership writers that do not run this framework's permission containment, role rank floor, or last-owner invariant, and accept role strings the admin staff routes refuse. `invite-member`, `update-member-role`, `remove-member`, `leave`, `create-role`, `update-role` and `delete-role` under `/api/auth/organization/` now return 403 pointing at `/api/admin/staff`.

  `accept-invitation` stays available and is governed by the acceptance check shipped alongside this. All other organization endpoints — reads, `set-active`, invitation reject and get — are untouched.

  The `organization({ roles })` configuration in `auth/setup.ts` is deliberately unchanged. This framework does not use Better Auth's access-control model; `admin/staff.ts` owns membership and `auth/role-authority.ts` holds the arithmetic. Supplying the plugin real `Role` objects would introduce a second permission model to keep in agreement with the first.

  **Breaking:** callers using Better Auth's organization endpoints to change membership must move to `/api/admin/staff`. Self-service `leave` is included; no REST route exposed it, and the plugin's version did not honour the last-owner invariant.

## 0.12.0

### Minor Changes

- Fix six defects reported by an adopter integrating the published packages.

  **Catalog read endpoints now require `catalog:read`.** An unauthenticated caller could read any catalog entity by id and receive the full record, including `organizationId` and including entities in `draft` with `isVisible: false` — cross-tenant disclosure of unpublished merchant data in the documented one-organization-per-merchant posture. Entity, category and brand reads are guarded, and entity-by-id lookups are organization-scoped so an authenticated caller cannot read another organization's record either. Storefronts are unaffected: an anonymous visitor resolved through `storeResolver` receives the customer permission set, which grants `catalog:read`. That coupling is now pinned by a test, since dropping `catalog:read` from the customer defaults would silently 401 every public storefront.

  **Password sign-up failed on a fresh install.** better-auth 1.7 writes an `issuer` column to `account` that porulle's schema did not declare, so its Drizzle adapter built an INSERT against a column the migration did not know about. The column and its migration are added, the better-auth dependencies are aligned to the range actually installed, and a parity guard derived from better-auth's own `getAuthTables()` — not a hand-maintained field list — now fails the build if the declared schema drifts from what better-auth writes.

  **Seven packages published an entry point that did not exist.** `@porulle/adapter-meilisearch`, `@porulle/adapter-pg-search`, `@porulle/adapter-r2`, `@porulle/adapter-s3`, `@porulle/import-flat`, `@porulle/import-shopify` and `@porulle/import-woocommerce` declared `./dist/index.js` while their build emitted `dist/src/index.js`, so importing any of them threw. Each was missing `"rootDir": "src"` in its build config.

  **The CLI binary is now `porulle`**, matching every documented command; `unifiedcommerce` remains as an alias so existing invocations keep working.

  **`@porulle/adapter-local-storage` rejoins the release train**, so `@porulle/*` can be pinned to a single version. It had been excluded and left at 0.10.7 while the family moved on — which also broke `porulle init`, since the scaffolded project pins every `@porulle/*` dependency to the CLI's own version and the starter template imports the local-storage adapter.

- Complete the outbound catalog push path: Porulle can now write catalog data back to a connected store, not only read from it.

  **Both adapters implement `pushCatalog`.** Shopify writes native product fields and metafields in a Porulle-owned namespace, adds the `write_products` scope, and resolves push capability per store from the scopes that store actually granted — a store connected before the scope existed fails closed with a non-retriable error naming the re-authorisation route rather than 403ing forever. WooCommerce writes native fields, `meta_data` under a Porulle prefix, and global `pa_*` taxonomy attributes for fields marked filterable, since only those drive layered navigation. Both resolve placement from the payload's intent plus its remote key, and neither will guess a remote key it was not given.

  Three WooCommerce write semantics are handled explicitly because getting them wrong destroys merchant data: the product `attributes` array is replaced wholesale on update, so it is read-merge-written; underscore-prefixed meta keys are rerouted by WooCommerce to first-class property setters, so the Porulle prefix is enforced structurally; and the batch endpoint reports per-item failures inside an HTTP 200, so its body is parsed rather than its status trusted. Image pushes carry the imported attachment id and merge against the current gallery instead of rebuilding it.

  **Catalog writes are triggered, previewable, and reversible by a human.** A change to a platform-owned field enqueues a push for the stores that map the entity, skipping writes that originated from channel convergence so an import cannot bounce straight back out. `POST /api/channels/stores/:id/push-catalog/preview` returns the per-field diff a push would apply, assembled by the same builder the job uses, and distinguishes a remote value that is absent from one that was never read.

  **A shared field that changes on both sides now waits for a person.** Convergence holds the field, records both values, and surfaces the conflict for review at `GET /api/channels/conflicts`; resolving it applies the chosen value without reassigning ownership, so the field stays shared and can conflict again.

## 0.11.0

### Minor Changes

- Catalog data-quality primitives, lossless channel import, and the outbound catalog contract.

  **Catalog.** Custom-field values are now updatable and carry provenance: `source`, `status` (proposed/approved/rejected), `confidence`, `evidence`, `locale`, and approval stamps, with one approved value per (entity, field, locale). A review workflow ships whole: approve/reject endpoints that displace the live value atomically and preserve evidence, an org-scoped proposal queue, and `?include=customFields` on entity reads returning approved rows. `select` fields enforce their declared options exact-match. Runtime entity field definitions layer over code config with admin REST and archive-never-delete semantics. Every catalog mutation writes a full entity revision in the same transaction, with true restore, per-entity monotonic numbering, and org-scoped retention trim. Media assets carry an origin (merchant/generated/imported) with a derivation link, and entity-media uniqueness is enforced per level.

  **Search.** `SearchFilters.attributes` and `SearchDocument.attributes` add attribute filtering and facets (AND across names, OR within one), opt-in per field via `filterable`, indexing approved values only — implemented in the in-memory engine, `adapter-pg-search` (parameterized jsonb), and `adapter-meilisearch` (union-safe filterable settings). The REST search route accepts repeatable `attr.<name>` parameters with an allowlisted grammar.

  **Channels.** `ChannelCatalogItem` widens to the full catalog shape — per-locale attributes, images, option axes, tags, brand, categories, status, and variant prices with compare-at — while staying structurally unable to express checkout state. Both connectors import the full payloads their platforms return, with currency-gated minor-unit prices. Convergence writes real catalog tables idempotently and merges metadata per key. A resumable per-store backfill (REST, durable job, and `porulle channel:backfill`) upgrades catalogs imported before this release. Per-field catalog ownership (`platform`/`store`/`shared`) with deterministic precedence governs every inbound path, holding shared conflicts persistently; connecting a store never implies catalog write access, and per-store placement mappings resolve at read time over provider defaults. The `ChannelConnector` contract gains an optional `pushCatalog` capability with intent-based payloads, per-item outcomes with prior remote values, and a platform-owned-only assembly — the write paths land in a following release.

  Consumer migrations for the schema additions are documented per feature in the repository's `docs/migration-*.md` files. PostgreSQL 15+ is now required.

## 0.10.8

### Patch Changes

- Make agent-driven checkout allocate a stable server-owned order ID before payment authorization, propagate that ID and organization scope into Stripe metadata, and reconcile signed payment events transactionally. Use Stripe's asynchronous webhook verifier for Cloudflare Workers and map webhook configuration or signature failures to actionable HTTP statuses.

## 0.10.6

### Patch Changes

- Use Worker-native transports for agentic checkout: bound fetch for Stripe, Neon HTTP for plain queries, and request-scoped Postgres.js transactions through Hyperdrive. Preserve actionable hook and checkout-stage context when edge runtimes surface opaque errors.

## 0.10.5

### Patch Changes

- Make server-side agent checkout safe and portable: accept tokenized payment methods and idempotency keys through the REST/core adapter contract, release cart checkout claims after failed payment attempts, and confirm Stripe PaymentIntents with manual capture and idempotent requests. Add an explicit Better Auth base URL for deployed runtimes and keep the reusable catalog/cart/order behavior independent of any one agent example.

## 0.10.4

### Patch Changes

- [`26a5a72`](https://github.com/asyncdotengineering/porulle/commit/26a5a722ae2e2a94d284e71f8e824ab2c985cce0) Thanks [@octalpixel](https://github.com/octalpixel)! - Fix payment capture recording `amountCaptured: 0` on a full capture. Both the
  manual capture (`POST /api/orders/{id}/capture` with no amount) and the checkout
  auto-capture step called the payment adapter without an amount and then trusted
  the value it echoed back. Adapters that return `0` for an omitted amount (the dev
  Stripe mock, and any custom adapter that doesn't default to the authorized total
  the way Stripe does) caused the order to record a `$0` capture — which then capped
  refunds at `$0`. The order module now passes the amount it intends to capture
  (the requested partial amount, else the order's `grandTotal` / checkout total) and
  records that when the adapter does not report a positive figure.

## 0.10.3

### Patch Changes

- Add an order pricing quote engine. `computeOrderPricing()` runs the same pricing
  pipeline checkout runs (resolve → promotions → shipping → tax) with no side
  effects, exposed as `POST /api/orders/quote` — so a manual/draft order can
  preview exactly what checkout will charge. Also fixes the checkout composition:
  shipping is now computed before tax (so `appliesToShipping` rates apply), and the
  runtime-rate tax path subtracts the order discount from the taxable base (was
  over-collecting tax on discounted orders).

## 0.10.2

### Patch Changes

- `POST /api/promotions/validate` now returns the authoritative discount the cart
  would receive — `{ totalDiscount, freeShipping, applied, rejectedCodes }` (the
  same computation checkout runs) — instead of only the promotion. This lets a
  storefront show the exact discount the order will get without re-deriving it
  (which drifts from checkout). New `PromotionValidationResult` response schema.

## 0.10.1

### Patch Changes

- Push merged plugin schema on zero-migration boot.

  `buildSchema(config)` (the only merge of plugin `customSchemas`) had no callers,
  `pushSchema()` pushed core-only, and nothing pushed the merged schema at boot —
  so on a zero-migration (PGlite) boot no plugin's own tables were ever created and
  every plugin's routes 500'd with "relation … does not exist". Adapters now
  advertise `autoMigrate`; `createCommerce` pushes the merged core+plugin schema at
  boot when the adapter auto-migrates and plugins declared tables (guarded, so
  plugin-less stores and migration-managed Postgres are untouched). `pushSchema`
  gains an optional `config` to push the merged schema. This makes `@porulle`
  plugins (gift cards, loyalty, …) work on the zero-infra PGlite starter.

## 0.10.0

### Minor Changes

- [#77](https://github.com/asyncdotengineering/porulle/pull/77) [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce) Thanks [@octalpixel](https://github.com/octalpixel)! - Add Shopify and WooCommerce catalog synchronization plus paid order injection with transparent customer shipping details, remote status confirmation, and tiered failed-export handling.

- [#77](https://github.com/asyncdotengineering/porulle/pull/77) [`8f8c564`](https://github.com/asyncdotengineering/porulle/commit/8f8c564deb399a86c50d27d8ca07e5334888bf30) Thanks [@octalpixel](https://github.com/octalpixel)! - Add generic one-click store onboarding: Shopify OAuth and WooCommerce `/wc-auth` endpoint flows via new engine-plugin routes (`/api/channels/oauth/{provider}/start` + `/callback`), signed single-use callback state, and connector `buildAuthUrl`/`completeAuth` methods — alongside the existing credential-paste path. Add Shopify mandatory GDPR compliance webhook ingress: `POST /api/channels/compliance/{provider}` unauthenticated route, app-secret HMAC verification (`verifyAppWebhook`), `shop_domain` store resolution, and idempotent dispatch to existing redaction methods (`customers/data_request`, `customers/redact`, `shop/redact`).

- [#77](https://github.com/asyncdotengineering/porulle/pull/77) [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce) Thanks [@octalpixel](https://github.com/octalpixel)! - Enforce keyed job concurrency in the built-in runner and add swappable execution engines for pg-boss, Inngest, Trigger.dev, and Cloudflare Workflows.

- [#77](https://github.com/asyncdotengineering/porulle/pull/77) [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce) Thanks [@octalpixel](https://github.com/octalpixel)! - Add externally sourced catalog provenance, store-scoped SKU uniqueness, the core channel connector contract, and the standalone channel connector engine plugin, including mandatory pre-payment live stock validation for channel checkout lines.

### Patch Changes

- [#77](https://github.com/asyncdotengineering/porulle/pull/77) [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce) Thanks [@octalpixel](https://github.com/octalpixel)! - Add verified channel webhooks, provider subscription registration, mirror convergence, guarded cross-boundary refund approval, and per-store catalog/inventory reconciliation with drift reporting.

- [#79](https://github.com/asyncdotengineering/porulle/pull/79) [`ff3d5e6`](https://github.com/asyncdotengineering/porulle/commit/ff3d5e6e876f090119fd025aa6b5499f0dccd9fb) Thanks [@octalpixel](https://github.com/octalpixel)! - Security hardening from the holistic review (R-03–R-07):

  - Orders discriminate a missing inventory record by a typed code (`INVENTORY_RECORD_NOT_FOUND`) instead of matching the message string — new `CommerceInventoryRecordNotFoundError`, emitted by the inventory service from a single shared message constant.
  - The stale-order-cleanup job enumerates orgs and reads each org's stale orders under an explicit `organizationId` predicate, so no query returns another tenant's order rows.
  - The scoped-db proxy re-wraps the result of an intercepted `.where()`, so a chained `.where(a).where(b)` can no longer drop the injected org predicate (Drizzle's second `.where` replaces the first).
  - Promotions usage recording (`FOR UPDATE` lock + limit read) and `webhooks.findFailedDeliveries` are scoped by `organizationId` (the latter via its parent endpoint).

## 0.9.0

### Minor Changes

- Security hardening release. Multiple breaking changes — see `docs/migration-0.1-to-0.7.md`.

  **Tenant isolation (SEC-01–SEC-21):** symmetric scoped-db `update`/`delete`, org-scoped catalog/pricing/entity lookups, catalog cross-org write guards, raw-SQL org predicates, PIN-login org binding, analytics alias safety, and more.

  **Order creation:** server-priced by default (client prices ignored unless the actor holds `orders:manage`), tenant-integrity on line entities/variants, and `is_custom_price` provenance. **BREAKING:** `POST /api/orders` and `POST /api/orders/{id}/line-items` now require `orders:manage`; customers transact via `POST /api/checkout` (server-priced).

  **Inventory / IDOR / gift cards:** `POST /api/inventory/warehouses|reserve|release` now require inventory permissions (anonymous → 401, customer → 403); checkout idempotency-key replay is bound to the requesting customer (no cross-customer order leak); gift-card repository is org-scoped; new `order_line_items.is_custom_price` column.

  **Refund money-conservation:** total payout can never exceed the captured amount across `refundLines` + `changeStatus` (gross-refund cap incl. undone refunds); orders with refunded lines cannot be fulfilled; refunds are rejected on unpaid or terminal orders. **BREAKING:** refunds require a paid order.

  Migration: existing deployments must grant `orders:manage` to staff roles / API-key scopes that create manual orders, keep customers on `/api/checkout`, and apply the schema change (`is_custom_price`).

## 0.8.0

### Minor Changes

- 5c580c4: Resolves seven admin/operator API gaps (#40–#46): `POST /orders/{id}/fulfillments` (tracking + partial shipment), pricing-modifier list/patch/delete, order line-item editing with totals recalc, cart listing + abandoned-checkout recovery (`GET /carts`, `POST /carts/{id}/recover`, cart `email` column), runtime shipping zones/rates and tax rates with org-scoped CRUD REST applied at checkout (new `shipping_zones`, `shipping_rates`, `tax_rates` tables — consumers regenerate migrations), and admin staff/RBAC REST over the Better Auth member table (`/admin/staff*`). New permission scopes: `cart:manage`, `shipping:manage`, `tax:manage`, `staff:manage`.
- ae7c329: Order operations + retail tax + layaway from the ordereka field study (#56–#58). **Core:** order notes + activity timeline (#56) — `POST/GET/DELETE /api/orders/{id}/notes` (author, pinned-first ordering) and `GET /api/orders/{id}/timeline` merging status history, notes, and refund-ledger events (both directions) newest-first; new `order_notes` table. Product tax classes (#57) — `taxClass` is a first-class column on sellable entities and variants (variant overrides entity; writable on create/update), `/api/tax/classes` CRUD behind `tax:manage` (rateBps + `isDefault` for unclassed lines), and checkout computes per-line tax by class with cart-level discounts pro-rated across lines before tax; the order now stores per-line `taxAmount` (and `discountAmount`) from checkout. When an org defines classes they take precedence over region rates/adapter; new `tax_classes` table. **`@porulle/plugin-layaway`** (#58): partial-payment plans — create a plan from items (deposit % or amount, optional initial payment) which reserves stock while active; record installments in any tender; at full payment the plan completes automatically (core order created and cross-linked, stock hold released); forfeit releases the hold and runs the `onForfeit` policy hook. Consumers regenerate migrations (`order_notes`, `tax_classes`, `layaways`, `layaway_payments`, `sellable_entities.tax_class`, `variants.tax_class`).
- 157221c: Four retail-operations gaps from the ordereka field study (#47–#50): a **settings module** (org-scoped typed groups — general/branding/policies — with GET/PATCH `/api/settings` behind `settings:manage` and a `kernel.services.settings.read()` runtime API for plugins; new `store_settings` table); a **documents module** (HTML receipt + serverless-safe dependency-free PDF invoice rendered from an order at `GET /api/orders/{id}/invoice.pdf|invoice.html|receipt.html`, plus `POST /{id}/invoice/email`, with fiscal invoice numbers allocated atomically per org and issued idempotently per order — new `invoice_sequences` + `order_documents` tables); a **canned retail reports pack** (`GET /api/analytics/reports/*`: daily-journal, tax-summary, inventory-aging, sell-through, reorder-needed, staff-sales — calendar math in the store's `settings.general.timezone` with prior-period deltas, behind `analytics:read`); and **one-call variant creation** (`POST /api/catalog/entities/{id}/variants/quick` and `/bulk` upsert option axes inline, create variants, and seed a zero-stock `inventory_levels` row so variants are sellable immediately). Consumers regenerate migrations for the three new tables.
- f40b3d1: POS-grade money movement from the ordereka field study (#51–#53). **Core (#52):** line-level refund primitives — first-class `refundedQuantity` on order line items enforced by `POST /api/orders/{id}/refunds` (per-line refundable quantity), an optional per-operator daily refund cap read from `settings.policies.refundDailyCap` (403 with the cap surfaced; `GET /api/orders/refunds/cap` reports usage), and an audited undo window (`POST .../refunds/{refundId}/undo`, `policies.refundUndoWindowMinutes`, default 15) backed by a new `order_refunds` ledger table. Plugins can now receive the Better Auth instance (`PluginContext.auth`), contribute named API-key scopes via the manifest (`apiKeyScopes`), and scope definitions accept `keyExpiration` bounds; `createPluginTestApp` wires a real auth instance + middleware. **plugin-pos:** PIN auth runtime (#51) — `PUT /pos/auth/pin` (PBKDF2 via Web Crypto, Workers-safe), `POST /pos/auth/pin-login` minting a short-lived per-shift Better Auth API key under the plugin-registered `pos` scope, and `POST /pos/auth/override` for manager-by-PIN approvals (new `pos_operator_pins` table); exchanges (#53) — `POST /pos/exchanges` runs the return refund and the replacement order in ONE database transaction, cross-links refund/original/replacement, settles even exchanges immediately and leaves uneven ones open for tender. Consumers regenerate migrations (`order_refunds`, `pos_operator_pins`, `order_line_items.refunded_quantity`).
- 230f405: Two integrator quick wins from the ordereka-fashion-pos field study: `config.routes(app, kernel, auth)` now receives the Better Auth instance (no more module-global auth-holder shims) and `requirePerm` is a public export for authorizing custom routes; orders and checkout accept an `idempotencyKey` (new `orders.idempotency_key` column + unique org-scoped index — consumers regenerate migrations) so offline POS queues and network retries replay safely instead of double-charging — a checkout replay returns the original order without re-authorizing payment.

## 0.7.0

### Minor Changes

- Resolve admin-panel API gaps ([#33](https://github.com/asyncdotengineering/porulle/issues/33)–[#38](https://github.com/asyncdotengineering/porulle/issues/38)):

  - **Pricing**: `setBasePrice` now upserts on the natural key instead of appending a duplicate row, and `?include=pricing` exposes `id` + `createdAt` so consumers can identify the authoritative price.
  - **CSRF**: the global `csrf()` guard is skipped for API-key / bearer (server-to-server) requests, and genuine origin rejections surface a distinguishable `CSRF_ORIGIN_REJECTED` code.
  - **Catalog media**: `?include=media` is now backed by a real media/entity link lookup (role, sortOrder, url) instead of always returning `[]`.
  - **Local storage adapter / starter**: the `/assets/*` `serveStatic` mount strips the `/assets` prefix so adapter-generated URLs resolve correctly.
  - **Orders**: new REST endpoints for draft/manual order creation (`POST /orders`), payment capture (`POST /orders/{id}/capture`), and refund (`POST /orders/{id}/refund`).
  - **Variants**: `/variants/generate` documents its request body and returns a `422` for a missing/invalid strategy instead of a `500`.

## 0.6.0
