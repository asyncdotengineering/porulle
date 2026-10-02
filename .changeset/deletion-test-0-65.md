---
"@porulle/core": minor
"@porulle/sdk": minor
"@porulle/cli": minor
"@porulle/adapter-neon": minor
"@porulle/adapter-pglite": minor
"@porulle/adapter-resend": minor
"@porulle/adapter-ses": minor
"@porulle/adapter-shopify": minor
"@porulle/adapter-tax-manual": minor
"@porulle/adapter-woocommerce": minor
"@porulle/import-shopify": minor
"@porulle/import-woocommerce": minor
"@porulle/jobs-cloudflare": minor
"@porulle/jobs-inngest": minor
"@porulle/jobs-pg-boss": minor
"@porulle/jobs-trigger": minor
"@porulle/plugin-appointments": minor
"@porulle/plugin-channel-connector": minor
"@porulle/plugin-giftcards": minor
"@porulle/plugin-marketplace": minor
"@porulle/plugin-notifications": minor
"@porulle/plugin-pos": minor
"@porulle/plugin-pos-restaurant": minor
"@porulle/plugin-scheduled-orders": minor
"@porulle/plugin-wishlist": minor
---

**BREAKING.** Removes dead and pass-through surface found by a deletion-test audit, and fixes the bugs that duplication was hiding. Full removal → replacement tables: `docs/migration-0.64-to-0.65.md`.

Fixes:

- Webhooks now deliver for `customers.*`, `pricing.*`, `promotions.*`, `inventory.update`, `fulfillment.create` and `cart.addItem`; those modules enqueued into a no-op job queue. `catalog.delete` and `pricing.update` are now emitted at all (their hooks were registered but never fired), so their webhooks and audit entries appear too.
- `auth.twoFactor.requiredForRoles` is enforced: a member of a listed role (including a composite role such as `"owner,admin"`) without 2FA gets `403 TWO_FACTOR_REQUIRED`, and booting with required roles while two-factor is disabled throws.
- `adapter-tax-manual` subtracts `orderDiscount` from the taxable base.
- `import-shopify` / `import-woocommerce` import the whole catalogue (not the first 250 / 100 products) and no longer multiply zero-decimal currencies by 100.
- Email adapters' default templates escape caller data.
- `formatAmount`, invoices and receipts honour zero-decimal currencies.
- Marketplace sub-order errors answer 422 / 404 instead of 500; PGlite transactions queue instead of interleaving, and a call joins only the transaction whose body it runs in.
- The built-in drizzle jobs engine rejects unknown task slugs at enqueue, like the other engines.

Removed:

- `@porulle/db` (use `pgTable` from `@porulle/core/drizzle`), `@porulle/sdk/react` and `createSDK`, the CLI's `migrate`, `generate migration` and `deploy`.
- From `@porulle/core`: `defineModule` and the module types, `createRepository`, `QueryRegistry` / `executeQuery`, the `access*` combinators, `toHttpError`, the `LocalAPI` class, `canAccessCart`, `BUILTIN_JOB_TASK_SLUGS`, `getTableNames`, `reuseOrCreateTxContext`, `ServiceRegistry`, `CommerceModuleTypes`, `HookRegistry#emit` / `#setLogger` / `#prependInTransaction`, `webhooks.enqueueDelivery`, `analytics.getDashboard` / `.meta()`, `tax.requireConfigured()`, `config.database.options`, `createHookContext`'s `kernel` argument, and `createSystemActor`'s default organization.
- From `@porulle/core/testing`: `createRepositoryTestHarness`, `createTestPluginContext`, `beforeHook`, `afterHook`.
- Plugin options nothing read (18 across marketplace, appointments and POS), marketplace contract pricing (its routes and the `marketplace_contract_prices` table), and POS's `createPOSPaymentAdapter`.

Added: `createTestActor`, `renderEmail`, `escapeHtml`, `currencyExponent`, `toMinorUnits`, `formatAmount`, `prepareEnqueue`, `createPGliteTransaction`, `normalizeExecuteShape`, `CommerceTwoFactorRequiredError`.
