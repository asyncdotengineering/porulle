# Agent-Native Commerce Framework Audit
## UnifiedCommerce Engine

**Audited on:** 2026-05-10
**Codebase version:** branch `foundation-repair`, head `7cb06e3` (working tree)
**Audit standard:** Agent-Native Commerce Framework Blueprint (5 Foundations + 18 Layers)

---

## Executive Summary

UnifiedCommerce Engine is a TypeScript headless-commerce kernel — Hono + Drizzle + Better Auth, organized as a Turborepo monorepo with a config-driven kernel, a PayloadCMS-flavored plugin system, and a spec-compliant MCP server mounted at `/api/mcp`. As a *headless commerce framework* it is solid mid-stage work; as an *agent-native* framework it is early. The headline reading is: strong infrastructure foundations (config, adapters, plugins, serverless awareness) with an actor model that has no concept of an agent and a protocol surface that is MCP-only.

The strongest finding is the engineering substrate. The adapter contracts (`PaymentAdapter`, `TaxAdapter`, `SearchAdapter`, `StorageAdapter`, `DatabaseAdapter`) are real, with multiple implementations behind several of them. The plugin manifest (`packages/core/src/kernel/plugin/manifest.ts`) is rich — schema, hooks, routes, MCP tools, analytics models, declared dependencies — and the durable job queue (`packages/core/src/kernel/jobs/runner.ts`, claim-based with `FOR UPDATE SKIP LOCKED`) is the kind of primitive most "serverless-first" frameworks promise and don't ship. The order state machine in `kernel/state-machine/machine.ts` is typed and guards transitions. These are not embryonic — they are working, well-architected primitives.

The most important gap is the principal model. `Actor` (`packages/core/src/auth/types.ts:1`) is `type: "user" | "api_key"` with a flat `permissions: string[]`. There is no `Principal` discriminated union, no `AuthorizationGrant`, no scope expression beyond resource:action permission strings, no expiry on grants, no signed attestation, no acting-on-behalf-of. The README markets the engine as "AI-Native from Day Zero" and the MCP server enforces an `mcp:invoke` permission, but the auth substrate underneath an MCP call is identical to a regular API key — a flat permission list. Until that changes, the framework can serve agents, but it was not designed for them. Every other agent-native gap (no UCP/ACP, no Conversation entity, no SellerAgent runtime, no agent-aware attribution, no Web Bot Auth) is downstream of this single fact.

**Headline scores:**
| Dimension | Score |
|---|---|
| Foundation score | 2.8 / 5 |
| Layer score | 1.5 / 5 |
| **Overall agent-native readiness** | **2.0 / 5** |

**Verdict:** Partial — solid headless-commerce engine with embryonic agent-native posture; foundations are good enough to refactor in place, the principal layer must be reworked.

---

## Codebase Profile

| Property | Value |
|---|---|
| Language / runtime | TypeScript 5.9 on Node ≥18 / Bun 1.3 |
| Framework base | Hono (REST + MCP) on a custom Kernel |
| Database / ORM | Drizzle ORM + PostgreSQL (sole DB implementation) |
| Lines of TypeScript (packages/) | ~73,000 across ~557 files |
| Stated purpose | "Serverless-first, AI-native headless commerce kernel" |
| Inferred maturity | Mid — many subsystems production-shaped, several still embryonic |
| Deployment targets | Node, Bun, Vercel/Cloudflare Workers (edge-runtime probe in `runtime/server.ts:40`) |
| Stated support for agents | Yes via MCP — README, `interfaces/mcp/agent-prompt.ts` |

The repo is a Turborepo monorepo: `packages/core`, an adapter family (postgres, stripe, taxjar, tax-manual, meilisearch, pg-search, s3, r2, local-storage, resend, ses), and a sizeable plugin family (marketplace, pos, pos-restaurant, gift-cards, loyalty, reviews, wishlist, notifications, appointments, scheduled-orders, procurement, production, uom, warehouse). Reference apps live in `apps/` (`store-example`, `fashion-starter`, `restaurant-example`, `saas-example`, `tea-avenue`). The active branch carries a heavy security-hardening history (RFCs 008/010, multiple VAPT reports, recent commits on cart hijack/order race fixes), which is visible in defensive code throughout the kernel — SSRF guard for webhooks, hashed sign-in rate-limit keys, CSP/CSRF/body-limit middleware, and an `mcp:invoke` gate on the MCP transport.

---

## Overall Scorecard

### Foundations

| # | Foundation | Score | Verdict |
|---|---|---|---|
| 1 | Config-as-truth | 3/5 | Solid |
| 2 | Adapter pattern | 4/5 | Strong |
| 3 | Plugin architecture | 3/5 | Solid |
| 4 | Serverless-native | 3/5 | Solid |
| 5 | Agent-as-first-class | 1/5 | Embryonic |

### Layers

| # | Layer | Score | Verdict |
|---|---|---|---|
| 1 | Catalog & Product Intelligence | 2/5 | Partial |
| 2 | Inventory & Availability | 2/5 | Partial |
| 3 | Identity, Authorization & Trust Mesh | 1/5 | Embryonic |
| 4 | Multi-Protocol Commerce Gateway | 1/5 | Embryonic |
| 5 | Payment & Settlement Orchestration | 2/5 | Partial |
| 6 | Order Lifecycle & Fulfillment | 3/5 | Solid |
| 7 | Conversation & Channel Layer | 0/5 | Missing |
| 8 | Seller-Side Agent Infrastructure | 0/5 | Missing |
| 9 | Discovery & Recommendation | 2/5 | Partial |
| 10 | Attribution, Analytics & Revenue Share | 2/5 | Partial |
| 11 | Trust, Safety & Dispute Resolution | 1/5 | Embryonic |
| 12 | Developer Experience & Extensibility | 3/5 | Solid |
| 13 | Negotiation & Pricing Engine | 2/5 | Partial |
| 14 | Compliance, Tax & Regulatory | 1/5 | Embryonic |
| 15 | Returns, Reverse Logistics | 1/5 | Embryonic |
| 16 | Customer & Merchant Profile Intelligence | 1/5 | Embryonic |
| 17 | Event Stream, Webhooks & Async | 2/5 | Partial |
| 18 | Data Sovereignty & Residency | 0/5 | Missing |

---

## Foundation Analysis

### Foundation 1: Config-as-truth

**Score:** 3/5 — Solid

