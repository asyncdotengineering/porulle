# RFC-004: PayloadCMS Learnings -- What @unifiedcommerce/core Should Adopt

**Status:** Draft
**Author:** Derived from deep source reading of `about-payloadcms/payload/` (commit tree as of March 2026)
**Relates to:** RFC-001 (Engine Design), RFC-003 (Core Hardening from Medusa)

---

## Overview

This document records what was learned from reading the PayloadCMS v3 source code
in depth -- the core `packages/payload/src/` directory, the `plugin-ecommerce`
package, database adapter interfaces, hooks execution pipeline, jobs system,
access control, and versioning. The goal is to identify patterns that
@unifiedcommerce/core should adopt, adapt, or surpass to achieve its stated ethos:
Developer Experience Above All, Serverless-First, Zero Vendor Lock-In,
Composition Over Configuration, One Extension Primitive.

PayloadCMS was a direct inspiration for this engine. Reading its production-grade
implementation reveals both the choices that should be borrowed verbatim and the
places where we should deliberately do better.

---

## What Was Read

The following files were read in full:

- `packages/payload/src/collections/config/types.ts` -- all collection hook types
- `packages/payload/src/collections/operations/create.ts` -- full lifecycle of a create operation
- `packages/payload/src/fields/config/types.ts` -- field-level hook types
- `packages/payload/src/fields/hooks/beforeChange/promise.ts` -- field hook execution
- `packages/payload/src/config/types.ts` -- root config shape including `Plugin` type
- `packages/payload/src/database/types.ts` -- `BaseDatabaseAdapter` interface
- `packages/payload/src/auth/executeAccess.ts` -- access control execution
- `packages/payload/src/utilities/initTransaction.ts` -- transaction lifecycle
- `packages/payload/src/queues/config/types/taskTypes.ts` -- typed task definitions
- `packages/payload/src/queues/config/types/workflowTypes.ts` -- workflow and concurrency types
- `packages/payload/src/queues/operations/runJobs/index.ts` -- job runner
- `packages/payload/src/queues/operations/runJobs/runJob/getRunTaskFunction.ts` -- task execution with restore logic
- `packages/payload/src/queues/localAPI.ts` -- `payload.jobs.queue()` local API
- `packages/plugin-ecommerce/src/index.ts` -- ecommerce plugin entry point
- `packages/plugin-ecommerce/src/types/index.ts` -- all plugin types including `PaymentAdapter`, `AccessConfig`, `CollectionOverride`, `CartItemMatcher`
- `packages/plugin-ecommerce/src/utilities/accessComposition.ts` -- `accessOR`, `accessAND`, `conditional`
- `packages/plugin-ecommerce/src/endpoints/confirmOrder.ts` -- payment confirmation flow
- `packages/plugin-ecommerce/src/payments/adapters/stripe/index.ts` -- Stripe adapter shape
- `packages/plugin-ecommerce/src/collections/carts/operations/addItem.ts` -- isolated cart operation
- `packages/payload/src/versions/types.ts` -- versioning and draft configuration

---

## Part 1 -- The Plugin Pattern

### 1.1 Observation

PayloadCMS defines a plugin with a single type:

```typescript
export type Plugin = (config: Config) => Config | Promise<Config>
```

A plugin is a function that receives the whole application config and returns a
modified config. Nothing more. No manifest class, no capability registry, no
registration step. You call the plugin with your options and it hands back a
function that transforms config.

The ecommerce plugin looks like this at the call site:

```typescript
// payload.config.ts
export default buildConfig({
  plugins: [
    ecommercePlugin({
      customers: { slug: 'users' },
      products: { variants: true },
      payments: {
        paymentMethods: [stripeAdapter({ secretKey: '...', publishableKey: '...' })],
      },
    }),
  ],
})
```

Internally, `ecommercePlugin` returns `(incomingConfig) => Config`. That function
receives the config object, pushes new collections into `config.collections`,
pushes new endpoints into `config.endpoints`, merges translations, and returns
the config. There is no registry, no late injection, no DI container resolving
plugins at boot. The config transformation is done once, at startup.

### 1.2 What @unifiedcommerce/core Has

`defineCommercePlugin` returns a `CommercePluginManifest` object containing
`schema`, `repositories`, `hooks`, `routes`, `mcpTools`, `capabilities`.
The kernel collects all manifests and wires them together at boot.

This approach works but it is more complex than necessary. The plugin author
must think about what a "manifest" contains. The hook system, the route system,
and the capabilities system are all separate concepts with different wiring paths.

### 1.3 What to Adopt: Config Transformation Semantics

The plugin signature should become:

```typescript
export type CommercePugin = (config: CommerceConfig) => CommerceConfig | Promise<CommerceConfig>
```

`defineCommercePlugin` stays as a developer-friendly wrapper, but internally it
wraps the manifest fields into a config transform. This makes plugin composition
trivially readable and composable.

The manifest model can remain as the internal implementation detail that the
helper wraps -- but developers who know what they are doing can also just write a
config transform directly without `defineCommercePlugin`.

Pseudo-code:

```
function defineCommercePlugin(manifest):
  return function(config):
    if manifest.schema:
      config.drizzleSchemas.push(manifest.schema)
    if manifest.routes:
      config.routes.push(...manifest.routes)
    if manifest.hooks:
      for each operation, hook in manifest.hooks:
        config.hooks[operation].push(hook)
    if manifest.mcpTools:
      config.mcp.tools.push(...manifest.mcpTools)
    return config
```

Blueprint:

```typescript
// packages/core/src/kernel/plugin/types.ts

export type CommercePlugin = (
  config: CommerceConfig,
) => CommerceConfig | Promise<CommerceConfig>

// defineCommercePlugin remains the ergonomic helper.
// Its return type changes from CommercePluginManifest to CommercePlugin.
export function defineCommercePlugin<...>(manifest: CommercePluginManifest<...>): CommercePlugin {
  return async (config: CommerceConfig): Promise<CommerceConfig> => {
    if (manifest.schema) {
      config.database.schemas = [...(config.database.schemas ?? []), manifest.schema]
    }
    if (manifest.routes) {
      config.routes = [...(config.routes ?? []), ...manifest.routes(config)]
    }
    for (const [operation, hooks] of Object.entries(manifest.hooks ?? {})) {
      const op = operation as HookOperation
      config.hooks[op] = [...(config.hooks[op] ?? []), ...(hooks as any)]
    }
    if (manifest.mcpTools) {
      config.mcp.tools = [...(config.mcp.tools ?? []), ...manifest.mcpTools]
    }
    return config
  }
}
```

The `defineConfig` function applies plugins before freezing the config:

```typescript
export async function defineConfig(input: CommerceConfigInput): Promise<CommerceConfig> {
  let config = applyDefaults(input)
  for (const plugin of config.plugins ?? []) {
    config = await plugin(config)
  }
  return Object.freeze(config)
}
```

This is a material simplification that any developer can reason about immediately.

---

## Part 2 -- The Collection Override Pattern

### 2.1 Observation

In the PayloadCMS ecommerce plugin, every collection that the plugin creates can
be overridden by the developer:

```typescript
products: {
  productsCollectionOverride: ({ defaultCollection }) => ({
    ...defaultCollection,
    fields: [
      ...defaultCollection.fields,
      { name: 'supplierCode', type: 'text', label: 'Supplier Code' },
    ],
    hooks: {
      ...defaultCollection.hooks,
      afterChange: [...(defaultCollection.hooks?.afterChange ?? []), myCustomHook],
    },
  }),
},
```

The type is:

```typescript
export type CollectionOverride = (args: {
  defaultCollection: CollectionConfig
}) => CollectionConfig | Promise<CollectionConfig>
```

You receive the default, you spread it, you augment it. You are not fighting the
defaults; you are building on top of them.

### 2.2 What @unifiedcommerce/core Has

Each module defines its Drizzle schema in a `schema.ts` file, e.g.,
`packages/core/src/modules/catalog/schema.ts`. The schema is a set of Drizzle
table definitions. If a developer wants to add a column to the products table
they currently have no path to do so without forking the module.

### 2.3 What to Adopt: Schema Extension Pattern

Every core module that defines a table should accept additional column
definitions from the developer. The approach should follow the same
"give me the default, I augment" pattern.

For Drizzle, columns are defined as part of the table definition using
`pgTable(name, columns)`. The challenge is that Drizzle table definitions
are not trivially extensible post-creation. The solution is to accept an
`extraColumns` factory at the module level:

Pseudo-code:

```
function createCatalogModule(options):
  baseColumns = {
    id: uuid().primaryKey(),
    name: text().notNull(),
    slug: text().notNull().unique(),
    ...
  }
  extraColumns = options.extraColumns ? options.extraColumns(baseColumns) : {}
  products = pgTable('products', { ...baseColumns, ...extraColumns })
  return {
    schema: { products, ... },
    repository: createRepository(products, db),
  }
```

Blueprint:

```typescript
// packages/core/src/modules/catalog/index.ts

export type CatalogModuleOptions = {
  extraColumns?: (
    baseColumns: typeof baseCatalogColumns,
  ) => Record<string, PgColumnBuilderBase>
  hooks?: {
    afterProductCreate?: AfterHook<{ product: Product }>[]
    afterProductUpdate?: AfterHook<{ product: Product }>[]
  }
}

export function createCatalogModule(options?: CatalogModuleOptions): CatalogModule {
  const extraColumns = options?.extraColumns?.(baseCatalogColumns) ?? {}

  const products = pgTable('products', {
    ...baseCatalogColumns,
    ...extraColumns,
  })

  return {
    schema: { products },
    repository: createRepository(products),
    hooks: options?.hooks,
  }
}
```

And in the engine config:

```typescript
// commerce.config.ts
export default defineConfig({
  modules: {
    catalog: createCatalogModule({
      extraColumns: (base) => ({
        supplierCode: text('supplier_code'),
        gtin: text('gtin').unique(),
      }),
    }),
  },
})
```

This satisfies the "Developer Experience Above All" and "Composition Over
Configuration" ethos principles. The developer does not add columns via
migration files or config toggles; they compose with the defaults.

---

## Part 3 -- Access Composition

### 3.1 Observation

PayloadCMS's ecommerce plugin ships three pure utility functions:

```typescript
// accessOR: returns true if ANY checker returns true
// returns combined Where queries if any checkers return a Where filter
export const accessOR = (...accessFunctions: Access[]): Access

// accessAND: returns false if ANY checker returns false
// returns combined Where queries with AND logic
export const accessAND = (...accessFunctions: Access[]): Access

// conditional: applies accessFunction only when condition is true
export const conditional = (
  condition: boolean | ((args: any) => boolean),
  accessFunction: Access,
  fallback: Access = () => false,
): Access
```

