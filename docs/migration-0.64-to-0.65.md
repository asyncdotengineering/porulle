# Migrating from @porulle/* 0.64 to 0.65

0.65 is a deliberate **breaking** release. A deletion-test audit went through every package asking, for each module: *if this were deleted, would the complexity vanish, or reappear in its callers?* What vanished — dead exports, pass-through layers, options nothing read, copies of the same logic — is gone. Seven real bugs that the duplication was hiding are fixed.

Budget: an hour for a typical store. Most adopters only touch section 2. Read section 1 first: some bugs were silent, so the fix changes what you observe.

---

## 1. Bug fixes that change behaviour

| Area | Before | After | What to do |
| --- | --- | --- | --- |
| Webhooks | `customers.*`, `pricing.*`, `promotions.*`, `inventory.update`, `fulfillment.create` and `cart.addItem` endpoints **never received a delivery**: those modules enqueued into a no-op job queue. `catalog.delete` and `pricing.update` were never emitted at all. Only `orders.*`, `catalog.create` and `catalog.update` delivered. | Every subscribed event is enqueued on your jobs engine. Deleting a catalog entity and updating a price modifier now also write audit entries. | If you subscribed endpoints to these events, expect deliveries from now on. |
| `auth.twoFactor.requiredForRoles` | Documented as mandatory 2FA for those roles; nothing read it. | A signed-in member of a listed role — including a composite role such as `"owner,admin"` — who has not enrolled gets `403 TWO_FACTOR_REQUIRED` on every API route. `/api/auth/*` stays reachable so they can enrol at `POST /api/auth/two-factor/enable`. Booting with required roles while `twoFactor.enabled` is false throws. | If you set it, make sure those members have enrolled before you deploy. |
| `@porulle/adapter-tax-manual` | Ignored `orderDiscount`, so it over-collected tax on every order with an order-level discount. | Taxes `Σ(line − line discount) − orderDiscount` (floored at 0), plus shipping when taxable. | None. Expect lower, correct tax on discounted orders. |
| `@porulle/import-shopify`, `@porulle/import-woocommerce` | Imported only the first 250 / 100 products, silently. Shopify prices were always ×100, so 1500 JPY became 150000. | Page through the whole catalogue (Shopify `Link` cursors, WooCommerce `X-WP-TotalPages`). Prices use the store's currency exponent. The new `currency` option overrides the currency read from the store. | Re-run imports that may have been truncated. |
| Email (`adapter-resend`, `adapter-ses`) | Default templates interpolated caller data (`url`, `newStatus`, …) into HTML unescaped. | Default templates escape everything. Your own `templates` overrides still receive raw data. Escape it with `escapeHtml` from `@porulle/core`. | Review custom templates. |
| Money formatting | `formatAmount` and invoices/receipts divided by 100 for every currency. | Zero-decimal currencies (JPY, KRW, …) render without a decimal point. | None. |
| Jobs | The built-in drizzle engine accepted an enqueue for a task slug nobody registered; the job sat in the table forever. | Every engine throws `Unknown task slug: …` at enqueue. A blank `organizationId` is an `OrgResolutionError` on every engine. | Register every task you enqueue in `config.jobs.tasks`. |
| Marketplace sub-orders | Invalid status transition and missing sub-order answered **500**. | `422 INVALID_TRANSITION` and `404 NOT_FOUND`. | None. |
| `@porulle/adapter-pglite` | Two concurrent transactions interleaved inside one `BEGIN`. | Transactions queue; only a call made from inside a running body joins it. A failed `BEGIN` no longer leaves later transactions running without one. | None. |
| `createPluginTestApp` | Handed `config.routes` the raw kernel. | Hands it the same tenant-scoped route kernel production does, and maps errors with the production handler. | A plugin test that relied on the raw kernel now sees production behaviour. |

---

## 2. Removed APIs and their replacements

### `@porulle/core`

| Removed | Use instead |
| --- | --- |
| `defineModule`, `AppModule`, `ModuleDeps`, `ServiceMap` | Nothing. No config field accepted a module, so core's own services are now built from one ordered list. |
| `createRepository`, `BaseRepository`, `SoftDeletableRepository`, `RepositoryFor`, `Filters`, `FindOptions` | Plain drizzle queries. The factory never filtered by `organizationId`. |
| `QueryRegistry`, `executeQuery`, `EntityDefinition`, `RelationDefinition`, `QueryInput`, `QueryResult` | The module services (`kernel.services.*`) or drizzle. Nothing ever registered a query. |
| `accessOR`, `accessAND`, `conditional`, `isAdmin`, `isAuthenticated`, `isDocumentOwner`, `publicAccess`, `denyAll`, `AccessFn`, `AccessResult`, `AccessContext`, `WhereClause` | `assertPermission` / `assertOwnership`. Nothing turned a `WhereClause` into SQL. |
| `toHttpError`, `HttpErrorResponse` | Throw a `Commerce*Error` (`CommerceNotFoundError`, `CommerceValidationError`, …). The router maps it to its status. |
| `LocalAPI` (class, deprecated) | `createLocalAPI(kernel, { actor, tx })` |
| `canAccessCart` | The cart service's own ownership checks (`kernel.services.cart`). The helper contradicted them. |
| `BUILTIN_JOB_TASK_SLUGS` | The slugs themselves: `"webhooks/deliver"`, or `staleJobReaperTask.slug` |
| `getTableNames` | `Object.keys(getSchema())` |
| `reuseOrCreateTxContext` | `existing ?? createTxContext(tx, options)` |
| `ServiceRegistry`, `CommerceModuleTypes` | `Kernel["services"]` |
| `HookRegistry#emit`, `#setLogger`, `#prependInTransaction` | `append` / `appendInTransaction` / `prepend`, and resolve handlers through the hook pipeline. |
| `kernel.services.webhooks.enqueueDelivery` | Nothing to call: deliveries go through the `webhooks/deliver` job. |
| `kernel.services.analytics.getDashboard`, `.meta()` | `analytics.query(...)`, `analytics.getMeta()` |
| `kernel.services.tax.requireConfigured()` | Check `config.tax?.adapter` yourself. |
| `config.database.options` | Remove it. It was never read. |
| `createHookContext({ kernel: { database } })` | `createHookContext({ database: { db } })` or `{ db }` |
| `createSystemActor()` with no argument | `createSystemActor(orgId)`. The organization is now required. |