**Evidence:**
- `packages/core/src/config/types.ts` — `CommerceConfig` is the central declaration: database, auth, entities, hooks, plugins, payments, storage, schema, mcpTools, routes.
- `packages/core/src/config/define-config.ts` — `defineConfig()` resolves config and applies plugin transforms in order.
- `packages/core/src/runtime/kernel.ts` and `runtime/server.ts:298–308` — `createKernel(config)` and `createServer(config)` are the only entry points; everything downstream reads from the resolved config.
- `apps/store-example/commerce.config.ts` — concrete app config with adapters, plugins, hooks.

**What this codebase does:** A single TypeScript config function (`defineConfig`) is the source of truth for store identity, adapter selection, entity schema extensions, plugin registration, hook registration, security headers, rate limits, and route extension. Plugins are themselves config-transform functions, the PayloadCMS pattern. Drizzle schemas (core + plugin schemas merged into `customSchemas`) drive migrations and runtime types simultaneously.

**Gap to agent-native standard:** The config drives infrastructure but does not drive the *API surface*. `EntityConfig` in `config/types.ts:76` carries fields/variants/fulfillment, but REST routes for entities are built from a hand-written router (`interfaces/rest/index.ts`) and the alias generator only produces a thin pass-through to the catalog service — there is no auto-generated typed REST/MCP surface from the entity definition. Compared to Payload, where one config produces collections, REST, GraphQL, admin UI, and types, UnifiedCommerce has the input shape but stops generating after the database. Custom fields exist as a side table (`sellable_custom_fields`) rather than projecting into a typed shape per entity. This is not a small gap if the goal is agent-readability — agents reading `/api/doc` get the hand-curated openapi spec, not a faithful projection of the config.

**What it would take to reach 5/5:**
1. Make `EntityConfig` the source for a generated CRUD surface (REST + MCP) — same pattern as Payload's collection-driven `/api/{collection}`.
2. Generate per-entity TypeScript types from the entity config and surface them in the SDK.
3. Treat custom fields as typed columns at runtime (projection layer over `sellable_custom_fields`) so consumers see one schema, not two.

---

### Foundation 2: Adapter pattern

**Score:** 4/5 — Strong

**Evidence:**
- `packages/core/src/modules/payments/adapter.ts` — `PaymentAdapter` interface; implementations in `packages/adapters/adapter-stripe` and a `mockPayments` in `apps/store-example/commerce.config.ts:19`.
- `packages/core/src/modules/tax/adapter.ts` — `TaxAdapter` with `adapter-taxjar` and `adapter-tax-manual` implementations.
- `packages/core/src/modules/search/adapter.ts` — `SearchAdapter` with Meilisearch and Postgres FTS implementations.
- `packages/core/src/modules/media/adapter.ts` — storage adapter with S3, R2, local-storage.
- `packages/core/src/kernel/database/adapter.ts` — `DatabaseAdapter` (only Postgres implementation; README acknowledges schema is PG-specific).
- `packages/core/src/kernel/jobs/adapter.ts` — `JobsAdapter` with a Drizzle-backed default.

**What this codebase does:** Every cross-vendor concern has a typed interface and at least one drop-in implementation; payments, tax, and search each have ≥2 implementations, which is the meaningful test of whether the abstraction is real. Adapters are wired through config, not imported in business logic; the `PaymentsService` (`modules/payments/service.ts:11`) keeps a `Map<providerId, PaymentAdapter>` and resolves by id at call time. The Stripe adapter (`adapter-stripe/src/index.ts:20`) is the only file that imports the Stripe SDK — core is clean.

**Gap to agent-native standard:** Two specific drops from 5/5. (a) The database adapter has only one implementation and the schemas use Postgres-specific features (`jsonb`, `uuid` defaults, `pgTable`). For a "deploys to Cloudflare Workers" claim, a SQLite/D1 implementation is necessary; today the runtime can run on Workers but the data plane cannot. (b) Conversation channels and agent identity are not adapter slots at all — there is no `ChannelAdapter` for WhatsApp/SMS/web-chat, and no `IdentityAdapter` for agent-attestation services like Web Bot Auth or KYA. The discipline is right; two important slots are missing.

**What it would take to reach 5/5:** Land a non-Postgres `DatabaseAdapter` (the architectural goal called out in README), add a `ChannelAdapter` interface + at least one implementation, define an `AgentVerificationAdapter` slot for emerging bot-auth standards.

---

### Foundation 3: Plugin architecture

**Score:** 3/5 — Solid

**Evidence:**
- `packages/core/src/kernel/plugin/manifest.ts:118` — `CommercePluginManifest` with `id`, `version`, `requires`, `permissions`, `schema`, `hooks`, `routes`, `mcpTools`, `analyticsModels`.
- `packages/core/src/kernel/plugin/manifest.ts:165–344` — `defineCommercePlugin()` is a config-transform; richer than middleware-as-plugin.
- `packages/core/src/kernel/hooks/registry.ts` — `prepended / configured / appended` hook chains; resolved via `[...prepended, ...configured, ...appended]`.
- `packages/core/src/kernel/plugin/manifest.ts:172–183` — dependency check that throws in production, warns in dev.

**What this codebase does:** Plugins extend by transforming config rather than registering at runtime — schemas are merged into `customSchemas`, hooks are folded into the global hook map, routes and MCP tools are deferred until kernel boot, analytics models are appended to a list. The contract is rich (six extension points) and tested by a dozen real plugins (marketplace, pos, gift-cards, loyalty, reviews, wishlist, notifications, appointments, scheduled-orders, procurement, production, uom, warehouse). Plugins can declare `requires: string[]` and the manifest enforces it before applying the transform.

**Gap to agent-native standard:** Hook ordering is not declared — it's positional. A hook chain runs `prepended → configured → appended`, but two plugins both prepending to `orders.afterCreate` will run in registration order with no way to express "I must run after the loyalty plugin's reward grant but before the notifications plugin's email." There is no `runs.before` / `runs.after` on hook registrations and no topological sort. There is also no cycle detection at boot — `requires` only checks presence, not ordering compatibility. For agent-native commerce where regional plugins (BNPL display, COD, locale-aware pricing) must compose with merchant plugins (loyalty, gift cards), this becomes a runtime problem disguised as a configuration problem. Beyond ordering, the framework has no notion of *protocol plugins* — a plugin cannot register a new top-level protocol the way it can register MCP tools (which are inside MCP, not their own protocol).

