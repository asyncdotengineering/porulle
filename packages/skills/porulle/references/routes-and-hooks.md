# Routes and Hooks Reference

## Router Builder API

The `router()` function creates a type-safe route builder with OpenAPI documentation, auth, permissions, and input validation built in.

```ts
import { router } from "@porulle/core";

const routes = router("tag-name", "/prefix", ctx)
  .get("/path", { summary: "..." })     // or .post(), .patch(), .delete(), .put()
    .summary("Override summary")         // Optional: override the inline summary
    .description("Detailed description") // Optional: OpenAPI description
    .auth()                              // Require authentication (401 if missing)
    .permission("scope:action")          // Require permission (403 if denied)
    .input(zodSchema)                    // Validate request body
    .query(zodSchema)                    // Validate query parameters
    .params(zodSchema)                   // Validate path parameters
    .handler(async (ctx) => {            // Route handler
      return { data: result };           // Auto-wrapped response
    })
  .build();                              // Returns PluginRouteRegistration[]
```

The `/api` prefix is prepended automatically — never include `/api` in the router prefix. Use `"/loyalty"` not `"/api/loyalty"`. Pass `ctx` as the third argument to get scoped DB access in handlers.

Path parameters use `{name}` syntax: `.get("/items/{id}")`. Parameters named `id` are auto-validated as UUID.

POST routes return 201, all others return 200.

## Custom Routes (Non-Plugin)

Register routes directly in `commerce.config.ts`:

```ts
export default defineConfig({
  routes: (app, kernel) => {
    app.get("/api/custom", (c) => {
      return c.json({ data: { message: "hello" } });
    });
  },
});
```

This is raw Hono — you handle auth, validation, and error formatting yourself.

## Checkout Pipeline (Fixed Order)

The checkout pipeline runs 9 before hooks sequentially, then after hooks:

**Before hooks (inside transaction):**
1. `validateCartNotEmpty` — loads cart, confirms items exist
2. `resolveCurrentPrices` — resolves live prices, computes subtotal
3. `checkInventoryAvailability` — verifies stock for all items
4. `applyPromotionCodes` — applies promo codes and auto-discounts
5. `calculateTax` — computes tax via tax adapter
6. `calculateShipping` — computes shipping cost
7. *Plugin `checkout.beforePayment` hooks* — gift card deductions, loyalty redemptions
8. `validatePaymentMethod` — asserts payment method exists
9. `authorizePayment` — authorizes payment (does not capture)

**After hooks (outside transaction, compensation chain):**
1. Reserve inventory (compensatable)
2. Capture payment (compensatable)
3. Initiate fulfillment (best-effort)
4. Send confirmation email (best-effort)

If a compensatable step fails, previous steps are reversed.

## Hook Context

Every hook handler receives a context object:

```ts
interface HookContext {
  actor: Actor | null;       // Authenticated user
  tx: unknown;               // Current DB transaction (if inside one)
  db: PluginDb;              // Drizzle database instance
  logger: Logger;            // { info, warn, error }
  services: ServiceContainer;// All kernel services
  context: Record<string, unknown>; // Mutable bag for inter-hook data
  requestId: string;         // Unique request ID
  origin: "rest" | "local" | "mcp"; // How the operation was triggered
  jobs: JobsAdapter;         // Enqueue background jobs
}
```

## Enqueuing Background Jobs

From a hook:

```ts
handler: async ({ result, context }) => {
  await context.jobs.enqueue("my-task-slug", {
    orderId: result.id,
    amount: result.grandTotal,
  }, {
    queue: "default",
    maxAttempts: 3,
    delayMs: 60_000, // Wait 1 minute before executing
  });
}
```

Register task handlers in config:

```ts
export default defineConfig({
  jobs: {
    tasks: [{
      slug: "my-task-slug",
      handler: async ({ input, ctx }) => {
        await ctx.services.email.send({ ... });
        return { output: { sent: true } };
      },
      retries: { attempts: 3, backoff: { type: "exponential", delay: 5000 } },
    }],
    autorun: { enabled: true, intervalMs: 10_000 },
  },
});
```

## System-Registered Hooks

These fire automatically — you don't register them:

- **Webhook delivery**: 14 after-hooks trigger async webhook delivery via job queue
- **Audit logging**: 11 after-hooks record entries in `commerce_audit_log`
- **Search sync**: `catalog.afterCreate` and `catalog.afterUpdate` index entities
- **Order email**: `orders.afterStatusChange` sends status notification email

## Middleware

Apply Hono middleware to all routes:

```ts
export default defineConfig({
  middleware: [
    async (c, next) => {
      c.header("X-Custom", "value");
      await next();
    },
  ],
});
```

## Permission Format

Permissions follow `resource:action` or `resource:action:scope`:
- `catalog:read` — read access to catalog
- `orders:read:own` — read only own orders
- `*:*` — wildcard, full access (admin/owner roles)