`PluginLogger` is now the same type as `Logger`. Code using it still compiles.

New in core: `createTestActor`, `renderEmail`, `escapeHtml`, `currencyExponent`, `toMinorUnits`, `formatAmount`, `prepareEnqueue`, `createPGliteTransaction`, `normalizeExecuteShape`, and `CommerceTwoFactorRequiredError`.

### `@porulle/core/testing`

| Removed | Use instead |
| --- | --- |
| `createRepositoryTestHarness` | `createTestKernel(overrides)`; `kernel.config` is the config. |
| `createTestPluginContext` | `createPluginTestApp(plugin)`. The fake context no longer matched the real `PluginContext`. |
| `beforeHook`, `afterHook` | Type the handler: `const h: AfterHook<Order> = async ({ result }) => { … }` |

### Other packages

| Package | Removed | Use instead |
| --- | --- | --- |
| `@porulle/db` | **The whole package** | `pgTable` and column builders from `@porulle/core/drizzle`, with an `organizationId` text column. This is how every first-party plugin defines its tables. |
| `@porulle/sdk` | `@porulle/sdk/react` (`createCommerceHooks`), `createSDK` | `createClient` from `@porulle/sdk`, plus `createQueryHooks` from `openapi-react-query` |
| `@porulle/cli` | `porulle migrate`, `porulle generate migration`, `porulle deploy` | `drizzle-kit migrate`, `drizzle-kit generate`, `vercel deploy` |
| `@porulle/adapter-neon` | `normalizeExecuteShape` | `normalizeExecuteShape` from `@porulle/core` |
| `@porulle/plugin-pos` | `createPOSPaymentAdapter`; options `defaultCurrency`, `maxHoldHours`, `discountOverrideThreshold` | Configure a core `PaymentAdapter`. The options did nothing; delete them. `ReceiptData` gains `currency`. |
| `@porulle/plugin-marketplace` | Options `vendorApprovalMode`, `requiredDocuments`, `defaultPayoutSchedule`, `defaultHoldbackDays`, `autoEscalateOnMissedDeadline`, `returnWindowDays`, `autoApproveReturnsOnVendorTimeout`, `vendorReturnResponseDays`, `requireVerifiedPurchase`, `performanceThresholds`, `b2b.contractPricing` | Delete them. None was ever read; `requireVerifiedPurchase` was documented as defaulting to `true` but never enforced. |
| `@porulle/plugin-marketplace` | Contract pricing: `GET/POST /marketplace/contract-prices`, `PATCH/DELETE /marketplace/contract-prices/{id}` | Nothing. Stored contract prices never affected any price. |
| `@porulle/plugin-appointments` | Options `defaultDurationMinutes`, `defaultBufferBeforeMinutes`, `defaultBufferAfterMinutes`, `defaultTimezone`, `autoConfirmCashBookings` | Delete them. They were never read. |

---

## 3. Schema

`@porulle/plugin-marketplace` no longer declares `marketplace_contract_prices`. Your next `drizzle-kit generate` proposes `DROP TABLE marketplace_contract_prices`. Nothing ever read those rows; if you want to keep them for reference, export them before you apply the migration.

No core table changed.

---

## 4. Checklist

1. Bump every `@porulle/*` dependency to `0.65.1` together (they are released as one group).
2. Remove `@porulle/db` from your dependencies and switch its imports to `@porulle/core/drizzle`.
3. `tsc --noEmit`: every removed export above fails to compile, so the compiler gives you the full list for your code.
4. Delete the plugin options listed in section 2.
5. If you use `auth.twoFactor.requiredForRoles`, confirm the listed members have enrolled.
6. Run `drizzle-kit generate` and review the marketplace `DROP TABLE` if you use the marketplace plugin.
7. Re-run catalogue imports that may have been truncated at 250 / 100 products.

---

## 5. 0.65.1: package exports

0.65.0 exported most packages' root entry under `import` only. `require()` of those packages failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`. drizzle-kit loads schema files through `require()`, so a `drizzle.config.ts` whose schema imported a plugin failed, and drizzle-kit still exited 0 and wrote no migration. 0.65.1 fixes this. Every entry now has the shape:

```json
".": {
  "@porulle/source": "./src/index.ts",
  "types": "./dist/index.d.ts",
  "default": "./dist/index.js"
}
```

What changes for you:

- **Node ≥ 20.19 (or ≥ 22.12).** The packages are ESM. `require()` loads them only on Node versions that support `require(esm)`, and `engines.node` now says so.
- **Types come from `dist/*.d.ts`.** Before 0.65.1 your compiler read the shipped `src/*.ts`. If you relied on a type that `src` exposed but the declarations do not, `tsc` reports it.
- **No `bun` condition.** Bun now loads `dist`, the same files Node loads. If you set `customConditions: ["bun"]` to reach `src`, remove it.
- **Run `drizzle-kit generate` again after upgrading.** A 0.65.0 run that printed `ERR_PACKAGE_PATH_NOT_EXPORTED` produced no migration, even though it exited 0.