The `AccessResult` type is `boolean | Where`. When a function returns a `Where`
object, it is treated as a query constraint -- the operation proceeds but results
are filtered to only rows matching that constraint. This is extremely powerful:
you can write a single access function that returns `true` for admins, a Where
filter for customers (show only their own records), and `false` for guests.

Composition then looks like:

```typescript
access: {
  read: accessOR(
    isAdmin,
    isDocumentOwner,
    conditional(product.isPublished, publicAccess),
  ),
  create: accessAND(isAuthenticated, hasCompletedOnboarding),
}
```

This reads as natural English. There is no bespoke access DSL, no middleware
chains, no permission flags. Just composable functions with well-defined semantics.

### 3.2 What @unifiedcommerce/core Has

`packages/core/src/auth/permissions.ts` exists. The permission model is based on
actor type and role checks. The system currently does not have composable access
functions or Where-query-based access filtering.

### 3.3 What to Adopt: Composable Access Functions with Query Constraints

Define an `AccessResult` type that mirrors PayloadCMS:

```typescript
export type AccessResult = boolean | WhereClause
```

Where `WhereClause` is a structured query constraint that can be applied to any
`findMany` call. Then ship `accessOR`, `accessAND`, and `conditional` as
utilities.

Pseudo-code:

```
type AccessFn = (ctx: AccessContext) => AccessResult | Promise<AccessResult>

function accessOR(fns):
  return async (ctx):
    queries = []
    for each fn in fns:
      result = await fn(ctx)
      if result === true: return true
      if result is object (Where): queries.push(result)
    if queries.length > 0: return combineWithOR(queries)
    return false

function accessAND(fns):
  return async (ctx):
    queries = []
    for each fn in fns:
      result = await fn(ctx)
      if result === false: return false
      if result is object (Where): queries.push(result)
    if queries.length > 0: return combineWithAND(queries)
    return true
```

Blueprint:

```typescript
// packages/core/src/auth/access.ts

export type WhereClause = Record<string, unknown>

export type AccessResult = WhereClause | boolean

export type AccessFn<TData = unknown> = (
  ctx: AccessContext<TData>,
) => AccessResult | Promise<AccessResult>

export type AccessContext<TData = unknown> = {
  actor: Actor | null
  data?: TData
  id?: string
  req: CommerceRequest
}

function combineWhere(queries: WhereClause[], operator: 'and' | 'or'): WhereClause {
  if (queries.length === 1) return queries[0]!
  return { [operator]: queries }
}

export const accessOR = <TData = unknown>(
  ...fns: Array<AccessFn<TData>>
): AccessFn<TData> => {
  return async (ctx) => {
    const queries: WhereClause[] = []
    for (const fn of fns) {
      const result = await fn(ctx)
      if (result === true) return true
      if (result && typeof result === 'object') queries.push(result)
    }
    if (queries.length > 0) return combineWhere(queries, 'or')
    return false
  }
}

export const accessAND = <TData = unknown>(
  ...fns: Array<AccessFn<TData>>
): AccessFn<TData> => {
  return async (ctx) => {
    const queries: WhereClause[] = []
    for (const fn of fns) {
      const result = await fn(ctx)
      if (result === false) return false
      if (result !== true && result && typeof result === 'object') queries.push(result)
    }
    if (queries.length > 0) return combineWhere(queries, 'and')
    return true
  }
}

export const conditional = <TData = unknown>(
  condition: ((ctx: AccessContext<TData>) => boolean) | boolean,
  accessFn: AccessFn<TData>,
  fallback: AccessFn<TData> = () => false,
): AccessFn<TData> => {
  return async (ctx) => {
    const applies = typeof condition === 'function' ? condition(ctx) : condition
    return applies ? accessFn(ctx) : fallback(ctx)
  }
}
```

The key addition over current permissions: the `WhereClause` return value.
Route handlers and service `findMany` calls must accept and apply `WhereClause`
constraints from access functions, so filtered access automatically narrows
results without additional code in the handler.

---

## Part 4 -- Request Context Propagation

### 4.1 Observation

PayloadCMS has a `RequestContext` type that is a free-form `Record<string, unknown>`:

```typescript
export type RequestContext = Record<string, unknown>
```

This context object is threaded through every operation, every hook call, and
every field hook. It is separate from `req`. The purpose: pass arbitrary data
between layers of a hook pipeline without global state or prop drilling through
the service layer.

A common use case in the Payload source:

```typescript
// In your hook
if (context.skipInventoryCheck) return  // bail early based on caller intent

// In your endpoint
await payload.create({
  collection: 'orders',
  data,
  context: { skipInventoryCheck: true },
})
```

This is essentially a per-request scratchpad. Hooks can write to it, hooks can
read from it. Because it travels with every call within a single request, you get
coordination without coupling.

### 4.2 What @unifiedcommerce/core Has

`HookContext` is the context object that hooks receive. It carries `actor`, `tx`,
`logger`, `services`, and `metadata`. The `metadata` field is
`Record<string, unknown>`, which serves the same purpose as Payload's
`RequestContext`.

The current implementation is correct. The naming difference (`metadata` vs
`context`) is minor. What is missing: hooks do not receive the full incoming
request object, so they cannot inspect headers, query params, or request-level
data that might drive conditional behavior.

### 4.3 What to Adopt: Richer Hook Context

Extend `HookContext` to include:

1. A `context` field (rename `metadata` to `context` to align with the broader
   ecosystem convention)
2. A `requestId` field for tracing
3. An `origin` field to distinguish REST vs Local API vs MCP calls

Pseudo-code:

