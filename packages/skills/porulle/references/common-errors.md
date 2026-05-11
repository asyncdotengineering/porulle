# Common Errors and Gotchas

## Import Errors

### `ERR_MODULE_NOT_FOUND` or `Cannot find module`
**Cause:** Missing `.js` extension in import.
**Fix:** Always use `.js` extensions — `moduleResolution: "NodeNext"` requires them.
```ts
// Wrong
import { Foo } from "./bar";
// Right
import { Foo } from "./bar.js";
```

### `Cannot find module '@porulle/core/schema'`
**Cause:** Package not installed or wrong sub-path.
**Fix:** Ensure `@porulle/core` is installed. Sub-path exports are:
- `@porulle/core` — main exports
- `@porulle/core/schema` — all Drizzle table definitions
- `@porulle/core/schema-utils` — `mergeExtraColumns()`

## Database Errors

### `null` vs `undefined` in Drizzle
**Problem:** Drizzle returns `null` for nullable columns. Code using `!== undefined` passes `null` through.
**Fix:** Use `!= null` (loose equality) to catch both:
```ts
// Wrong — misses null
if (variantId !== undefined) { ... }
// Right — catches both null and undefined
if (variantId != null) { ... }
```

### `eq(column, null)` generates wrong SQL
**Problem:** `eq(myTable.col, null)` generates `col = NULL` which never matches. SQL requires `IS NULL`.
**Fix:** Use `isNull()`:
```ts
import { isNull } from "drizzle-orm";
// Wrong
.where(eq(myTable.variantId, null))
// Right
.where(isNull(myTable.variantId))
```

### Duplicate index name collision when extending tables
**Problem:** Re-declaring index definitions from a core table causes `index already exists` errors.
**Fix:** Only pass column definitions to `mergeExtraColumns()`. Do NOT include the third argument (indexes) from the core table.

### Schema changes not taking effect
**Fix:** Run `bunx drizzle-kit push` after any schema modification. For production, use `drizzle-kit generate` + `drizzle-kit migrate`.

## Auth Errors

### 401 Unauthorized on all requests
**Causes:**
1. Missing `x-api-key` header or `Authorization: Bearer` header
2. `auth.apiKeys.enabled` is not `true`
3. No API key generated: run `bunx @porulle/cli api-key create --scope admin`
4. API key is expired or disabled

### 403 Forbidden
**Causes:**
1. Actor's role doesn't include the required permission
2. Route uses `.permission("scope")` and the actor lacks that scope
3. Fix: Add the permission to the role in `auth.roles` or use `*:*` for admin

### CSRF 403 on POST/PATCH/DELETE
**Cause:** `Origin` header doesn't match `auth.trustedOrigins`.
**Fix:** Add your frontend URL to `trustedOrigins`:
```ts
auth: { trustedOrigins: ["http://localhost:3000", "https://mystore.com"] }
```
API key requests are exempt from CSRF.

## Plugin Errors

### Plugin routes not appearing in OpenAPI spec
**Cause:** Using raw Hono route registration instead of `router()` builder.
**Fix:** Use `router()` — it automatically generates OpenAPI metadata.

### Plugin schema tables not created
**Cause:** Schema file not listed in `drizzle.config.ts`.
**Fix:** Add the plugin's schema file path:
```ts
schema: [
  "./node_modules/@porulle/core/src/kernel/database/schema.ts",
  "./node_modules/@porulle/plugin-*/src/schema.ts",  // glob catches published plugins
  "./src/plugins/my-plugin-schema.ts",  // app-level plugin
],
```

### `Unknown task slug` in job queue
**Cause:** Task handler not registered in config.
**Fix:** Add the task definition to `config.jobs.tasks`:
```ts
jobs: {
  tasks: [myTaskDefinition],
  autorun: { enabled: true },
}
```

## Payment Adapter Errors

### `Err()` takes wrong argument type
**Problem:** `Err("some string")` works for `PluginResult<T>` but NOT for core adapter `Result<T>`.
**Fix:** Core `Result<T, CommerceError>` requires `Err({ code: "ERROR_CODE", message: "description" })`:
```ts
// Wrong (for core adapters)
return Err("Payment failed");
// Right
return Err({ code: "PAYMENT_FAILED", message: "Card declined" });
```

### `verifyWebhook` has wrong signature
**Problem:** `verifyWebhook(rawBody: string, headers: Record<string, string>)` — wrong.
**Fix:** The actual interface is `verifyWebhook(request: Request)` — it receives the raw web `Request` object:
```ts
async verifyWebhook(request: Request): Promise<Result<PaymentWebhookEvent>> {
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");
  // ...verify and return Ok({ id, type, data })
}
```

## Checkout Errors

### `Cart is empty`
**Cause:** Cart has no line items, or cart has expired.
**Fix:** Add items to the cart before calling checkout.

### `Insufficient inventory`
**Cause:** Requested quantity exceeds available stock.
**Fix:** Check inventory with `GET /api/inventory?entityId=...` before checkout.

### `Invalid payment method`
**Cause:** `paymentMethodId` in checkout request doesn't match any configured adapter's `providerId`.
**Fix:** Ensure the `providerId` in your `PaymentAdapter` matches what you pass to checkout.

## Deployment Errors

### Vercel: `Cannot resolve module`
**Cause:** Workspace packages have conditional exports pointing to TypeScript source instead of compiled JS.
**Fix:** All packages must have `"import"` condition in `exports` pointing to `dist/*.js` files. Run `turbo build` before deploying.

### Engine throws about enableDevKey or devKey
**Cause:** `auth.enableDevKey` or `auth.devKey` present in config.
**Result:** Fatal error at startup — both fields were removed.
**Fix:** Remove both fields. Use `auth.apiKeyScopes` and generate keys via CLI:
```bash
bunx @porulle/cli api-key create --scope admin
```

## Type Errors

### `as unknown as` double-casting
**Problem:** Common in older code, but unnecessary since `PluginDb` was added.
**Fix:** Use narrow types instead:
- Database: `PluginDb` from `@porulle/core`
- Tables: `PgTable` from `drizzle-orm/pg-core`
- Dynamic queries: use `.$dynamic()` method
- Column introspection: use `getTableColumns(table)`

### `z.string().uuid()` deprecated
**Fix:** Use `z.uuid()` from Zod 4+.

## Performance

### Slow list queries
**Fix:** UC enforces max 100 items per page. Use pagination:
```ts
GET /api/catalog/entities?page=1&limit=20
```

### Job queue not processing
**Causes:**
1. `jobs.autorun.enabled` is not `true`
2. No task handlers registered for the enqueued task slugs
**Fix:** Enable autorun or poll `GET /api/jobs/run?queue=default&limit=10` via cron.