**What it would take to reach 5/5:** Add `runs: { before?: string[]; after?: string[] }` on hook registrations, run a topological sort with cycle detection at boot, and surface conflicts as startup errors. Then add a `protocols` slot to the plugin manifest so future UCP/ACP support is plugin-shaped.

---

### Foundation 4: Serverless-native runtime

**Score:** 3/5 — Solid

**Evidence:**
- `packages/core/src/runtime/server.ts:40–46` — `isNodeRuntime()` probe; process crash handlers skipped on edge.
- `packages/core/src/runtime/server.ts:443–464` — autorun is opt-in (`config.jobs.autorun.enabled`), default is the `/api/jobs/run` cron endpoint for serverless cron triggers.
- `packages/core/src/kernel/jobs/runner.ts` — durable job queue claimed via `FOR UPDATE SKIP LOCKED`; multiple runners safely parallelize.
- `packages/core/src/kernel/jobs/reaper.ts` — stale-claim reaper.

**What this codebase does:** The runtime treats serverless as the default and long-running as an opt-in. Process-crash handlers gate on a runtime probe. Background work goes through a database-backed job queue (`commerce_jobs` table) that any runner can claim, so webhook delivery, scheduled work, and reapers all survive cold starts. CSP, CSRF, rate limit, and body-limit middleware come from `hono-rate-limiter` and `hono/csrf` — request-scoped, not process-scoped. There are no module-level singletons holding session state that I found; auth is request-scoped via `c.set("actor", ...)`.

**Gap to agent-native standard:** Two issues. The in-process autorun path uses `setInterval` directly (`runtime/server.ts:446`) — fine when the operator opts in on a Node host, fine in tests, but the README does not flag that this branch must stay disabled on Lambda/Workers. A clearer boundary (refuse to enable autorun on edge) would protect operators from misconfiguring a Worker that silently leaks intervals. Second, while the rate limiter uses a `keyGenerator` based on client IP, the limiter's storage is in-memory by default — across multiple Worker isolates or Lambda containers the limit will be inconsistent. For agent-native commerce, where one buyer-agent fan-out can hit 100x the human peak in seconds, an external store (Redis/Durable Objects) is needed; today there's no adapter slot for this.

**What it would take to reach 5/5:** Disallow autorun on edge runtimes at runtime, add a `RateLimitStoreAdapter` for cross-instance limits, document a serverless reference deploy on Workers end-to-end (including DB connection pooler).

---

### Foundation 5: Agent-as-first-class principal

**Score:** 1/5 — Embryonic

**Evidence:**
- `packages/core/src/auth/types.ts` — entire `Actor` type:
  ```typescript
  export interface Actor {
    type: "user" | "api_key";
    userId: string;
    email: string | null;
    name: string;
    vendorId: string | null;
    organizationId: string | null;
    role: string;
    permissions: string[];
  }
  ```
- `packages/core/src/auth/middleware.ts:124–195` — only two resolved actor shapes: a session-derived user, an API-key-derived `api_key`.
- `packages/core/src/interfaces/mcp/transport.ts:117–124` — MCP gate is just a `mcp:invoke` permission check on the actor's flat permission list.
- `packages/core/src/modules/audit/schema.ts` — audit log captures `actor_id` (text), `actor_type` (text); no grant id, no scope.

**What this codebase does:** Authentication and authorization are a session-or-API-key model, with permissions as `resource:action` strings (`*:*`, `catalog:read`, `orders:create`). API keys can carry a `Record<string, string[]>` permission map (`auth/middleware.ts:170`) and are flattened to the same string form. The MCP server gates on `mcp:invoke`, but once past the gate, an MCP-driven action looks identical to a human-driven one — same actor shape, same permission check. The audit log records who but not under what authority.

**Gap to agent-native standard:** This is the headline finding. There is no `Principal` discriminated union, no `AuthorizationGrant` record, no scope language richer than role/permission strings, no per-action limits (max amount, merchant whitelist, escalation threshold), no expiry on individual grants, no signed attestation, and no acting-on-behalf-of relationship. An API key is an API key — the framework cannot distinguish "this key belongs to a buyer-agent acting on behalf of Alice with a $500 cap on apparel until Sunday" from "this is a customer integration key with apparel:read." Every agent-specific layer (3, 4, 8, 11) inherits this gap.

**What it would take to reach 5/5:**
1. Replace `Actor` with `Principal = User | ApiKey | BuyerAgent | SellerAgent | System` as a discriminated union (`packages/core/src/auth/types.ts`).
2. Introduce an `AuthorizationGrant` record with `id`, `actions[]`, `maxAmount?`, `merchantWhitelist?`, `validUntil`, `revokedAt?`, `escalateAbove?`.
3. Change every `assertPermission(actor, "x:y")` site to a `authorize(principal, action, resource)` call that consults the grant for amount/scope.
4. Extend the audit log with `grant_id` so every action traces back to the authority under which it was permitted.
5. Add agent-attestation verification (Web Bot Auth / KYA) at the middleware boundary so an `agent` principal carries a verified identity, not a self-asserted one.

---

## Layer Analysis

### Layer 1 — Catalog & Product Intelligence

**Score:** 2/5 — Partial

**Evidence:** `packages/core/src/modules/catalog/schema.ts` — `sellable_entities` (universal type), `sellable_attributes` (per-locale row with title/description/seoTitle/seoDescription), `sellable_custom_fields` (typed value columns by kind), `variants`, `option_types`, `option_values`, `categories`, `brands`.

**What this codebase does:** A universal-entity model — products, services, subscriptions, digital — through one `type` column on `sellable_entities`. Localization is per-row in a sibling table keyed by `locale`. Custom fields are EAV with typed value columns. Variants and option types/values are properly normalized.

**Gap to agent-native standard:** No embeddings column or sibling table. No structured attribute ontology — `sellable_custom_fields` is open-keyed `field_name`/`field_type` text columns, not a typed schema per attribute. No agent-readable representation method (a `describe(audience: "agent" | "customer")` that produces a structured summary suitable for tool-calling). Locale entries are flat strings, not rich-text-with-locale-fallback, though `richDescription` is jsonb.

**What it would take to reach 5/5:** Add `entity_embeddings` (semantic + image vectors) keyed by `entity_id` + `locale`; promote attribute schemas to typed-per-attribute definitions in `EntityConfig.fields`; add a `describeForAgent()` projection that bundles title/locale/attributes/availability/price-state into one MCP-friendly payload.

---

### Layer 2 — Inventory & Availability

**Score:** 2/5 — Partial