```
type HookContext = {
  actor: Actor | null
  tx: Transaction | null
  logger: Logger
  services: ServiceMap
  context: Record<string, unknown>   // formerly metadata
  requestId: string
  origin: 'rest' | 'local' | 'mcp'
  jobs: JobsAdapter
}
```

The `origin` field deserves explanation. When a hook is triggered from the REST
API, the actor is set from the JWT. When triggered from the Local API (a plugin
calling `kernel.catalog.list()` directly), the actor may be a system actor. When
triggered from an MCP tool, the actor has been resolved from the MCP session.
Hooks that behave differently based on call origin benefit from this field.

---

## Part 5 -- Database-Backed Job Queue

### 5.1 Observation

PayloadCMS ships a fully featured job queue that uses the application's own
database as the backing store. There is no Redis, no external queue service, no
vendor to lock into. Jobs are stored as rows in a `payload-jobs` collection
(table). The runner is a function that:

1. Queries for pending jobs (WHERE processing = false AND waitUntil <= now)
2. Marks them as processing
3. Executes the workflow or task handler
4. Updates job status on success or failure

The key design decisions in Payload's job system:

**Jobs are database rows.** This means they survive server restarts. You can
query them with the standard Payload local API. You can build an admin UI on top
of them. You can write WHERE clauses to inspect job state.

**Tasks compose into workflows.** A `TaskConfig` defines one unit of work with
typed input and output. A `WorkflowConfig` composes multiple tasks. The workflow
handler receives `tasks` (a map of task runner functions) and calls them
sequentially or in parallel.

**Workflows are resumable.** If a workflow fails at task 3 of 5, and is retried,
tasks 1 and 2 are restored from their saved output. Only task 3 re-runs. This
is controlled by `shouldRestore` on `RetryConfig`.

**Concurrency control is built in.** `concurrencyKey` + `exclusive` prevents two
jobs with the same key from running simultaneously. `supersedes` cancels pending
jobs with the same key when a newer one arrives. This is essential for avoiding
double-processing in checkout flows.

**Delayed and scheduled execution.** `waitUntil: Date` defers a job. `schedule`
config on a task or workflow enables recurring jobs (like cron). `autorun` config
on the jobs system enables a self-managed cron loop within the app.

**Serverless compatible.** Running jobs is triggered by calling
`payload.jobs.run()`. In a serverless environment this is exposed as an HTTP
endpoint that a Vercel cron or AWS EventBridge can hit. In a long-running
environment you configure `autorun` to poll on a cron schedule.

The task definition:

```typescript
const sendOrderConfirmationTask: TaskConfig = {
  slug: 'send-order-confirmation',
  inputSchema: [
    { name: 'orderId', type: 'text', required: true },
    { name: 'email', type: 'email', required: true },
  ],
  outputSchema: [
    { name: 'sent', type: 'checkbox' },
  ],
  retries: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
  },
  handler: async ({ input, req }) => {
    await sendEmail({ to: input.email, template: 'order-confirmation', orderId: input.orderId })
    return { output: { sent: true } }
  },
}
```

Enqueueing from a hook:

```typescript
// In an AfterHook
await context.jobs.enqueue('send-order-confirmation', {
  orderId: order.id,
  email: order.customerEmail,
})
```

### 5.2 What @unifiedcommerce/core Has

RFC-003 proposed a `JobsAdapter` interface with a `NullJobsAdapter` as default:

```typescript
export interface JobsAdapter {
  enqueue(name: string, payload: Record<string, unknown>, options?: JobEnqueueOptions): Promise<void>
}
```

This interface is correct but intentionally thin. The `NullJobsAdapter` makes the
system work without any queue infrastructure. But there is currently no built-in
job queue implementation. Developers who want durable background jobs must bring
their own adapter (e.g., wrap BullMQ, or call a Trigger.dev API).

### 5.3 What to Adopt: Built-In Database-Backed Queue

Build a `DrizzleJobsAdapter` that stores jobs in the application database. This
eliminates the need for an external queue for the majority of use cases and keeps
the system serverless-compatible.

The implementation has five pieces:

**5.3.1 Jobs Table Schema**

```typescript
// packages/core/src/kernel/jobs/schema.ts

export const jobs = pgTable('commerce_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  queue: text('queue').notNull().default('default'),
  taskSlug: text('task_slug').notNull(),
  input: jsonb('input').notNull().default('{}'),
  output: jsonb('output'),
  status: text('status', { enum: ['pending', 'processing', 'succeeded', 'failed'] })
    .notNull()
    .default('pending'),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(1),
  error: text('error'),
  waitUntil: timestamp('wait_until', { withTimezone: true }),
  concurrencyKey: text('concurrency_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  processingStartedAt: timestamp('processing_started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
})
```

**5.3.2 Task Registration**

```typescript
// packages/core/src/kernel/jobs/types.ts

export type TaskDefinition<TInput extends object, TOutput extends object> = {
  slug: string
  handler: (args: {
    input: TInput
    ctx: TaskContext
  }) => Promise<{ output: TOutput }>
  retries?: {
    attempts: number
    backoff?: { type: 'fixed' | 'exponential'; delay: number }
  }
  concurrency?: {
    key: (input: TInput) => string
    exclusive?: boolean
    supersedes?: boolean
  }
}
```

**5.3.3 Queue and Runner**

```typescript
// packages/core/src/kernel/jobs/runner.ts

export async function runPendingJobs(args: {
  db: DrizzleDatabase
  tasks: Map<string, TaskDefinition<any, any>>
  queue?: string
  limit?: number
}): Promise<{ processed: number; failed: number }>
```

