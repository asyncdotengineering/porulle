# Framework Research Wiki
## unified-commerce-engine → batteries-included TypeScript framework

> **Research conducted:** Three parallel deep-dive agents — philosophical historian, forensic architect, and egoist reverse engineer — followed by synthesis.  
> **Goal:** Determine if the foundation of `unified-commerce-engine` is strong enough to extract into a standalone framework, and if so, how.

---

## Table of Contents

1. [The Thesis](#1-the-thesis)
2. [First Principles — The 5 Founding Beliefs](#2-first-principles--the-5-founding-beliefs)
3. [Inspiration Inventory](#3-inspiration-inventory)
4. [Technical Architecture — Layer Map](#4-technical-architecture--layer-map)
5. [Pattern Inventory](#5-pattern-inventory)
6. [Type Safety Audit](#6-type-safety-audit)
7. [Technical Debt Register](#7-technical-debt-register)
8. [Framework vs Domain Boundary](#8-framework-vs-domain-boundary)
9. [The Framework API Design](#9-the-framework-api-design)
10. [Comparison: AdonisJS / NestJS / Blitz.js](#10-comparison-adonisjs--nestjs--blitzjs)
11. [Migration Plan](#11-migration-plan)
12. [Hard Truths](#12-hard-truths)
13. [Recommendation](#13-recommendation)

---

## 1. The Thesis

**The founding insight (from `VISION.md`):**
> "You cannot out-Shopify Shopify. The whitespace is commerce infrastructure for vertical SaaS builders."

Every time a developer builds a commerce-enabled vertical SaaS — a restaurant POS, a fitness booking platform, a B2B procurement tool — they spend ~80% of their time rebuilding solved problems: catalog, cart, checkout, orders, inventory, auth, multi-tenancy, payments, webhooks. They spend ~20% building the domain-specific value that actually differentiates their product.

`unified-commerce-engine` owns that 80% completely. The 20% is all a builder ever writes.

The question this wiki answers: **Is the foundation of this engine reusable as a standalone framework, and can the commerce engine itself be rebuilt as an application on top of it?**

The answer: **Yes, but do it surgically.** The foundation is already 80% a framework. The contamination is concentrated and fixable. Three specific debt items block extraction; fix those first, then the extraction is mostly renaming and packaging.

---

## 2. First Principles — The 5 Founding Beliefs

These five beliefs appear in every major architectural decision in the codebase. They are not aspirational — they are structurally enforced.

---

### Belief 1: The config is the application

**What this means:** Everything is declared in TypeScript. No YAML, no database UI, no magic registries. The config is the application — you can read `defineConfig(...)` top-to-bottom and understand exactly what the application does. There are no hidden registration steps.

**Where it appears:**
- Plugins are `(config) => config` — a pure config transform. Composition is visible as a sequential list.
- The hook registry has no discovery mechanism. You register explicitly or not at all.
- `defineConfig()` is a synchronous top-to-bottom evaluation. After it runs, you have a frozen config object.

**Borrowed from:** PayloadCMS v3's plugin model. RFC-004 documents this explicitly: *"A plugin is a function that receives the whole application config and returns a modified config."*

---

### Belief 2: One extension primitive

**What this means:** Where most frameworks have an event bus alongside hooks, middleware chains alongside interceptors, and DI containers alongside plugin registries — this codebase has exactly one: lifecycle hooks with three ordered slots.

**Where it appears:**
- No event bus. No pub/sub. The hook registry with `prepend/configure/append` is the entire event system.
- No DI container. Service dependencies are explicit constructor arguments.
- No decorator magic. No reflection metadata. No annotations.

**The 74-line hook registry (`kernel/hooks/registry.ts`) is the entire extension system.** This is a feature, not a limitation.

---

### Belief 3: The adapter is the seam

**What this means:** Every external dependency that could trap a developer in a vendor relationship is wrapped in an interface and given a swap path. This is not cosmetic — the adapters are real and tested.

**Where it appears:**
- `DatabaseAdapter`, `StorageAdapter`, `PaymentAdapter`, `SearchAdapter`, `TaxAdapter`, `JobsAdapter`, `EmailAdapter` — all in separate packages.
- RFC-002 eliminated SQLite not because they couldn't support it, but because `pgTable` from `drizzle-orm/pg-core` can't run on SQLite. The adapter existed but the seam was not clean. They fixed the seam rather than pretending it was clean.
- 10 adapter packages published separately so you only install what you need.

---

### Belief 4: Serverless is a design constraint, not a deployment target

**What this means:** Every decision is filtered against a cold-start budget (<50ms for critical path) and stateless execution. This fundamentally shapes every architecture choice.

**Where it appears:**
- Hono over Express/Fastify: Hono uses native `Request`/`Response` (Web Standards API). Runs identically on Cloudflare Workers, Vercel Edge, AWS Lambda, Bun, Node.js without shims.
- Drizzle over Prisma: Prisma's query engine is a separate binary process that restarts on every cold start (200–500ms overhead). Drizzle compiles to SQL at build time.
- Database-backed job queue (`DrizzleJobsAdapter`): no external Redis, no stateful process assumptions. Jobs survive process restarts as database rows.
- The MCP transport is stateless per-request: a new `McpServer` + transport per incoming connection.

---

### Belief 5: AI agents are co-equal consumers

**What this means (from `VISION-AGENTIC.md`):** *"Nobody is building this... UC can treat AI as the architecture."*

The MCP server is not a plugin. It is mounted alongside the REST API at every `createServer()` call. Every plugin is required to export MCP tools. The analytics system was rebuilt (RFC-006) to query source tables directly so agents get structured, accurate answers without ETL pipelines.

**Where it appears:**
- `getMCPActor()` is a built-in kernel method, not a plugin hook.
- `@modelcontextprotocol/sdk` is a runtime dependency, not dev-only.
- RFC-041: tool count above 20 degrades agent performance by up to 85% (Microsoft Research). This led to a deliberate curation of 15–18 tools instead of 66. This is a product design decision for an AI consumer — unprecedented in open-source commerce platforms.

---

## 3. Inspiration Inventory

| Component | Inspired By | What Was Borrowed | What Was Adapted / Rejected |
|-----------|-------------|-------------------|-----------------------------|
| Plugin system | PayloadCMS v3 | `Plugin = (config) => config` — plugin as config transform | Rejected class-based manifest registration; kept manifest as internal helper returning a config transform |
| Hook three-slot ordering | PayloadCMS collections | prepend/configured/append slot concept | PayloadCMS hooks run in registration order only; UC adds the three-tier guarantee |
| HTTP framework | Hono | Web Standards API, `@hono/zod-openapi` typed routes, Cloudflare Workers native | Rejected Express (Node.js only), Fastify (Node.js only), Elysia (Bun-only), NestJS (wrong philosophy) |
| Auth | Better Auth | Organization plugin, API key plugin, shared Drizzle database with commerce tables | Rejected NextAuth (Next.js tight coupling), Clerk (vendor lock-in), Lucia (deprecated by author) |
| ORM | Drizzle ORM | `$inferSelect`/`$inferInsert` type inference, zero-runtime, pg-core | Rejected Prisma (binary process, poor cold start), TypeORM (class decorators, reflection), Kysely (no schema definition) |
| MCP protocol | Anthropic MCP SDK | `McpServer`, `WebStandardStreamableHTTPServerTransport`, Zod input schemas | Rejected PayloadCMS's thin `plugin-mcp` approach; built full tool coverage with curated 15-18 tools |
| Multi-tenancy | django-multitenant, Blitz.js | `organizationId` on every table, session-level org context | RFC-022 proposes `defineTable` abstraction for auto-injecting `organizationId` — not yet implemented |
| Analytics | Originally CubeJS → replaced | DrizzleAnalyticsAdapter queries source tables directly (RFC-006, RFC-061) | Rejected CubeJS entirely — dependency removed. Direct SQL is simpler, faster, agent-queryable |
| Job queue | PayloadCMS `payload-jobs` | Jobs as database rows, survive restarts, serverless-compatible | Built as `DrizzleJobsAdapter`; not yet fully featured (no resumable workflows, no job graph) |
| Tool curation | Shopify Storefront MCP (4 tools) + Microsoft Research | Deliberate curation of 15–18 workflow tools vs auto-generated 66 | Rejected "one tool per route" auto-generation that FastMCP warns against |

---

## 4. Technical Architecture — Layer Map

```
┌────────────────────────────────────────────────────────────────┐
│  Layer 8: HTTP Server (createServer)                           │
│  Security middleware, CORS, CSRF, rate limiting, error handler │
│  → Hono + OpenAPIHono                                          │
├────────────────────────────────────────────────────────────────┤
│  Layer 7: Interfaces                                           │
│  REST: OpenAPIHono + Zod-validated routes (14 route files)     │
│  MCP:  McpServer + WebStandardStreamableHTTP transport         │
│  Portal: Customer self-service routes                          │
├────────────────────────────────────────────────────────────────┤
│  Layer 6: Commerce Instance (createCommerce)                   │
│  Headless entry point. Returns api, kernel, db, auth.          │
│  api = createLocalAPI() — Proxy that auto-injects actor + tx   │
├────────────────────────────────────────────────────────────────┤
│  Layer 5: Plugin System (defineCommercePlugin)                 │
│  Plugins transform config: (config) => config                  │
│  Slots: schema, hooks, routes, mcpTools, analyticsModels       │
│  Routes/tools are deferred closures evaluated at kernel boot   │
├────────────────────────────────────────────────────────────────┤
│  Layer 4: Kernel (createKernel)                                │
│  Synchronous factory. Manually wires 17 services.              │
│  Applies withTiming() proxy to all services.                   │
│  Registers config hooks + system hooks (audit, webhooks, etc.) │
├────────────────────────────────────────────────────────────────┤
│  Layer 3: 17 Domain Modules                                    │
│  catalog, orders, inventory, cart, customers, payments,        │
│  fulfillment, pricing, promotions, tax, shipping, search,      │
│  media, analytics, webhooks, audit, organization               │
│  Each: service.ts + repository/index.ts + schema.ts            │
├────────────────────────────────────────────────────────────────┤
│  Layer 2: Hook System (HookRegistry)                           │
│  Three tiers: prepended → configured → appended                │
│  BeforeHook transforms data, AfterHook fires side-effects      │
│  20-second per-hook timeout via withTimeout()                  │
├────────────────────────────────────────────────────────────────┤
│  Layer 1: Kernel Primitives                                    │
│  Result<T,E>, DatabaseAdapter, JobsAdapter, StateDefinition    │
│  CompensationChain, LocalAPI proxy, withTiming proxy           │
│  Auth primitives: Actor, assertPermission, access combinators  │
└────────────────────────────────────────────────────────────────┘
                            │
                            ↓
┌────────────────────────────────────────────────────────────────┐
│  Layer 0: Config / Type System (defineConfig + CommerceConfig) │
│  User input + plugin accumulation in one type (debt: see §7)   │
└────────────────────────────────────────────────────────────────┘
```

**Scale:** ~26,600 lines in core, ~51,100 lines in plugins, ~8,800 in core tests.

---

## 5. Pattern Inventory

### Plugin Pattern (PayloadCMS-style config transform)
| | |
|---|---|
| **What** | `CommercePlugin = (config) => config`. Each plugin transforms the config by merging hooks, schemas, routes (as deferred closures), and MCP tools. |
| **Quality** | Well-implemented. The closure chain for deferred routes is correct — routes can't access the kernel until it's constructed, so the chained function evaluated at boot is the right approach. |
| **Tradeoff** | `config.routes` and `config.mcpTools` become opaque function chains — not serializable, not inspectable without executing them. The config accumulates state (`customSchemas`) rather than being a pure transform. |
| **Verdict** | ✅ Keep as-is. The slight impurity of `customSchemas` accumulation is harmless. |

### Three-Tier Hook Ordering
| | |
|---|---|
| **What** | `HookRegistry` with `prepended / configured / appended` per hook key. Resolve() concatenates in order. |
| **Quality** | Correctly designed. System hooks (audit, webhooks) always land in `appended`. User-configured hooks occupy `configured`. Plugins can `prepend` to run before everything. |
| **Tradeoff** | Hook keys are strings (`"orders.afterCreate"`). Misspelling silently produces a no-op. |
| **Verdict** | ✅ Architecture is correct. The string-key problem is the hook registry's type safety issue (see §6). |

### Repository Pattern
| | |
|---|---|
| **What** | Classes accepting `DrizzleDatabase`. All methods accept optional `TxContext`. Repositories do `const db = ctx?.tx ?? this.db`. |
| **Quality** | Solid. Testable in isolation, composable under transactions. |
| **Tradeoff** | No unit of work / aggregate root. Multi-service operations (checkout's 6-step saga) thread `TxContext` manually through 4 service call chains. |
| **Verdict** | ✅ Correct for this use case. |

### Compensation Chain (Saga pattern)
| | |
|---|---|
| **What** | `runCompensationChain()` in `kernel/compensation/executor.ts`. Steps have `run()` and optional `compensate()`. On failure, reverse-order compensation runs. |
| **Quality** | Well-designed. The comment "A failed compensation is a separate operational concern" is honest and correct. |
| **Tradeoff** | No distributed transaction guarantee. Compensation can fail, leaving partial state. |
| **Verdict** | ✅ Correct for serverless single-DB deployments. |

### Result Type
| | |
|---|---|
| **What** | `Result<T, E>` discriminated union. `Ok(value)` and `Err(error)` constructors. All service methods return this. |
| **Quality** | Correctly implemented. Forces callers to handle errors at the type level. |
| **Tradeoff** | Routes extract values with unchecked pattern matching in several places. `as any` casts in test files work around the typed `BeforeHook<T>` signature. |
| **Verdict** | ✅ Best primitive in the codebase. Should be the return type for all framework-level service calls. |

### Timing Proxy
| | |
|---|---|
| **What** | `withTiming()` ES Proxy wraps every service method. Logs slow calls (>100ms), failed calls. Disabled in test env. |
| **Quality** | Correct. `value.apply(target, args)` preserves `this` binding. `instanceof` checks would fail but are not used in this codebase. |
| **Tradeoff** | Applied after the service container cast — the typed `services` object and runtime Proxy objects are permanently diverged after kernel boot (see Critical Observation #4 in §7). |
| **Verdict** | ✅ Good pattern. The post-cast application is a debt to track. |

### Local API Proxy
| | |
|---|---|
| **What** | `createLocalAPI()` — double Proxy (service-level + method-level). Auto-injects actor + txCtx to every service call. WeakMap cache for method wrappers. |
| **Quality** | Elegant. WeakMap caching is necessary to avoid GC pressure in hot paths. |
| **Tradeoff** | `CleanService<T>` mapped type erases parameter signatures to `(...args: unknown[]) => R`. Callers lose type-checking for `actor`/`ctx` params they're no longer passing. |
| **Verdict** | ✅ This is the right answer for the Next.js App Router era. Should be the default promoted path. |

### State Machine
| | |
|---|---|
| **What** | Simple adjacency-list in `kernel/state-machine/machine.ts`. Atomic CAS in repository: `WHERE status = :current`. `extendOrderStateMachine()` merges custom transitions. |
| **Quality** | Correct. The optimistic lock prevents concurrent invalid transitions. |
| **Tradeoff** | `OrderState = string` — no compile-time state enum. Custom transitions can introduce states that no handler covers. |
| **Verdict** | ✅ The generic FSM primitives are framework-level. The order-specific states are domain. |

### Service Container (the problem pattern)
| | |
|---|---|
| **What** | `serviceContainer = services as Record<string, unknown>` — typed partial cast to an untyped bag. Services reach each other via inline casts: `this.deps.services.inventory as { adjust(...): ... }`. |
| **Quality** | Antipattern. Works at runtime, breaks the compiler's ability to catch interface changes. |
| **Tradeoff** | Every cross-service call site is independently unchecked. If `inventory.adjust()` changes its signature, no compile error at the 5 call sites in `orders/service.ts`. |
| **Verdict** | ❌ Must be fixed before framework extraction. See §9 for the module system design that resolves this. |

---

## 6. Type Safety Audit

### Severity: Critical

**`HookHandler = (...args: never[]) => unknown`** — `registry.ts:1`

The single most embarrassing type in the codebase. `never[]` as rest parameters means "this function accepts no arguments." Every hook registration casts to `as HookHandler`; every resolution casts back to `as BeforeHook<X>[]` or `as AfterHook<Y>[]`. These casts are entirely unchecked. The hook system is the primary extension primitive — if anything in this codebase should have strong types, it's this.

**Fix:** Define a `HookMap` at the application level mapping hook keys to their typed handler signatures. Make `HookRegistry` generic over this map. See §9 for the API design.

---

**`serviceContainer as Record<string, unknown>`** — `kernel.ts:223`

Typed services cast to a property bag, passed to every service constructor. Every inter-service call requires an inline narrowing cast at the call site. If any service method signature changes, there is zero compile-time notification to the 5+ call sites that use it via this bag.

**Fix:** Module system with typed dependency declarations (see §9). Each module declares exactly which other services it needs, typed precisely.

---

### Severity: High

**`getMCPActor()` hardcoded `userId: "mcp-agent"` with `organizationId: DEFAULT_ORG_ID`** — `kernel.ts:381`

In multi-tenant deployments, every MCP tool call runs as `org_default`. Every audit log entry from an AI operation is attributed to the magic string `"mcp-agent"`. RFC-040 deferred this; it cannot be deferred indefinitely.

**`services[key] = withTiming(...)` writes an opaque Proxy through `as Record<string, unknown>`** — `kernel.ts:362`

After the timing loop, `services.catalog` is a Proxy, but TypeScript still thinks it's `CatalogServiceImpl`. Static types and runtime types permanently diverge after kernel boot.

**Order number generation is not concurrent-safe** — `orders/repository/index.ts`

`getNextOrderNumber()` does `SELECT COUNT(*) FROM orders WHERE YEAR = :year` then computes `count + 1`. Under concurrent inserts, two transactions read the same count and generate duplicate order numbers. Must use a PostgreSQL sequence.

**URL alias re-dispatch double-invokes all middleware** — `server.ts:257`

Every `/api/products` request clones itself to `/api/catalog/entities?type=product` via `app.fetch()`. This sends the request through CORS, CSRF, body-limit, all three rate limiters, and auth middleware again. The rate limiter increments **twice** per request, potentially causing premature rate-limiting.

---

### Severity: Medium

**`@ts-expect-error` on every `router.openapi()` call** — ~30 occurrences across route files

Hono's `openapi()` enforces strict return type matching. The project's unified `Result<T>` discrimination pattern doesn't satisfy Hono's per-route generics. A typed response builder would resolve all 30 suppressions at once.

**`async` plugins vs synchronous kernel** — `config/types.ts:268`

`CommercePlugin = (config) => CommerceConfig | Promise<CommerceConfig>`. If someone writes an async plugin, the config they chain becomes `Promise<CommerceConfig>`. `createKernel(config)` is synchronous — it would silently receive a Promise object. The async return type is either unused or a footgun. Remove it or enforce async kernel.

**`DrizzleJobsAdapter.enqueue()` hardcodes `DEFAULT_ORG_ID`** — `kernel/jobs/drizzle-adapter.ts:26`

Any background job enqueued without an explicit `organizationId` goes to `org_default`. Silently misroutes jobs in multi-tenant deployments.

---

### Severity: Low

**`_registeredPlugins` module-level mutable global** — `manifest.ts:97`

Shared across concurrent `defineConfig()` calls. Breaks parallel test runs and hot module reloading. See TD-001.

**`AnalyticsConfig.models?: unknown[]`** — `config/types.ts:235`

The `AnalyticsModel` type exists but isn't used here. Two-line fix.

**`routes?: (app: Hono<any>, kernel: Kernel) => void`** — `config/types.ts:340`

`Hono<any>` propagates `any` to all custom route consumers. `ServerEnv` can't be imported from `types.ts` due to circular dependency. Extract `ServerEnv` to a shared file.

---

## 7. Technical Debt Register

| ID | Location | Description | Root Cause | Fix Complexity |
|----|----------|-------------|------------|----------------|
| **TD-001** | `manifest.ts:97` | `_registeredPlugins` module-level global Set. Breaks parallel test runs, HMR. | Quick solution for sequential plugin tracking without threading a parameter. | Medium — thread a `registeredPlugins` set through `defineConfig()` context. |
| **TD-002** | `kernel.ts:223, 362` | `serviceContainer as Record<string, unknown>`. Typed services cast to untyped bag. Timing proxy writes back through same cast. | `Kernel["services"]` doesn't have slots for plugin services; timing proxy can't update typed interface. | High — requires module system or typed plugin service slots. |
| **TD-003** | `registry.ts:1` | `HookHandler = (...args: never[]) => unknown`. Entire hook system is type-unsafe at the boundary. | TypeScript can't do discriminated lookup on string keys without a mapped type. | Very High — requires `HookMap` type and generic registry. The debt must be paid before framework publication. |
| **TD-004** | `orders/service.ts:390-455`, `catalog/service.ts:488` | Cross-service calls via inline type narrowing casts. Same cast pattern repeated 5+ times in orders alone. | `deps.services: Record<string, unknown>` is the type. | Low — change service constructors to accept `ServiceRegistry` interface (already defined in `kernel/service-registry.ts`). |
| **TD-005** | `config/types.ts:235` | `AnalyticsConfig.models?: unknown[]`. `AnalyticsModel` type exists but isn't used. | Oversight. | Low — two lines. |
| **TD-006** | `config/types.ts:340` | `routes?: (app: Hono<any>, kernel: Kernel) => void`. `any` propagates. | `ServerEnv` circular import from `server.ts`. | Low — extract `ServerEnv` to a shared types file. |
| **TD-007** | `auth/org.ts:14` | `let _bootDefaultOrgId: string | undefined` — module-level mutable state for org ID. | Services lack config access; quick propagation mechanism. | Medium — thread through `HookContext` or require explicit parameter at all call sites. |
| **TD-008** | `manifest.ts:159-225` | Deferred route registration builds opaque nested closure chain. O(N) call depth at boot. Not debuggable. | Plugins run before kernel exists; routes must be deferred. | Medium — accumulate route registrations as an array; evaluate all at once at kernel boot. |
| **TD-009** | `server.ts:257-287` | URL alias re-dispatch via `app.fetch()` double-invokes all middleware including rate limiter. | Entity aliases were added as convenience; Hono doesn't easily support query parameter injection at routing level. | Medium — handle aliases before middleware, or inject `type` directly into Hono context. |
| **TD-010** | `jobs/drizzle-adapter.ts:26` | `enqueue()` defaults to `DEFAULT_ORG_ID` when `organizationId` is absent. | Jobs need org ID; adapter has no config access. | Low — require `organizationId` in `EnqueueOptions` or thread through context. |
| **TD-011** | `orders/repository/index.ts` | Order number generation is not concurrent-safe (`SELECT COUNT(*)` + 1 under concurrent inserts). | Convenience implementation. | Low — replace with PostgreSQL sequence (`nextval()`). |
| **TD-012** | Gift-cards plugin `hooks.ts` | Plugin hooks that need their own service use a `serviceRef: { current: null }` Proxy-over-null workaround, because hooks run before services are constructed. | Framework lifecycle: `hooks()` runs at `defineConfig()` time; service construction happens at kernel boot. | High — structural. Hooks and routes need access to the same lifecycle moment. See §9 for the module system fix. |

---

## 8. Framework vs Domain Boundary

The contamination is not uniform. It is concentrated in three files.

### Clearly Framework (extract as-is)

| Artifact | File | Notes |
|----------|------|-------|
| `HookRegistry` + executor | `kernel/hooks/` | Zero commerce concepts. Pure pipeline. |
| `Result<T, E>` + `Ok()`/`Err()` | `kernel/result.ts` | Best primitive in the codebase. |
| `DatabaseAdapter` interface | `kernel/database/adapter.ts` | 13-line generic interface. |
| `withTiming()` proxy | `kernel/service-timing.ts` | Generic observability. |
| `runCompensationChain()` | `kernel/compensation/executor.ts` | Generic saga runner. |
| `StateDefinition<T>` + FSM primitives | `kernel/state-machine/machine.ts` | The `extendOrderStateMachine` part is domain; the FSM itself is framework. |
| `createLocalAPI()` proxy | `kernel/local-api.ts` | Domain-agnostic actor/tx injector. |
| `defineCommercePlugin()` skeleton | `kernel/plugin/manifest.ts` | The config-transform pattern is framework. The `mcpTools`/`analyticsModels` slots are domain. |
| `JobsAdapter` + `TaskDefinition` | `kernel/jobs/adapter.ts`, `types.ts` | Generic job queue contract. |
| `createRepository()` factory | `kernel/factory/repository-factory.ts` | CRUD derivation from Drizzle schema. Framework + Drizzle integration. |
| Error class hierarchy | `kernel/errors.ts` | Pattern is framework. "Commerce" prefix is accidental naming. |
| Auth primitives | `auth/permissions.ts`, `auth/access.ts` | `assertPermission`, `accessOR`, `accessAND` — generic RBAC combinators. |
| Security middleware | `runtime/server.ts` (middleware section) | CORS, CSRF, headers, rate limiting — all framework-level. |
| Test harness | `test-utils/` | `createPluginTestApp`, PGlite adapter, test actors — framework infrastructure. |
| `withTransaction()`, `TxContext` | `kernel/database/tx-context.ts` | Generic transaction propagation. |
| `PaginationResult` + `paginate()` | `utils/pagination.ts` | Framework utility. |

### Clearly Domain (stays in commerce engine)

- All 17 domain modules and their schemas
- `CommerceConfig` with all sub-configs (`CartConfig`, `CheckoutConfig`, `OrdersConfig`, etc.)
- `orderStateMachine` default transitions
- `checkout.ts` hook implementations
- `Kernel` interface with concrete typed service slots
- `getMCPActor()` and the MCP agent role definition
- Better Auth integration (`auth/setup.ts`, `auth-schema.ts`)
- `createServer()` with commerce route mounting
- `createCommerce()` with commerce-specific ergonomics
- All 14 plugins, all 10 adapter packages

### The Three Contamination Files

**`runtime/kernel.ts`** — This is the primary contamination point. It instantiates all 17 domain services by name, hardwiring them together. The framework-level structure (service container, hook registration, timing proxy, MCP tool evaluation) is real — but it's wrapped around 200 lines of domain-specific service instantiation that belongs in the commerce layer.

**`config/types.ts`** — `CommerceConfig` serves two roles: user input and accumulated build artifact. Fields like `customSchemas` (marked `@internal`), chained `routes`, and chained `mcpTools` are really framework-internal build state leaking into the public type.

**`kernel/service-registry.ts`** — Hardcodes commerce service interfaces (`inventory.adjust`, `orders.create`, `cart.create`). This is domain code masquerading as framework infrastructure.

Fix these three files and the extraction is mostly renaming and packaging.

---

## 9. The Framework API Design

This section specifies what the extracted framework's public API should look like. This is a design spec, not an implementation.

### App Composition

```typescript
// @aeronyx/framework (working name — rename at will)

interface AppConfig<TModules extends ModuleMap> {
  modules: TModules;
  plugins?: AppPlugin[];
  hooks?: UserHooksConfig;
  middleware?: MiddlewareHandler[];
  routes?: (app: OpenAPIHono<AppEnv>, runtime: AppRuntime<TModules>) => void;
  database: DatabaseAdapter;
  jobs?: JobsConfig;
  logLevel?: LogLevel;
}

interface AppRuntime<TModules extends ModuleMap> {
  services: ServiceMap<TModules>;   // fully typed, no casts
  hooks: HookRegistry;
  database: DatabaseAdapter;
  logger: Logger;
  withActor(actor: Actor): ScopedAPI<TModules>;
  withTransaction(tx: unknown, actor?: Actor): ScopedAPI<TModules>;
}

// Single entry point:
async function createApp<TModules extends ModuleMap>(
  config: AppConfig<TModules>
): Promise<App<TModules>>;
```

Compare to current: `createKernel()` accepts `CommerceConfig` and hardcodes all 17 services at lines 234–346. The framework version makes modules explicit and typed.

---

### Module System (fixes TD-002 and TD-004)

A module is a self-describing unit that declares its schema, service, and typed dependencies:

```typescript
// @aeronyx/framework

interface AppModule<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TService = unknown,
  TDeps extends Record<string, unknown> = {},
> {
  id: string;
  schema: () => TSchema;
  dependencies?: string[];  // IDs of required modules
  service: (deps: ModuleDeps<TDeps>) => TService;
}

interface ModuleDeps<TDeps> {
  db: DatabaseAdapter;
  hooks: HookRegistry;
  services: TDeps;       // only the declared services — fully typed
  config: AppConfig<any>;
  logger: Logger;
}

function defineModule<TSchema, TService, TDeps>(
  manifest: AppModule<TSchema, TService, TDeps>
): AppModule<TSchema, TService, TDeps>;

// In the commerce layer:
const catalogModule = defineModule({
  id: "catalog",
  schema: () => ({ sellableEntities, sellableAttributes, ... }),
  dependencies: ["pricing"],  // typed — errors if pricing module not present
  service: (deps) => new CatalogServiceImpl({
    repository: new CatalogRepository(deps.db),
    hooks: deps.hooks,
    services: deps.services,  // { pricing: PricingService } — fully typed
  }),
});
```

This eliminates every `this.deps.services.inventory as { adjust(...): ... }` inline cast site.

---

### Typed Hook System (fixes TD-003)

The `HookHandler = (...args: never[]) => unknown` problem requires a typed hook map:

```typescript
// @aeronyx/framework

// The app declares its full hook vocabulary:
type HookMap = Record<
  string,
  { before?: (...args: any[]) => any; after?: (...args: any[]) => any }
>;

class TypedHookRegistry<THooks extends HookMap> {
  append<K extends keyof THooks & string>(
    key: K,
    phase: "before" | "after",
    handler: THooks[K]["after"] // or "before"
  ): void;

  resolve<K extends keyof THooks & string>(
    key: K,
    phase: "before"
  ): Array<NonNullable<THooks[K]["before"]>>;
}

// Commerce layer declares its hook vocabulary:
type CommerceHookMap = {
  "catalog.beforeCreate": { before: BeforeHook<CreateEntityInput> };
  "catalog.afterCreate":  { after: AfterHook<SellableEntity> };
  "orders.afterStatusChange": { after: AfterHook<OrderStatusChangeEvent> };
  // ... all hooks typed
};

// Registration and resolution are fully typed — no casts anywhere:
hooks.append("catalog.afterCreate", "after", async ({ result }) => {
  // result is SellableEntity — compiler-verified
});
```

This is the most complex type engineering in the framework. It can be done incrementally: ship string-typed hooks first, add per-hook type safety as a layered enhancement.

---

### Three Config Stages (fixes TD-001, TD-007, and the `@internal` leak)

```typescript
// @aeronyx/framework

// Stage 1: What the developer writes
interface UserConfig<TModules> {
  modules: TModules;
  plugins?: AppPlugin[];
  database: DatabaseAdapter;
  // ... optional fields with defaults
}

// Stage 2: After plugins transform (internal)
interface ResolvedConfig<TModules> extends UserConfig<TModules> {
  hooks: Record<string, HookHandler[]>;     // merged flat map
  schema: Record<string, unknown>[];        // merged from all plugins
  routes: RoutesFn;                         // chained function (still a closure)
  // NO customSchemas/@internal fields exposed here
}

// Stage 3: Runtime (after modules are instantiated)
interface RuntimeConfig<TModules> extends ResolvedConfig<TModules> {
  services: ServiceMap<TModules>;           // instantiated
  database: DatabaseAdapter;               // always resolved
  logger: Logger;
}
```

Currently `DefineConfigInput = CommerceConfig` (a one-line alias that does nothing). The three-stage separation makes plugin accumulation state invisible to users.

---

### Plugin Extension Slots (preserving the PayloadCMS pattern)

```typescript
// @aeronyx/framework — the framework defines framework-level slots
interface FrameworkPluginManifest {
  id: string;
  version: string;
  requires?: string[];
  permissions?: PluginPermission[];
  schema?: () => Record<string, unknown>;
  hooks?: () => PluginHookRegistration[];
  routes?: (ctx: PluginContext) => PluginRouteRegistration[];
  // open extension map — the commerce layer adds mcpTools, analyticsModels here
  extensions?: Record<string, (ctx: PluginContext) => unknown>;
}

// Commerce layer wraps definePlugin to add commerce-specific slots:
// defineCommercePlugin = definePlugin.extend({ mcpTools, analyticsModels })
```

Plugin authors using `defineCommercePlugin` from `@unifiedcommerce/core` get the full commerce slots. Plugin authors who want a pure framework plugin use `definePlugin` from `@aeronyx/framework`.

---

### Hook Lifecycle Fix for Plugins (fixes TD-012)

The `serviceRef: { current: null }` Proxy-over-null pattern in the gift-cards plugin is a symptom of a structural problem: hooks run at `defineConfig()` time but services are constructed at kernel boot. The module system resolves this naturally:

```typescript
// Module service is constructed at boot, before hooks are registered:
const giftCardsModule = defineModule({
  id: "gift-cards",
  service: (deps) => new GiftCardService(deps),
  hooks: (service) => [  // service is the constructed instance
    {
      key: "checkout.afterCreate",
      handler: async (ctx) => service.deduct(ctx),  // no null proxy needed
    },
  ],
});
```

When `service` is constructed first and `hooks(service)` runs second, the lifecycle problem disappears.

---

## 10. Comparison: AdonisJS / NestJS / Blitz.js

### AdonisJS

AdonisJS uses an IoC container with service providers declaring `register()` → `boot()` lifecycle. Its batteries-included story covers Lucid ORM, Auth, Bouncer, Sessions, Mailer, Ally, Limiter — all first-party.

**What to steal:**
- Provider lifecycle guarantees: services declare `after: ['Database']` dependencies and the container sequences instantiation automatically. This eliminates the manual dependency-order wiring in `kernel.ts` lines 234–346.
- First-party adapter packages: the `packages/adapters/` structure already does this correctly.

**What to reject:**
- String-based container (`app.make('Adonis/Addons/Mail')`) loses type safety. The proposed module system with explicit `dependencies` declarations is strictly better.
- Class-based providers are verbose. The config-transform plugin pattern is more composable.

**What this codebase has that AdonisJS doesn't:**
- Plugin-as-config-transform. AdonisJS providers are registered in `adonisrc.ts` as class references — not composable transforms. `defineCommercePlugin()` can see the accumulated config and make conditional decisions based on what other plugins have registered.

---

### NestJS

NestJS's `@Module()` decorator became dominant not because of TypeScript support but because it gives teams a canonical answer to "where does X go." Controllers → Providers → Modules → App eliminates architectural bikeshedding.

**What to steal:**
- Canonical vocabulary: `defineModule`, `definePlugin`, `createApp` should be the vocabulary. Teams need a canonical answer to "where does X go."
- The "teams need structure" insight: NestJS wins at scale because it makes architectural decisions for you. The framework should be opinionated.

**What to reject:**
- Decorator-based DI requires `experimentalDecorators: true` and `emitDecoratorMetadata: true`. The proposed `defineModule({ dependencies: ['pricing'] })` achieves the same structural clarity without this.
- Boilerplate mass: NestJS CRUD requires module file, service file, controller file, DTOs, `TypeOrmModule.forFeature([Entity])`. The current `createRepository(table, db)` + service class pattern produces the same result in two files. Do not recreate the boilerplate.
- HTTP coupling: NestJS bakes Express/Fastify into controllers. The current separation of domain services from HTTP routes is correct.

**What this codebase has that NestJS doesn't:**
- First-class Drizzle integration with type-safe schema composition across plugins. NestJS + TypeORM requires entity classes; Drizzle's table-as-schema approach is better.
- Agent-native MCP as a framework primitive. NestJS has no AI story.

---

### Blitz.js

Blitz's zero-API approach makes server functions callable from the client with no HTTP definition. It diverged from Next.js because tight coupling prevented runtime-agnosticism.

**What to steal:**
- `createLocalAPI()` is already the same idea as Blitz's zero-API RPC. Make it the default promoted path — `commerce.api.catalog.list()` in a Next.js server component is better DX than `fetch('/api/catalog')`. The local API is the right answer; emphasize it.
- Full-stack batteries: auth, migrations, deployment, code scaffolding. The CLI package exists but scaffolding is underdeveloped.

**What to reject:**
- Tight runtime coupling. The current codebase's separation of `createCommerce()` (framework-agnostic) from `createServer()` (HTTP layer) is the correct answer. Do not merge them.

---

### The Synthesis

| Concern | Take From | Rationale |
|---------|-----------|-----------|
| Provider lifecycle / DI | AdonisJS | Auto-sequenced module instantiation beats manual ordering |
| Canonical vocabulary | NestJS | Teams need "where does X go" answered definitively |
| Local-first API | Blitz.js | Server component era makes HTTP optional |
| Plugin model | PayloadCMS | Config-transform is more composable than class registration |
| Schema composition | Current codebase | Drizzle plugin schemas are novel and correct |
| Hook ordering | Current codebase | Three-tier is better than registration-order |
| Agent-native tools | Current codebase | Unprecedented in the ecosystem; keep |

The resulting framework is:
- **AdonisJS-level batteries**: first-party adapters for Postgres, S3, Stripe, Resend, Meilisearch
- **NestJS-level vocabulary**: canonical `defineModule`, `definePlugin`, `createApp`
- **Blitz-level DX**: local API as default, HTTP as opt-in
- **PayloadCMS-level extensibility**: plugins are config transforms
- **None of their coupling**: no decorators, no string containers, no framework-specific client code, no Node.js assumptions

---

## 11. Migration Plan

### Phase 0 — Boundary Discovery (2 days, no code changes)

Write a dependency graph of every file in `packages/core/src`. Map which files import from `modules/` (domain) vs. which are purely `kernel/` (framework). Produces: a spreadsheet confirming or refuting the boundary analysis in §8.

**Output:** Confirmed extraction map.

---

### Phase 1 — Extract Framework Primitives (3 days, non-breaking)

Create `packages/framework` as a new workspace package (`@unifiedcommerce/framework` for now — rename later if publishing externally). Do not publish separately yet.

Move these files wholesale:

```
kernel/hooks/           → framework/src/hooks/
kernel/result.ts        → framework/src/result.ts
kernel/errors.ts        → framework/src/errors.ts       (rename Commerce* → App*)
kernel/database/adapter.ts → framework/src/database/
kernel/database/tx-context.ts → framework/src/database/
kernel/jobs/adapter.ts  → framework/src/jobs/adapter.ts
kernel/jobs/types.ts    → framework/src/jobs/types.ts
kernel/compensation/    → framework/src/compensation/
kernel/state-machine/machine.ts → framework/src/state-machine/
kernel/factory/         → framework/src/factory/
kernel/query/           → framework/src/query/
kernel/service-timing.ts → framework/src/service-timing.ts
kernel/local-api.ts     → framework/src/local-api.ts
auth/permissions.ts     → framework/src/auth/permissions.ts
auth/access.ts          → framework/src/auth/access.ts
utils/pagination.ts     → framework/src/utils/pagination.ts
runtime/logger.ts       → framework/src/logger.ts
runtime/shutdown.ts     → framework/src/shutdown.ts
test-utils/             → framework/src/testing/
```

`@unifiedcommerce/core` re-exports these from `@unifiedcommerce/framework`. **No breaking changes.**

**Verify:** All 247 tests pass. No public API changes.

---

### Phase 2 — Fix `HookHandler = never[]` (1 week, breaking for internal)

Before anything else external. This is the debt that cannot survive publication.

Define `CommerceHookMap` in `packages/core/src/kernel/hooks/map.ts` — a type mapping every hook key to its typed handler signature. Make `HookRegistry` generic over this map internally.

Start with the most-used hooks (orders, catalog, checkout) and expand. Accept that 40 hooks won't all be typed on day one — use `HookMap & Record<string, { before?: unknown; after?: unknown }>` as the escape hatch for hooks not yet typed.

**Verify:** All `as BeforeHook<X>` and `as AfterHook<Y>` casts at call sites are replaced by inferred types. The registry no longer exports `HookHandler = never[]` as a public type.

---

### Phase 3 — Fix `serviceContainer as Record<string, unknown>` (1 week, breaking for core)

Introduce `ServiceRegistry` as the actual type for the services bag (it already exists in `kernel/service-registry.ts` but isn't used by service constructors).

Change each service's `deps.services: Record<string, unknown>` to `deps.services: ServiceRegistry`. `ServiceRegistry` has typed methods for the known inter-service calls and `Record<string, unknown>` as its index signature for plugin additions.

This replaces all 5+ inline `as { adjust(...): ... }` casts in orders service.

**Verify:** All inter-service calls are typed. `npm run typecheck` passes with no new suppressions.

---

### Phase 4 — Introduce Module System (2–3 weeks, breaking for `createKernel`)

The largest refactor. Rewrite `createKernel()` to use `defineModule()` for each of the 17 services.

1. Create `catalogModule`, `inventoryModule`, `ordersModule`, etc.
2. The kernel becomes a module container that resolves dependencies automatically.
3. `Kernel["services"]` becomes `ServiceMap<TModules>` — typed by the module definitions.

Do it module-by-module, starting with the modules with the fewest cross-service dependencies (`audit`, `webhooks`, `media`, `organization`). Verify tests after each. Move to inter-dependent modules (`pricing` → `catalog` → `cart` → `orders`) last.

**Breaking:** The `Kernel` type changes. Any consumer accessing `kernel.services.catalog` gets a type error until they update. This is acceptable — the type is more correct afterward.

**Verify:** 247 tests pass. Plugin tests pass. `createPluginTestApp()` works with the new module system.

---

### Phase 5 — Three Config Stages (2 days, minor breaking)

Introduce `UserConfig`, `ResolvedConfig`, `RuntimeConfig`. Remove `customSchemas` from the public `CommerceConfig` type (it moves to `ResolvedConfig` only). Remove the `@internal` comment because it's now actually internal.

**Breaking:** Any app that reads `config.customSchemas` directly gets a type error. In practice, no app should be doing this.

**Verify:** `defineConfig()` input type is narrower. Plugins still work via the resolved config internally.

---

### Phase 6 — Fix Critical Bugs (1 week, concurrent with above)

These can be fixed independently of the framework extraction:

- **TD-009**: URL alias re-dispatch double-middleware — inject `type` into Hono context directly, remove `app.fetch()` re-dispatch.
- **TD-011**: Order number concurrent-safety — replace with PostgreSQL sequence.
- **TD-010**: `DrizzleJobsAdapter` `DEFAULT_ORG_ID` fallback — require explicit `organizationId` in `EnqueueOptions`.
- **TD-007**: `_bootDefaultOrgId` module-level state — thread through `HookContext`.

---

### Phase 7 — Publish `@aeronyx/framework` (when a second application emerges)

Only when a second real application needs the framework primitives. Right now the only consumer is the commerce engine. **Don't publish for its own sake.** The internal structural clarity pays for itself immediately. External publication pays off only with external users.

**Minimum publishable package:** The output of Phase 1 (framework primitives extraction) — 30 source files, no commerce coupling, usable as a base for any TypeScript backend.

---

## 12. Hard Truths

### Is the codebase ready for extraction?

No, but it's closer than most. The coupling is real but localized. `kernel/` is 85% clean. `modules/` is nearly pure domain. The contamination is concentrated in three files: `runtime/kernel.ts`, `config/types.ts`, `kernel/service-registry.ts`. Fix those three files and the extraction is mostly renaming.

The specific blockers before any external publication:
1. `HookHandler = never[]` must die. A framework cannot ship a public extension API with this type.
2. The `serviceContainer as Record<string, unknown>` pattern must be resolved before the module system is published.
3. `getMCPActor()` hardcoded identity must become configurable before multi-tenant production use.

### The 3 Biggest Risks

**Risk 1: The framework never gets external users.** You spend 3 months on extraction and the only consumer is the commerce engine. The framework becomes a maintenance burden with no external validation. This is the most likely failure mode.

*Mitigation:* Phase 1 extraction (2–3 days) pays for itself via internal clarity alone. Only invest in external publication when a second application creates the forcing function.

**Risk 2: Generics complexity becomes unshippable.** A fully generic `App<TModules>` with typed inter-module dependencies and a typed hook registry is a hard TypeScript challenge. The `HookHandler = never[]` was a conscious tradeoff — the engineer who wrote it understood the alternative. Conditional inference across 40+ named hooks may produce a worse developer experience than the current casts.

*Mitigation:* Accept partial type safety. Make the generic hook registry opt-in. Start with string-typed hooks and add per-hook type safety incrementally.

**Risk 3: Drizzle version coupling becomes a dependency management nightmare.** Once framework, commerce engine, and plugins are separate packages, 14 plugins + 10 adapters + framework + commerce engine all have their own `drizzle-orm` peer dependency. A Drizzle minor release that changes `PgTable` signatures breaks everything simultaneously.

*Mitigation:* Keep the monorepo structure. The feedback note "always republish all packages at the same version" is the right policy — enforce it mechanically via Turbo or Changesets.

### Is this worth doing vs shipping commerce features?

This is the wrong frame. The extraction is worth doing if and only if a second application needs the framework primitives. The internal structural cleanup pays for itself immediately without publishing anything. The external publication only pays off with external users.

The exception: if the goal is developer ecosystem and community growth, framework extraction is a marketing and community investment, not just engineering. NestJS succeeded because it gave TypeScript backend developers a canonical answer. If this framework can do that for the "TypeScript-first monolith with plugins and a local API" use case, the extraction has strategic value beyond the commerce engine alone.

### What would this offer that AdonisJS/NestJS don't already offer?

Two genuine gaps:

1. **Plugin-as-config-transform with Drizzle schema composition.** Neither AdonisJS nor NestJS lets a plugin contribute database tables, routes, hooks, and MCP tools in a single self-contained config object that composes deterministically. The `createPluginTestApp()` test utility is novel — a complete kernel with a PGlite database and all plugin tables migrated in a 5-line test setup.

2. **Local API with actor injection.** Neither framework has the `withActor()` / `withTransaction()` pattern for server-side scoped access without HTTP. This is the right answer for the Next.js App Router / TanStack Start era where most "API calls" should be server function calls.

These two things combined are a genuine gap in the TypeScript backend ecosystem.

---

## 13. Recommendation

**Do it. Do it surgically. Do it in this order.**

The thesis is correct: the foundation is good enough to be a framework. The qualification is that it's good enough to be an *internal* framework right now. It becomes a publishable framework when three specific debts are paid.

**Right now (this week):**

1. Create `packages/framework` as a workspace package. Move the 30 framework-primitive files listed in Phase 1. `@unifiedcommerce/core` re-exports them. Total cost: 2–3 days. Zero risk. Immediate payoff: the boundary becomes code, not a concept.

2. Fix `HookHandler = never[]`. This is not cosmetic — it is the most visible technical embarrassment in the codebase and the first thing any external developer will encounter. The fix is bounded to `registry.ts` and the hook map type definition. Budget: 2 hours.

3. Fix the order number concurrent-safety bug (PostgreSQL sequence). This is a data integrity issue in production, not a framework concern. Fix it now.

**Next quarter:**

4. Fix `serviceContainer as Record<string, unknown>` — introduce the `ServiceRegistry` type properly (Phase 3).

5. Introduce the module system (Phase 4) — the most important architectural improvement. This enables the framework to be truly generic and eliminates the 200-line manual wiring in `createKernel()`.

**Only when a second application emerges:**

6. Publish `@aeronyx/framework` externally. Not before. The internal structure is the asset. The publication is a distribution decision.

**The architectural north star:**

`unified-commerce-engine` should be an application built on `@aeronyx/framework`, not a framework with commerce code mixed into it. The five founding beliefs (config-is-code, one extension primitive, adapter-as-seam, serverless-as-constraint, agents-as-co-equal-consumers) transcend commerce. They are a framework philosophy. Extract them. Let the commerce engine demonstrate them.

The codebase is already 70% a framework. The remaining 30% is not spread evenly — it is three files. Fix those files, and the framework is ready.

---

*Research conducted May 2026. Sources: codebase at `unified-commerce-engine` main branch, VISION.md, VISION-AGENTIC.md, RFC-002 through RFC-041, packages/core/src (all files), packages/plugins/* (selective), packages/adapters/* (selective).*