**Evidence:** `packages/core/src/modules/inventory/schema.ts` — `warehouses` (multi-location with priority), `inventory_levels` (`quantityOnHand`, `quantityReserved`, `quantityIncoming`, `version` for optimistic locking), `inventory_movements` (typed enum log including `reservation`/`release`). `packages/core/src/modules/inventory/service.ts:220` — `reserveWithLock` uses `SELECT FOR UPDATE`.

**What this codebase does:** Multi-warehouse stock with reservations is real; the optimistic `version` plus `reserveWithLock` path is the right concurrency story; the movements table is a complete audit of stock changes; release/cancel paths exist (the marketplace plugin uses them on sub-order cancel).

**Gap to agent-native standard:** Reservations don't have an explicit TTL — they're a counter delta, with releases driven by callers (cart abandon, order cancel) rather than an expiry. There's no agent-callable promised-availability primitive ("ships in N days from warehouse X to ZIP Y") — the closest is `quantityOnHand - quantityReserved` per warehouse. No oversell-detection / reconciliation tooling; it's relied on the lock to prevent oversells, which is correct, but there's no after-the-fact reconciliation primitive for distributed deployments.

**What it would take to reach 5/5:** Add `reservation_id` + `expires_at` on the reservation row, with a reaper that releases past-TTL reservations; expose `availability.promise(entityId, qty, toAddress)` returning a `{ canFulfill, eta, fromWarehouseId }` triple; add a reconciliation job that compares `inventory_levels.quantityReserved` against active cart reservations and flags drift.

---

### Layer 3 — Identity, Authorization & Trust Mesh

**Score:** 1/5 — Embryonic

**Evidence:** Same as Foundation 5. `packages/core/src/auth/types.ts`, `auth/middleware.ts`, `auth/permissions.ts:4` (`assertPermission` is a substring/wildcard match on a `string[]`).

**What this codebase does:** Better-Auth provides session, organization, and API-key plumbing competently. Roles map to permission lists in config; permissions are RBAC strings. Org scoping is real (`organization_id` columns everywhere) and Better-Auth's organization plugin is correctly wired.

**Gap to agent-native standard:** Discussed at length under Foundation 5 — no agent principal, no structured grants, no scope language, no per-grant audit. Trust mesh primitives (mutual attestation, agent reputation, verifiable presentation) are entirely absent.

**What it would take to reach 5/5:** Implement the Foundation 5 migration; then layer on agent-attestation (Web Bot Auth header, KYA token), revocation propagation via the existing event bus, and per-grant audit.

---

### Layer 4 — Multi-Protocol Commerce Gateway

**Score:** 1/5 — Embryonic

**Evidence:** `packages/core/src/runtime/server.ts:303` — `app.route("/api/mcp", createMCPHandler(kernel))`. `packages/core/src/interfaces/mcp/transport.ts` — spec-compliant Streamable HTTP transport. No matches for "ucp", "acp", or `well-known` outside of `well-known` mentions in node_modules.

**What this codebase does:** MCP is real, version-aware via the SDK, and gated. Tools are registered from both core (`mcp/tools/index.ts`) and plugins. Resources are registered (`mcp/server.ts:15` — entity-types schema, order-states schema). The agent system prompt is bundled (`mcp/agent-prompt.ts`).

**Gap to agent-native standard:** Single-protocol. No UCP, no ACP, no `/.well-known/commerce-capabilities` manifest. No protocol version negotiation beyond what the MCP SDK does internally. Calling-agent attribution on an MCP call is just the actor's `userId` — no `acting_for`, no grant id surfaced into the call. For a framework whose marketing promise is "agent-native commerce," supporting only one of the three emerging protocols is a major gap.

**What it would take to reach 5/5:** Define a `ProtocolDefinition` interface with `basePath`, `versions`, `handler`, `capabilities`. Refactor MCP into a `ProtocolDefinition`. Add UCP and ACP implementations alongside it. Generate `/.well-known/commerce-capabilities` from the registered protocols + entity config + payment adapters + plugin permissions.

---

### Layer 5 — Payment & Settlement Orchestration

**Score:** 2/5 — Partial

**Evidence:** `packages/core/src/modules/payments/adapter.ts` — `PaymentAdapter` interface. `packages/core/src/modules/payments/service.ts:11` — `PaymentsService` with `Map<providerId, PaymentAdapter>` and `resolveAdapter(paymentMethodId?)`. `packages/adapters/adapter-stripe/src/index.ts:20` — Stripe implementation isolated to its package.

**What this codebase does:** The adapter pattern is clean — payments service holds a map, resolves by provider id, falls back to a default. Stripe is the only fully-built adapter; the example app declares a `mockPayments` for integration tests. Webhooks are signed and idempotency-guarded via `processed_webhook_events`.

**Gap to agent-native standard:** No multi-rail orchestrator. `resolveAdapter(paymentMethodId)` is direct lookup, not intent-based — there's no `selectRail(intent: PaymentIntent)` that picks rail based on currency, amount, region, or capability. No fallback on rail failure (try Stripe → fall back to PayHere on 5xx). No structured 3DS/OTP challenge primitive — the adapter returns a `clientSecret`, but the framework has no flow type for "this payment requires a step-up." BNPL is referenced only as a metadata field on checkout (`interfaces/rest/routes/checkout.ts:161`) and as an order-state extension comment, not as a price-time primitive.

**What it would take to reach 5/5:** Add a `PaymentOrchestrator` over the adapter map with intent-based rail selection and explicit fallback chains; lift challenge flow into the public type (`requires_action`, `requires_3ds`, `requires_otp`) with a uniform resolution endpoint; model BNPL eligibility as a product/price-time attribute (Layer 13) and a payment capability declaration on the adapter, not as opaque metadata.

---

### Layer 6 — Order Lifecycle & Fulfillment State Machine

**Score:** 3/5 — Solid

**Evidence:** `packages/core/src/kernel/state-machine/machine.ts` — typed `StateDefinition`, `assertTransition` throws `CommerceInvalidTransitionError`, `extendOrderStateMachine` merges custom transitions without replacement. `packages/core/src/modules/orders/schema.ts` — `order_status_history` records every transition with actor and reason. `packages/core/src/modules/fulfillment/schema.ts` — fulfillment is its own typed entity (physical / digital / access_grant) with its own status, line-item junctions, and event log.