The runner queries up to `limit` pending jobs from `queue`, processes them, and
updates their status. This function can be:

- Called via a registered route: `GET /api/jobs/run` (expose in production,
  protect with a secret header)
- Called from a Node.js cron in a long-running process
- Called from a Vercel Cron Job or AWS EventBridge Lambda

**5.3.4 DrizzleJobsAdapter**

```typescript
// packages/core/src/kernel/jobs/drizzle-adapter.ts

export class DrizzleJobsAdapter implements JobsAdapter {
  constructor(
    private db: DrizzleDatabase,
    private tasks: Map<string, TaskDefinition<any, any>>,
  ) {}

  async enqueue(
    slug: string,
    input: Record<string, unknown>,
    options?: JobEnqueueOptions,
  ): Promise<void> {
    // Handle concurrency.supersedes: delete pending jobs with same key
    if (options?.concurrencyKey) {
      await this.db
        .delete(jobs)
        .where(
          and(
            eq(jobs.concurrencyKey, options.concurrencyKey),
            eq(jobs.status, 'pending'),
            options?.supersedes ? sql`true` : sql`false`,
          ),
        )
    }

    await this.db.insert(jobs).values({
      taskSlug: slug,
      input,
      queue: options?.queue ?? 'default',
      maxAttempts: options?.maxAttempts ?? 1,
      waitUntil: options?.waitUntil ?? null,
      concurrencyKey: options?.concurrencyKey ?? null,
    })
  }
}
```

**5.3.5 Config Integration**

```typescript
// commerce.config.ts
export default defineConfig({
  jobs: {
    tasks: [sendOrderConfirmationTask, generateInvoiceTask, syncInventoryTask],
    autorun: {
      enabled: process.env.NODE_ENV !== 'production', // only in dev; use cron in production
      intervalMs: 5000,
    },
  },
})
```

This delivers the same developer experience as Payload's job system with zero
external dependencies. Jobs are queryable, inspectable, and debuggable through
the same database tooling the developer already uses.

---

## Part 6 -- Local API

### 6.1 Observation

PayloadCMS distinguishes between the REST API and the Local API. The REST API is
HTTP-based: a request comes in through an Express route, is parsed, goes through
access control, runs hooks, writes to the database, and returns a JSON response.

The Local API is a JavaScript-level API that calls the exact same operations
without HTTP:

```typescript
// From a hook, task handler, or server-side code:
const order = await payload.create({
  collection: 'orders',
  data: { items: [...], customer: userId },
  overrideAccess: true,  // skip access control when calling internally
})
```

This is not a thin wrapper over fetch. It calls `createOperation()` directly,
which runs the full hook pipeline, writes to the database, handles versioning,
and returns the typed result. The difference: no network roundtrip, no JSON
serialization, no HTTP parsing overhead.

For a serverless ecommerce engine this matters deeply. A checkout flow might
need to:
1. Read the cart
2. Validate inventory
3. Apply promotions
4. Capture payment
5. Create the order
6. Reserve inventory
7. Enqueue fulfillment job

Doing all of this as internal function calls -- not HTTP requests -- is an order
of magnitude faster and eliminates partial-failure scenarios caused by network
errors between internal services.

### 6.2 What @unifiedcommerce/core Has

Services are called directly in hooks: `context.services.orders.create(...)`. The
hook system receives a `services` map. So the engine does have a form of local
API -- you call services directly. But there are two gaps:

1. Services do not run hooks on themselves. When you call
   `context.services.orders.create()` from inside a checkout hook, the
   `checkout.afterOrderCreate` hooks defined by plugins do not fire. Each service
   call is a raw database operation.

2. There is no standardized interface for the local API that mirrors the REST API
   surface. Developers reaching for `context.services.orders` must know the
   internal service method signatures.

### 6.3 What to Adopt: Hook-Aware Local API

Build a `LocalAPI` class that wraps service calls with the full hook pipeline.
When code inside a hook calls `localApi.orders.create(data)`, it fires
`beforeOrderCreate` hooks (with the original `HookContext` passed through), then
calls the service, then fires `afterOrderCreate` hooks.

Pseudo-code:

```
class LocalAPI:
  constructor(ctx: HookContext)

  orders:
    create(data):
      run beforeOrderCreate hooks with ctx
      result = ordersService.create(data, ctx.tx)
      run afterOrderCreate hooks with ctx and result
      return result

    findById(id):
      result = ordersService.findById(id, ctx.tx)
      run afterOrderRead hooks with ctx and result
      return result
```

Blueprint:

```typescript
// packages/core/src/kernel/local-api.ts

export class LocalAPI {
  constructor(
    private ctx: HookContext,
    private kernel: CommerceKernel,
  ) {}

  readonly orders = {
    create: async (
      data: CreateOrderInput,
    ): Promise<Result<Order, CommerceError>> => {
      const beforeResult = await this.kernel.hooks.runBefore('orderCreate', data, this.ctx)
      if (!beforeResult.ok) return beforeResult

      const created = await this.kernel.services.orders.create(
        beforeResult.value,
        this.ctx.tx,
      )
      if (!created.ok) return created

      await this.kernel.hooks.runAfter('orderCreate', created.value, this.ctx)
      return created
    },
  }

  readonly catalog = {
    findById: async (id: string): Promise<Result<Product, CommerceError>> => {
      const result = await this.kernel.services.catalog.findById(id, this.ctx.tx)
      if (!result.ok) return result

      await this.kernel.hooks.runAfter('productRead', result.value, this.ctx)
      return result
    },
  }
}
```