**What this codebase does:** Orders move through `pending → confirmed → processing → [partially_fulfilled | fulfilled] → refunded`, with `cancelled` reachable from non-terminals and transitions enforced by the state machine. Fulfillment is decomposed correctly — it's a separate entity with its own state, not a status flag on the order. Status history captures changedBy/changedAt/reason. The state machine is plugin-extensible.

**Gap to agent-native standard:** Returns are not a first-class flow in core. `refunded` is a terminal state on the order, but there's no `Return` entity in `packages/core/src/modules/`; the marketplace plugin has a `returnRequests` table, which means returns are merchant-marketplace-specific rather than core-universal. No "order pause for approval" primitive — useful for agent-initiated orders that need a human decision above some threshold. No conditional/recurring order primitive in core (the `plugin-scheduled-orders` provides it via plugin).

**What it would take to reach 5/5:** Land Returns as a core entity with its own state machine (`requested → approved → received → refunded | rejected`), structured reason codes, and a refund-routing primitive (full / partial / store credit / exchange). Add a `pending_approval` state to the order machine with an associated approver-id field.

---

### Layer 7 — Conversation & Channel Layer

**Score:** 0/5 — Missing

**Evidence:** No `Conversation` table, no channel-adapter interface, no WhatsApp/SMS module. `email` config is one outbound `send()` callback (`config/types.ts:328`); `plugin-notifications` exists but it is a notification dispatcher, not a conversation entity.

**What this codebase does:** Outbound transactional email via adapters (Resend, SES). Order emails wired in `hooks/order-emails.ts`. That's the entire channel surface.

**Gap to agent-native standard:** No persistent conversation, no channel agnosticism, no intent parsing, no human-handoff packet. Agent-mediated commerce in markets where WhatsApp is the primary channel cannot be built on top of this without a new subsystem.

**What it would take to reach 5/5:** Define a `Conversation` entity with channel-agnostic state, a `ChannelAdapter` interface, at least two implementations (web-chat + WhatsApp/Twilio), persistence of conversation memory, and a structured intent-parsing entry point.

---

### Layer 8 — Seller-Side Agent Infrastructure

**Score:** 0/5 — Missing

**Evidence:** No `SellerAgent` type. No agent-runtime module. No agent-tool-registry separate from the MCP tool surface. `grep` for "seller agent" / "merchant agent" finds nothing.

**Gap to agent-native standard:** The MCP server is a *receiving* surface — agents call it from outside. There is no concept of a merchant-side agent that the framework instantiates with persona, tool whitelist, scope, and runtime. "AI features for merchants" today means MCP exposes the kernel; it does not mean the kernel hosts agents.

**What it would take to reach 5/5:** Add a `SellerAgent` entity with persona/tools/scope, a runtime that loads agents and dispatches tool calls under the agent's grant, telemetry for escalation/error rates, and a tool registry that gates which tools each agent can call.

---

### Layer 9 — Discovery & Recommendation

**Score:** 2/5 — Partial

**Evidence:** `packages/core/src/modules/search/adapter.ts` — `SearchAdapter` with `index`, `search`, `suggest`. Implementations: `adapter-meilisearch`, `adapter-pg-search`. Facets supported in the result type.

**What this codebase does:** Solid keyword search abstraction with two real implementations and faceting. Suggest endpoint exists. Hooks fire to keep the index fresh.

**Gap to agent-native standard:** No semantic / vector search adapter. No structured query parsing (must/should/filter distinction). No reasoning-friendly result format — `SearchHit` carries `score` and `document` only; agents would benefit from per-attribute match explanations and constraint-satisfaction breakdown. No cross-merchant aggregation primitive in core (marketplace plugin has its own surface).

**What it would take to reach 5/5:** Add a `VectorSearchAdapter` slot, implement it for pgvector/Pinecone, hybrid-rank with the keyword adapter; extend `SearchHit` with `explanations: { dimension, contribution, snippet }[]`; promote query parsing into a structured input shape.

---

### Layer 10 — Attribution, Analytics & Revenue Share

**Score:** 2/5 — Partial

**Evidence:** Cube.js semantic models live next to data (`apps/store-example/cube/`). `packages/core/src/modules/analytics/types.ts` and the MCP analytics tools surface measures and dimensions. `packages/plugins/plugin-marketplace/src/schema.ts` has `commission_rules`, `vendor_balances`, `vendor_payouts` — a real revenue-share substrate.

**What this codebase does:** Analytics has a semantic layer, AI-grounded by the bundled system prompt, with measures for revenue/orders/inventory/customers. Marketplace plugin computes commission and payout per vendor. The architecture is correct (semantic layer, not raw SQL).

**Gap to agent-native standard:** No multi-party attribution chain. The marketplace plugin attributes a transaction to a single vendor, not to a chain of actors (buyer-agent → seller-agent → vendor) with configurable split rules. No per-agent performance metrics distinct from per-user analytics. No counterfactual / lift framing in the semantic layer.

**What it would take to reach 5/5:** Add an `attribution_events` table keyed by `transaction_id` with `principal_id`, `principal_type`, `weight`, `rule_version`. Make the marketplace commission engine read from it. Surface per-agent measures (`Agents.escalationRate`, `Agents.gmv`) in Cube.

---

### Layer 11 — Trust, Safety & Dispute Resolution

**Score:** 1/5 — Embryonic

**Evidence:** `packages/core/src/modules/webhooks/service.ts:13` — SSRF guard for outbound webhook URLs. `plugin-marketplace` has `disputes` table. No agent verification, no Web Bot Auth, no KYA, no anomaly detector specific to agents, no circuit breaker.

**What this codebase does:** Defensive code is solid for a traditional commerce engine — webhook SSRF guard, idempotent webhook processing, hashed sign-in rate limit keys. Marketplace disputes exist as a vendor-side workflow.

**Gap to agent-native standard:** None of the agent-specific primitives. No way to verify "this is actually a buyer-agent and not a scraper claiming to be one." No anomaly detection on agent behavior (sudden cap-saturation, unusual basket composition). No circuit breaker that auto-disables a grant on N failed attestations. No evidence-chain dispute primitive in core.

**What it would take to reach 5/5:** Add an `AgentVerificationAdapter` (Web Bot Auth / KYA) and call it in `authMiddleware`; add an `agent_circuit_breaker` table with rules like `revoke_on: { anomaly_score > 0.9 || refund_rate > 0.3 }`; promote disputes into core as a generic primitive with structured evidence chains.

---

### Layer 12 — Developer Experience & Extensibility

**Score:** 3/5 — Solid

**Evidence:** `packages/cli/src/commands/` — `init`, `dev`, `deploy`, `migrate`, `generate-migration`, `api-key`, `import`, `doctor`. `packages/sdk` — TypeScript SDK with React middleware. `runtime/server.ts:312` — OpenAPI doc + Scalar reference UI exposed in dev. `kernel/error-mapper.ts` — structured error shapes. Pino-style request logging with request-id propagation.

**What this codebase does:** Real CLI, real SDK, real OpenAPI surface with tag groups for sidebar navigation. Multiple example apps (`store-example`, `fashion-starter`, `restaurant-example`, `saas-example`, `tea-avenue`). Plugin testing infrastructure (`createPluginTestApp`). Migration tooling via Drizzle Kit. The error mapper produces stable error codes the SDK can consume.

**Gap to agent-native standard:** No agent-flow simulation harness — there's no `simulateAgent({ persona, grant, scenario })` that lets a developer dry-run an agent against the kernel without a real LLM. No record/replay tooling for agent transcripts. Observability is request-scoped; OpenTelemetry instrumentation isn't standardized into adapters.

**What it would take to reach 5/5:** Ship an `agent-sim` package with deterministic scenarios; add OTel tracing primitives alongside the Pino logger; document how a plugin author writes an agent-aware integration test.

---

### Layer 13 — Negotiation & Pricing Engine

**Score:** 2/5 — Partial

**Evidence:** `packages/core/src/modules/pricing/schema.ts` — `prices` (per entity/variant/currency/customer-group/qty band/validity window) and `price_modifiers` (typed: `percentage_discount` / `fixed_discount` / `markup` / `override`, with `priority`, conditions jsonb, validity window).

**What this codebase does:** A real rules-shaped pricing engine separate from the product. Modifiers compose by priority. Customer groups, qty tiers, validity windows are first-class. This is well above Shopify-shape pricing and is one of the genuinely strong parts of the codebase.