The `HookContext` object that already exists is passed into every Local API call.
This means transaction context, actor, logger, and jobs are all automatically
threaded through. Hooks called by the Local API run inside the same transaction
as the calling code, which is exactly what you want for checkout atomicity.

---

## Part 7 -- Versioning and Audit Trail

### 7.1 Observation

PayloadCMS versions every document when `versions: true` is enabled on a
collection. What this means in practice:

- Every `create` and `update` writes a snapshot of the document to a
  `{collection}_versions` table (separate from the live collection table).
- The version record stores the full document data at that point in time.
- Up to `maxPerDoc` versions are kept. Older ones are pruned automatically.
- Drafts are implemented on top of versions: the live table stores the published
  version, the versions table stores unpublished drafts with `_status: 'draft'`.
- `restoreVersion` replaces the live document with a historical version.

For ecommerce specifically, the orders collection uses versions not for drafts
but for audit: every status transition, every edit, every cancellation is
preserved as an immutable history. This is table stakes for financial records.

### 7.2 What @unifiedcommerce/core Has

The `orders` table has a `status` field managed by a state machine. There is
no version history. If an order moves from `pending` to `confirmed` to
`cancelled`, there is no record of when those transitions happened and what the
order data looked like at each point.

### 7.3 What to Adopt: Lightweight Audit Log

A full document versioning system is complex. What is immediately useful and
implementable is an audit log table that records state transitions and who
triggered them.

This is a simpler proposition than full versioning: capture events, not snapshots.

Pseudo-code:

```
table: commerce_audit_log
  id: uuid
  entity_type: text  ('order', 'product', etc.)
  entity_id: uuid
  event: text  ('status_changed', 'item_added', 'cancelled')
  payload: jsonb  (the data that changed)
  actor_id: text
  actor_type: text
  created_at: timestamp
```

Every state machine transition writes an entry. Every significant mutation in a
beforeChange or afterChange hook writes an entry via
`context.services.audit.record(...)`.

Blueprint:

```typescript
// packages/core/src/modules/audit/schema.ts

export const auditLog = pgTable('commerce_audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  event: text('event').notNull(),
  payload: jsonb('payload').notNull().default('{}'),
  actorId: text('actor_id'),
  actorType: text('actor_type'),
  requestId: text('request_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// Index for efficient lookup of an entity's history
// CREATE INDEX idx_audit_entity ON commerce_audit_log(entity_type, entity_id, created_at DESC)
```

```typescript
// packages/core/src/modules/audit/service.ts

export type AuditService = {
  record(args: {
    entityType: string
    entityId: string
    event: string
    payload?: Record<string, unknown>
    ctx: HookContext
  }): Promise<void>

  listForEntity(args: {
    entityType: string
    entityId: string
    limit?: number
    ctx?: TxContext
  }): Promise<AuditEntry[]>
}
```

Add `audit: AuditService` to `HookContext.services`. Every AfterHook that
records significant events calls `context.services.audit.record(...)`. The state
machine transitions call it automatically.

---

## Part 8 -- The CartItemMatcher Pattern

### 8.1 Observation

In the ecommerce plugin's cart operations, item deduplication is handled by an
injectable `cartItemMatcher` function:

```typescript
export type CartItemMatcher = (args: {
  existingItem: CartItem
  newItem: NewCartItem
}) => boolean
```

When adding an item to a cart, the operation scans existing items looking for a
match. If a match is found, quantities are combined. The default matcher checks
product ID and variant ID. But a developer can replace it:

```typescript
cartItemMatcher: ({ existingItem, newItem }) => {
  return (
    existingItem.product === newItem.product &&
    existingItem.variant === newItem.variant &&
    existingItem.giftNote === newItem.giftNote  // custom field from schema extension
  )
}
```

This is a masterclass in minimal extension points. Adding a custom field to a
cart item is meaningless unless the business logic also knows about it. The
`cartItemMatcher` is the exact extension point that connects a custom field to
custom behavior, with zero framework ceremony.

### 8.2 What @unifiedcommerce/core Has

The cart module's `addItem` service method currently determines uniqueness by
`productId` + `variantId`. This is hardcoded.

### 8.3 What to Adopt: Injectable Matcher Functions

The cart module should accept a `cartItemMatcher` option in its creation config:

```typescript
// packages/core/src/modules/cart/types.ts

export type CartItemMatcherArgs = {
  existingItem: CartLineItem
  newItem: {
    productId: string
    variantId: string | null
    [key: string]: unknown  // custom fields from schema extension
  }
}

export type CartItemMatcher = (args: CartItemMatcherArgs) => boolean

export const defaultCartItemMatcher: CartItemMatcher = ({ existingItem, newItem }) =>
  existingItem.productId === newItem.productId &&
  existingItem.variantId === newItem.variantId
```

```typescript
// commerce.config.ts
export default defineConfig({
  modules: {
    cart: createCartModule({
      cartItemMatcher: ({ existingItem, newItem }) =>
        existingItem.productId === newItem.productId &&
        existingItem.variantId === newItem.variantId &&
        existingItem.customizationKey === newItem.customizationKey,
    }),
  },
})
```

This pattern generalizes. Other places where business logic matching is
configurable: order line item deduplication, promotion applicability checks,
fulfillment grouping logic. All of these can follow the same injectable function
pattern.

---

## Part 9 -- The PaymentAdapter Shape

### 9.1 Observation

The PayloadCMS ecommerce plugin's `PaymentAdapter` interface carries:

```typescript
export type PaymentAdapter = {
  name: string
  label?: string
  initiatePayment: InitiatePayment
  confirmOrder: ConfirmOrder
  endpoints?: Endpoint[]
  group: GroupField  // admin UI field group for this payment method
}
```

The `group` field is particularly interesting. It is a `GroupField` -- a
structured set of admin UI fields that the adapter contributes. For the Stripe
adapter this includes `stripeCustomerID` and `stripePaymentIntentID`. These
fields are merged into the transactions collection's schema, scoped under a
`stripe` group.

The `admin.condition` on the group field hides it unless `data.paymentMethod ===
'stripe'`. So a transaction record with a Stripe payment shows Stripe-specific
fields; one with a bank transfer shows bank-specific fields.

This design gives each payment adapter ownership over its own data schema
without requiring the core to know about adapter-specific fields. The adapter
is self-describing.

### 9.2 What @unifiedcommerce/core Has

`PaymentAdapter` in `packages/core/src/modules/payments/adapter.ts` defines
`initiate`, `capture`, `refund`, `cancel`. It does not have a mechanism for
adapters to contribute schema columns to the payments table.

### 9.3 What to Adopt: Self-Describing Adapter Columns

Add an optional `extraColumns` factory to `PaymentAdapter`. When the payments
module initializes, it calls `adapter.extraColumns?.()` for each configured
adapter and merges the resulting columns into the payments table under a namespace.

Pseudo-code:

```
type PaymentAdapter = {
  name: string
  initiate(args): Promise<InitiateResult>
  capture(args): Promise<CaptureResult>
  refund(args): Promise<RefundResult>
  cancel(args): Promise<CancelResult>
  extraColumns?(): Record<string, PgColumnBuilderBase>
}
```

Blueprint:

```typescript
// packages/core/src/modules/payments/adapter.ts

export type PaymentAdapter = {
  readonly name: string
  initiate(args: InitiateArgs): Promise<Result<InitiateResult, CommerceError>>
  capture(args: CaptureArgs): Promise<Result<CaptureResult, CommerceError>>
  refund(args: RefundArgs): Promise<Result<RefundResult, CommerceError>>
  cancel(args: CancelArgs): Promise<Result<CancelResult, CommerceError>>
  /**
   * Additional columns this adapter wants stored on the payments table.
   * Columns are namespaced to avoid conflicts: stripe_customer_id, stripe_payment_intent_id.
   */
  extraColumns?(): Record<string, PgColumnBuilderBase>
}
```

```typescript
// packages/core/src/modules/payments/schema.ts

export function buildPaymentsSchema(adapters: PaymentAdapter[]) {
  const adapterColumns: Record<string, PgColumnBuilderBase> = {}
  for (const adapter of adapters) {
    const extra = adapter.extraColumns?.() ?? {}
    for (const [key, col] of Object.entries(extra)) {
      adapterColumns[`${adapter.name}_${key}`] = col
    }
  }

  return pgTable('payments', {
    ...basePaymentColumns,
    ...adapterColumns,
  })
}
```

This keeps adapter-specific state in the same payments table, queryable by
standard SQL, with no loose JSON blobs. The engine stays adapter-agnostic, each
adapter owns its columns, and everything is typed.

---

## Part 10 -- Guest Cart and Session Portability

### 10.1 Observation

The ecommerce plugin's cart system supports anonymous (guest) carts via a
`secret` token:

```typescript
// POST /api/carts with allowGuestCarts: true
// Returns { id, secret }

// Subsequent access: include secret in request headers or body
// Access control: hasCartSecretAccess checks req.query.secret matches cart.secret
```

After the guest logs in, `mergeCart(targetCartId, guestCartId, guestSecret)` is
called to merge the guest cart into the user's authenticated cart. Item quantities
are summed, duplicates resolved by the `cartItemMatcher`.

The React-side `EcommerceContext` exposes `onLogin()` which handles the merge
automatically.

This is essential for any ecommerce store. A user browses and adds items as a
guest. They authenticate to checkout. Their cart must not disappear. This has to
be designed into the system, not bolted on.

### 10.2 What @unifiedcommerce/core Has

The cart schema has a `customerId` column. There is no `secret` column. There is
no guest cart concept. Anonymous cart creation is not directly supported; the
auth middleware likely rejects unauthenticated requests to cart endpoints.

### 10.3 What to Adopt: Guest Cart with Merge

Add a `secret` column to `cart_line_items` or the `carts` table. Make cart
access control check either the authenticated user ID or a valid secret.

Pseudo-code:

```
table: carts
  id: uuid
  customer_id: uuid (nullable, null = guest cart)
  secret: text (nullable, set for guest carts)
  ...

function canAccessCart(req, cart):
  if req.actor and req.actor.customerId === cart.customerId: return true
  if req.secret and req.secret === cart.secret: return true
  return false
```

Cart service's `addItem`, `removeItem`, `checkout` all call `canAccessCart`.

The `mergeCarts(targetId, sourceId, sourceSecret, ctx)` operation:
1. Verify source cart with secret
2. For each item in source cart, call `cartService.addItem(targetId, item, ctx)`
3. Delete source cart

This is not complex. It is mechanical. But it has to be designed in from the
start because it touches access control, the cart schema, the merge algorithm,
and the checkout pipeline.

---

## Part 11 -- Type Generation from Schema

### 11.1 Observation

PayloadCMS ships a `payload generate:types` CLI command. It reads the Payload
config (which contains all collection definitions including their fields and
types), and emits a `payload-types.ts` file. This file augments global types:

```typescript
// payload-types.ts (generated)
declare module 'payload' {
  export interface TypedCollection {
    products: Product
    orders: Order
    carts: Cart
    // ...every collection
  }

  export interface TypedJobs {
    tasks: {
      'send-order-confirmation': {
        input: { orderId: string; email: string }
        output: { sent: boolean }
      }
    }
  }
}
```

Once this file is generated, `TypedCollection['products']` is the exact shape
of a product document. Hook types, access function types, and local API return
types all use these generated types. TypeScript catches shape mismatches
throughout the codebase.

### 11.2 What @unifiedcommerce/core Has

Types are inferred from Drizzle schemas. `$inferSelect` and `$inferInsert` give
you the row types. These are used throughout the services and repositories. This
is good.

What is missing: there is no generated type file that augments global types.
Plugin authors who want to refer to `Order` or `Product` must import from the
specific schema module or use the inferred Drizzle types directly.

### 11.3 What to Adopt: Module Type Augmentation Pattern

Define an augmentable interface map that the engine and plugins can extend:

```typescript
// packages/core/src/types/commerce-types.ts

export interface CommerceModuleTypes {
  // Core types populated by Drizzle inference
  Product: typeof import('../modules/catalog/schema').products.$inferSelect
  Order: typeof import('../modules/orders/schema').orders.$inferSelect
  Cart: typeof import('../modules/cart/schema').carts.$inferSelect
  // ...
}
```

Plugins can augment these via TypeScript module augmentation:

```typescript
// my-plugin/src/types.ts
declare module '@unifiedcommerce/core' {
  interface CommerceModuleTypes {
    MyPluginEntity: {
      id: string
      pluginSpecificField: string
    }
  }
}
```

This is a modest improvement over the current state. The full Payload-style
code generation from schema definitions is a larger investment. The immediate
win is a centralized `CommerceModuleTypes` interface that the engine and all
plugins reference for type safety.

---

## Part 12 -- Summary of Adoption Priorities

The following table orders the above learnings by immediate impact versus
implementation complexity:

```
Priority | Item                              | Impact   | Effort
---------|-----------------------------------|----------|-------
1        | Access Composition Utilities      | High     | Low
         | (accessOR, accessAND, conditional)|          |
2        | CartItemMatcher                   | High     | Low
3        | Guest Cart + Merge                | High     | Medium
4        | Audit Log Table + Service         | High     | Medium
5        | Database-Backed Job Queue         | High     | Medium
6        | Local API (hook-aware)            | High     | Medium
7        | Plugin Config Transformation      | Medium   | Medium
8        | Collection Override (extraColumns)| Medium   | Medium
9        | PaymentAdapter extraColumns       | Medium   | Low
10       | Request Context (origin field)    | Low      | Low
11       | Type Generation / Augmentation    | Medium   | High
```

Items 1 and 2 should be done immediately as they require no schema changes.

Items 3, 4, and 9 should be done together as they involve schema additions.
They belong in a single migration.

Items 5 and 6 should be designed together. The Local API needs the jobs system
available so that LocalAPI calls can enqueue jobs within the same request.

Item 7 (plugin config transformation) is an internal refactor with no user-
visible impact beyond simplifying plugin authoring. It can happen incrementally.

Item 8 (collection override / extraColumns) should follow immediately after the
schema system is stabilized, as it is the primary extensibility mechanism for
power users.

---

## Part 13 -- What Payload Does Not Do Well

For completeness, these are areas where @unifiedcommerce/core is currently equal
to or ahead of PayloadCMS, and where Payload's design should not be copied:

**Transaction propagation.** Payload attaches the transaction ID to `req`, which
threads through all hook calls within a request. This works when everything goes
through a single `req` object. Our `TxContext` / `withTransaction` pattern is
more explicit and easier to reason about in serverless contexts where there is
no long-lived `req` object. Keep the explicit TxContext pattern.

**Error handling.** Payload throws exceptions extensively throughout its
codebase. Our `Result<T, E>` pattern is safer and makes the error surface
explicit. Do not adopt Payload's throw-everywhere style.

**Serverless first.** Payload 3 is Next.js-native, which means it runs well on
Vercel but is awkward on Cloudflare Workers, AWS Lambda without a Next.js
adapter, or bare Bun HTTP servers. Our Hono-based approach is genuinely portable.
This is a real advantage.

**MCP integration.** Payload has a `plugin-mcp` package but it is minimal
compared to our first-class MCP tool system with context enrichment and tool
manifests. Keep and extend the MCP system as a differentiator.

**Result types and in-memory testing.** Payload uses DI and a real database for
testing. Our in-memory repository factories allow tests to run without any
database, which is faster and more portable. Keep this.

---

## Conclusion

PayloadCMS is a production-grade, deeply thought-through system. The patterns
documented in this RFC represent the best parts of its architecture adapted for
the specific requirements of @unifiedcommerce/core: serverless portability, zero
vendor lock-in, and developer experience through composability rather than
configuration.

The single most important learning is the access composition pattern. It is
simple, pure, testable, and dramatically more expressive than role-based
permission flags. The second most important is the database-backed job queue,
which removes the last remaining reason to reach for an external queue service
for the majority of use cases.

The third, which is hardest to implement but highest in long-term value, is the
Local API with hook propagation. Once code within hooks can call other operations
and have those operations also run their hooks -- within the same transaction --
the checkout pipeline becomes dramatically simpler and more correct.