**Gap to agent-native standard:** No bundle pricing primitive (you can't say "X+Y together = $Z"). No `NegotiationSession` — agents can't open a structured back-and-forth where the seller can counter-offer. The composition order between discount, BNPL fee, tax, and shipping isn't formalized — it's expressed inside checkout hooks.

**What it would take to reach 5/5:** Add a `bundles` entity (composite price + member entities); add a `negotiation_sessions` table with offer/counter rows and a state machine; specify the canonical modifier composition order in code, not in checkout hooks.

---

### Layer 14 — Compliance, Tax & Regulatory

**Score:** 1/5 — Embryonic

**Evidence:** `packages/core/src/modules/tax/adapter.ts` — `TaxAdapter` with `calculateTax`/`reportTransaction`/`voidTransaction`. Implementations: TaxJar + manual.

**What this codebase does:** Tax delegates to adapters cleanly; both jurisdictions and product-tax-codes flow through. Manual adapter exists for low-volume / single-rate cases.

**Gap to agent-native standard:** Tax adapter is the only compliance surface. No sanctions screening, no AML hooks, no geo restrictions on products, no retention/deletion policy primitive, no agent-mediated transaction flagging. "We'll handle it manually" is the de facto policy outside tax.

**What it would take to reach 5/5:** Add `ComplianceAdapter` slot (sanctions list lookup, KYC, AML), per-entity `geographicRestrictions` field, retention policy definitions in config, and structured agent-mediated-transaction reporting.

---

### Layer 15 — Returns, Reverse Logistics

**Score:** 1/5 — Embryonic

**Evidence:** No `returns` table in `packages/core/src/modules/`. `packages/plugins/plugin-marketplace/src/schema.ts` has `returnRequests` for marketplace flows. Order state machine has `refunded` as terminal.

**Gap to agent-native standard:** Core has refunds-as-state, not Returns-as-entity. No structured reason codes, no reverse logistics workflow, no warranty/repair concept, no exchange flow. Marketplace plugin partially fills this for vendor flows but not for the universal case.

**What it would take to reach 5/5:** Promote `returns` into core with its own state machine, structured reason taxonomy, refund routing (full/partial/store-credit/exchange), and a reverse-logistics adapter slot for shipping-label generation.

---

### Layer 16 — Customer & Merchant Profile Intelligence

**Score:** 1/5 — Embryonic

**Evidence:** `packages/core/src/modules/customers/schema.ts` — `customers` (email/phone/firstName/lastName + jsonb metadata), `customer_addresses`, `customer_groups`, `customer_group_members`. No `consent_grants` table. No `customer_preferences` table beyond the metadata bag.

**What this codebase does:** Customer is identity + address + groups. The metadata jsonb is the escape hatch for everything else.

**Gap to agent-native standard:** No structured preferences (sizes, brand affinity, channel preference, locale). No consent ledger (just an opt-in boolean implied by metadata). No merchant scorecard (fulfillment SLA, return rate, dispute rate). No GDPR/DPDP export-and-delete primitives. Cross-merchant intelligence with consent gates doesn't exist.

**What it would take to reach 5/5:** Add `customer_preferences` (typed key-value), `consent_grants` (scope + expiry + revocation), `merchant_scorecards`, and `data_subject_request` workflow.

---

### Layer 17 — Event Stream, Webhooks & Async Orchestration

**Score:** 2/5 — Partial

**Evidence:** `packages/core/src/kernel/hooks/registry.ts:51` — `emit()` iterates handlers and try/catch-logs errors. `packages/core/src/modules/webhooks/schema.ts` — endpoints, signed deliveries, retry counters, dead-letter via `failedAt`. `packages/core/src/kernel/jobs/runner.ts` — durable claim-based job queue. Webhook delivery routed through the job queue.

**What this codebase does:** Outbound webhooks are real — endpoint registration, signing, retry, idempotent processing of inbound webhooks, SSRF guard. The job queue is durable and survives cold starts. The hook registry has a fire-and-forget `emit()`.

**Gap to agent-native standard:** Hooks are not typed events. `emit("production.afterComplete", payload)` takes an `unknown` payload — there is no `DomainEvent = { type: "order.created"; payload: ... } | { type: "payment.authorized"; payload: ... } | ...` discriminated union. Subscribers don't get typed events; they get a hook key and an `unknown`. Cross-process pub/sub is absent — the hook bus is in-process; the only way one process triggers another is via the database job queue. No event replay tool. Replay is a documented gap, not a feature.

**What it would take to reach 5/5:** Define a `DomainEvent` discriminated union in `kernel/events/`; replace `hooks.emit()` for cross-module communication with a typed `eventBus.publish(event)`; add an `EventBusAdapter` slot with in-process / SQS / Kafka implementations; add a replay tool that reads from the job/event log.

---

### Layer 18 — Data Sovereignty & Residency

**Score:** 0/5 — Missing

**Evidence:** No region routing in the database adapter. No data classification tags in schemas. No cross-border transfer logging. Single global database is the assumed shape.

**Gap to agent-native standard:** None of the primitives. For a framework that aspires to deploy across regions, this is the single biggest production blocker.

**What it would take to reach 5/5:** Add region routing in the database adapter (a connection pool per region keyed by `organization.region`); add `sensitivity` tags at column-level via Drizzle metadata; add a `data_transfers` audit log with legal basis; document a sovereign deploy.

---

## Critical Gaps

The five things that block agent-native readiness, in priority order.

### Gap 1: No agent principal type

**Severity:** Critical
**Affected layers/foundations:** F5, L3, L4, L8, L11

`Actor` (`packages/core/src/auth/types.ts:1`) has only `"user" | "api_key"`. Every layer that should be agent-aware inherits this gap. An MCP call from a buyer-agent looks identical to an API-key integration; the framework cannot reason about agent-specific scope, expiry, attestation, or chain-of-authority. Until this is fixed, "AI-native" is marketing copy unsupported by the type system. The fix is structural — replace `Actor` with a `Principal` discriminated union, introduce `AuthorizationGrant`, refactor every `assertPermission` site to a richer `authorize(principal, action, resource)` call, extend the audit log with `grant_id`. This is multi-week work but it's the keystone.

### Gap 2: Single-protocol gateway

**Severity:** High
**Affected layers/foundations:** L4

MCP is the only protocol surface. UCP and ACP are entirely absent. There is no `/.well-known/commerce-capabilities`. A `ProtocolDefinition` interface should be introduced, MCP should be refactored into one, and UCP + ACP should land alongside. Without this, the framework cannot participate in the agentic-commerce ecosystem; it can only host MCP-aware agents.

### Gap 3: Hooks are not typed events

**Severity:** High
**Affected layers/foundations:** L17

`hooks.emit(key, payload: unknown)` is a string-keyed fire-and-forget bus. There is no `DomainEvent` discriminated union. Subscribers receive an `unknown` payload and must type-cast. Cross-process events are only possible through the job queue. For agent-native commerce — where event replay, attribution chains, and per-event signing are routine — the hook bus and the event bus need to separate. The refactor is an additive `EventBusAdapter` and a typed `DomainEvent` union; existing hooks can stay where they are.

### Gap 4: No conversation / channel substrate

**Severity:** High
**Affected layers/foundations:** L7

There is no `Conversation` entity, no `ChannelAdapter`, no persistent conversation memory. In markets where WhatsApp is the primary channel, agent-mediated commerce cannot run on this kernel without building this layer from scratch. This is a missing layer rather than a broken one — the foundations support it cleanly.

### Gap 5: Hook ordering is positional, not declared

**Severity:** Medium
**Affected layers/foundations:** F3

Plugins compose by transforming config in registration order. A plugin can declare `requires` (a presence check) but cannot declare `runs.before`/`runs.after` on individual hook registrations. With ten plugins each touching `orders.afterCreate`, ordering becomes runtime-inferred, not statically guaranteed. Adding declared ordering with topological sort and cycle detection at boot is a small change that prevents large regressions later.

### Gap 6: Returns missing from core

**Severity:** Medium
**Affected layers/foundations:** L15, L6

Returns live in the marketplace plugin, not in core. The order state machine treats refunds as terminal, not as a flow with its own states, reasons, evidence, and routing. Agent-initiated returns cannot be modeled cleanly without promoting Returns to a core entity.

### Gap 7: No data residency / region awareness

**Severity:** Medium (becomes critical at scale)
**Affected layers/foundations:** L18

Single global database. No per-org region routing in the database adapter. No data classification tags. No cross-border transfer audit. For a framework that already speaks "deploys to Cloudflare Workers globally," this is the largest production blocker once a real workload arrives.

---

## Strengths to Preserve

### Strength 1: Adapter discipline

Every cross-vendor concern goes through an interface, with no Stripe/TaxJar/Meilisearch leakage into core business logic. Multiple implementations exist for payments, tax, search, storage. This is not a future direction — it's the current state. Preserve it; reject every PR that imports a vendor SDK in core.

### Strength 2: PayloadCMS-style plugin manifest

`defineCommercePlugin` (`packages/core/src/kernel/plugin/manifest.ts:165`) is a real plugin contract — schema + hooks + routes + MCP tools + analytics models + permission scopes — with declared dependencies. The dozen real plugins in `packages/plugins/` validate that this contract is usable. Preserve the config-transform shape; extend it with declared hook ordering and a protocol slot.

### Strength 3: Durable, claim-based job queue

`packages/core/src/kernel/jobs/runner.ts` does what most "serverless-first" frameworks promise and don't ship: a database-backed queue claimed via `FOR UPDATE SKIP LOCKED`, with a stale-claim reaper, runnable from a serverless cron endpoint or in-process. This is load-bearing infrastructure; do not replace it with an external queue without preserving the contract.

### Strength 4: Order state machine

`packages/core/src/kernel/state-machine/machine.ts` is a typed transition table with `assertTransition` enforcement and clean plugin extension. The status history table records every transition with actor and reason. Preserve it; extend it with `pending_approval` for agent-initiated orders that need human escalation.

### Strength 5: Pricing engine

The `prices` + `price_modifiers` schema (`modules/pricing/schema.ts`) is genuinely above the headless-commerce baseline — typed modifier kinds, priority composition, customer groups, validity windows, qty tiers. This is the right substrate for negotiation and agent-aware pricing.

### Strength 6: Security posture

The branch carries a heavy security-hardening trail and it shows in the code: SSRF guard on webhook URLs, hashed sign-in rate-limit keys, CSP/CSRF/body-limit middleware, edge-runtime probing, idempotency tables for inbound webhooks, organization-scoped tenancy on every table. The team has earned the right to harden the agent-principal layer next; the discipline is already in place.

---

## Migration Path

### Phase 1 — Foundation work (Months 0–3)

**Goal:** Reshape the principal model and clean up the structural gaps that block every agent-native layer.

**Scope:**
- Replace `Actor` with `Principal` discriminated union; introduce `AuthorizationGrant` with structured scope (actions, max amount, merchant whitelist, expiry, escalateAbove).
- Refactor every `assertPermission` site (~40 occurrences across modules) to `authorize(principal, action, resource)`.
- Extend `commerce_audit_log` with `grant_id` and `acting_for` columns.
- Add declared hook ordering (`runs.before`/`runs.after`) with topological sort and cycle detection at boot.
- Promote `hooks.emit()` consumers that cross modules to a new typed `EventBus` with a `DomainEvent` discriminated union; keep in-process and Drizzle adapters.

**Acceptance criteria:**
- An agent grant with `maxAmount = 50000 cents` is rejected at `authorize()` for a $600 order without reaching service code.
- Two plugins both registering on `orders.afterCreate` with conflicting `runs.before` declarations fail at boot, not at request time.
- A `DomainEvent` payload is statically typed at the subscriber.

### Phase 2 — Agent-facing primitives (Months 3–9)

**Goal:** Make the framework usable by agents end-to-end.

**Scope:**
- Add `ProtocolDefinition` interface; refactor MCP into one; implement UCP and ACP alongside; expose `/.well-known/commerce-capabilities`.
- Promote Returns into a core entity with its own state machine and reason taxonomy.
- Introduce `Conversation` entity + `ChannelAdapter` interface; ship at least web-chat and one messaging adapter.
- Add `entity_embeddings` table, `VectorSearchAdapter` slot, hybrid keyword+semantic search.
- Add `SellerAgent` entity + agent-runtime that loads persona/tools/scope and runs against the kernel under typed grants.
- Add `AgentVerificationAdapter` (Web Bot Auth / KYA) called in middleware.

**Acceptance criteria:**
- A buyer-agent can complete a full purchase via UCP, ACP, or MCP — same outcome, same audit trail.
- A return can be initiated by an agent, approved automatically under a grant, refunded, and audited.
- An attestation header verified by the adapter shows up in the `Principal.agent.attestation` field.

### Phase 3 — Production-grade depth (Months 9–18)

**Goal:** Trust, compliance, attribution — the layers that let agent commerce scale safely across markets.

**Scope:**
- Add `attribution_events` and rebuild marketplace commission to consume from it; surface per-agent measures in Cube.
- Add `agent_circuit_breaker` rules with anomaly inputs; auto-revoke grants on threshold breaches.
- Add `ComplianceAdapter` slot (sanctions, AML, KYC) and per-entity geo restrictions.
- Add region routing to the database adapter; add `data_classification` tags; add `data_transfers` audit log; document a sovereign deploy.
- Add `customer_preferences`, `consent_grants`, `merchant_scorecards`; ship GDPR/DPDP export-and-delete primitives.
- Add `RateLimitStoreAdapter` so rate limits hold across instances.
- Ship `agent-sim` package and OTel instrumentation across adapters.

**Acceptance criteria:**
- A multi-party transaction (buyer-agent → seller-agent → vendor) produces a structured attribution chain and a correctly-split payout.
- A grant can be revoked and the revocation propagates to in-flight requests within the audit window.
- A region-bound organization's data does not leave its region except through the `data_transfers` audit path.

---

## Risk Register

| Risk | Likelihood | Impact | Layer | Mitigation |
|---|---|---|---|---|
| Compromised API key cannot be revoked instantly under load (no event-driven propagation) | High | Critical | F5, L3 | Phase 1: introduce typed event bus + grant revocation events with subscriber on every node |
| Two plugins disagree on hook ordering, manifest in production, debugged via timing | High | Medium | F3 | Phase 1: declared ordering + topological sort + cycle detection at boot |
| BNPL eligibility implemented as ad-hoc checkout metadata diverges across regional plugins | High | High | L5, L13 | Promote BNPL eligibility to a typed product/price-time attribute in Phase 2 |
| Cloudflare Workers deploy attempted but the schema's PG-specific features fail | Medium | High | F2, F4 | Either ship a SQLite/D1 adapter or document the platform constraint clearly in the README |
| In-process rate limiter is bypassed by serverless fan-out | High | High | F4 | Phase 3: `RateLimitStoreAdapter` with Redis/Durable Objects implementation |
| Audit log lacks grant context, making post-incident attribution ambiguous | Medium | High | F5, L3 | Phase 1: add `grant_id` + `acting_for` columns; backfill is unnecessary, just move forward |
| Agent calls succeed without verification (anyone claiming "I am a buyer-agent" gets in) | High | Critical | L11, F5 | Phase 2: `AgentVerificationAdapter` + Web Bot Auth at middleware |
| GDPR/DPDP request cannot be fulfilled cleanly because consent and preference data live in jsonb metadata | Medium | High | L16, L18 | Phase 2/3: structured `consent_grants` and `customer_preferences`; per-region routing in Phase 3 |
| `setInterval` autorun misconfigured on edge runtime, leaking handles silently | Low | Medium | F4 | Refuse to enable autorun when `isNodeRuntime()` returns false; throw at boot |
| Returns implemented divergently across marketplace and direct flows | Medium | Medium | L15 | Phase 2: promote Returns to core, deprecate marketplace-local table |

---

## Final Verdict

UnifiedCommerce Engine is a credible mid-stage headless commerce kernel with above-average infrastructure discipline — adapters, plugins, durable jobs, typed state machine, security posture — and a single load-bearing gap that defines its agent-native readiness: there is no agent in the principal model. The framework can serve an agent today through MCP, but the call site cannot reason about who the agent is, what it can do, until when, on whose behalf, with what evidence. Refactoring this is structural work, but it's not a rewrite — every other layer is in good enough shape to absorb the change.

Eighteen months of disciplined work along the migration path above plausibly lands the framework at a 3.5+ overall score: solid principals, multi-protocol gateway, conversation layer, attribution chain, region routing, agent verification. The substrate to do that work is already here.

**Recommendation:** **Continue and extend.** The foundations are strong enough to refactor in place. Start with Phase 1 — the principal model is the keystone and everything compounds off of it. Do not start fresh; the adapter discipline, plugin manifest, durable job queue, and pricing engine are too good to throw away.

---

*Audit conducted using the Agent-Native Commerce Framework Blueprint. The blueprint defines 5 foundations and 18 layers required for a TypeScript headless commerce framework to natively serve AI agents — both buyer-side agents (consumer shopping, procurement) and seller-side agents (sales, retention, support) — across regions, payment rails, and conversation channels.*
