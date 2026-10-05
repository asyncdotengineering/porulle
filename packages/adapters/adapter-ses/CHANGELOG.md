# @porulle/adapter-ses

## 0.77.1

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.77.1

## 0.77.0

### Patch Changes

- Updated dependencies [[`8997db5`](https://github.com/asyncdotengineering/porulle/commit/8997db50ccc1114c8ca92cd2ba900d15240fa401)]:
  - @porulle/core@0.77.0

## 0.76.0

### Patch Changes

- Updated dependencies [[`aeef73d`](https://github.com/asyncdotengineering/porulle/commit/aeef73daa24094b36153a71728cdff6b6a6b7312)]:
  - @porulle/core@0.76.0

## 0.75.0

### Patch Changes

- Updated dependencies [[`8716ab8`](https://github.com/asyncdotengineering/porulle/commit/8716ab81c62c14186808e6abc3bd319bf64df0d4)]:
  - @porulle/core@0.75.0

## 0.74.5

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.74.5

## 0.74.4

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.74.4

## 0.74.3

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.74.3

## 0.74.2

### Patch Changes

- Updated dependencies [[`162c4ad`](https://github.com/asyncdotengineering/porulle/commit/162c4ad92de86515f838fa9ff51b8c7cc275c3be)]:
  - @porulle/core@0.74.2

## 0.74.1

### Patch Changes

- Updated dependencies [[`b00ab8d`](https://github.com/asyncdotengineering/porulle/commit/b00ab8d6b7fef07fe69b3a46b5723a3f9dd950d0)]:
  - @porulle/core@0.74.1

## 0.74.0

### Patch Changes

- Updated dependencies [[`5234288`](https://github.com/asyncdotengineering/porulle/commit/52342881291d7998c5f23b8c43d0e521836bc3b3)]:
  - @porulle/core@0.74.0

## 0.73.3

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.73.3

## 0.73.2

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.73.2

## 0.73.1

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.73.1

## 0.73.0

### Patch Changes

- Updated dependencies [[`740dd11`](https://github.com/asyncdotengineering/porulle/commit/740dd11e8552eb346380a6fe4b5f008ebfa6e891)]:
  - @porulle/core@0.73.0

## 0.72.0

### Patch Changes

- Updated dependencies [[`df5b5f7`](https://github.com/asyncdotengineering/porulle/commit/df5b5f78a831a0622c5acf955bd794ce07ceb280)]:
  - @porulle/core@0.72.0

## 0.71.0

### Patch Changes

- Updated dependencies [[`7b19139`](https://github.com/asyncdotengineering/porulle/commit/7b191394ea3a81759e29311c644b0293df0b3d2d)]:
  - @porulle/core@0.71.0

## 0.70.2

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.70.2

## 0.70.1

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.70.1

## 0.70.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.70.0

## 0.69.0

### Patch Changes

- Updated dependencies [[`6d42ee6`](https://github.com/asyncdotengineering/porulle/commit/6d42ee6bb797f034839f9f63f45664573b4a155d)]:
  - @porulle/core@0.69.0

## 0.68.4

### Patch Changes

- Updated dependencies [[`51e3a25`](https://github.com/asyncdotengineering/porulle/commit/51e3a2585bd5a17d32c6b2638111fe85030b2c35)]:
  - @porulle/core@0.68.4

## 0.68.3

### Patch Changes

- Updated dependencies [[`8e81888`](https://github.com/asyncdotengineering/porulle/commit/8e8188840dd4da549b8917919554bddb24fa9e75)]:
  - @porulle/core@0.68.3

## 0.68.2

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.68.2

## 0.68.1

### Patch Changes

- Updated dependencies [[`73ea076`](https://github.com/asyncdotengineering/porulle/commit/73ea0768eec7d525f245eb44ce95d8a8b499fc50)]:
  - @porulle/core@0.68.1

## 0.68.0

### Patch Changes

- Updated dependencies [[`abb4c23`](https://github.com/asyncdotengineering/porulle/commit/abb4c23d151df9fe6f050ce91292b1829deeacc0)]:
  - @porulle/core@0.68.0

## 0.67.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.67.0

## 0.66.0

### Patch Changes

- Updated dependencies [[`9f3af48`](https://github.com/asyncdotengineering/porulle/commit/9f3af484b356975ae32fcfe62043bf456a851e4a)]:
  - @porulle/core@0.66.0

## 0.65.1

### Patch Changes

- [#161](https://github.com/asyncdotengineering/porulle/pull/161) [`488db7b`](https://github.com/asyncdotengineering/porulle/commit/488db7b089af397be850589fe9a60617280a93ff) Thanks [@octalpixel](https://github.com/octalpixel)! - **Breaking: package exports are rebuilt so every loader resolves them.** In 0.65.0 most packages exported their root entry under `import` only, so `require()` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`. drizzle-kit loads schema files through `require()`, so a schema importing a plugin failed while drizzle-kit still exited 0 and generated nothing. Every export entry is now `{ "@porulle/source": src, "types": dist .d.ts, "default": dist .js }`, and `./package.json` is exported.

  - `require()` and `import()` both load every entry. The packages are ESM. `require()` of ESM needs Node ≥ 20.19 or ≥ 22.12, so `engines.node` is now `>=20.19.0`.
  - Types come from the published `dist/*.d.ts`, not from `src/*.ts`.
  - The `bun` condition is gone. Bun loads `dist` like Node does. Inside this monorepo the source entry is the namespaced `@porulle/source` condition, enabled by `customConditions` in tsconfig.
  - The release now runs `scripts/check-package-exports.mjs` between build and publish. It resolves and loads every entry through `require()` and `import()`, and runs `publint --strict` and `attw`.

- Updated dependencies [[`488db7b`](https://github.com/asyncdotengineering/porulle/commit/488db7b089af397be850589fe9a60617280a93ff)]:
  - @porulle/core@0.65.1

## 0.65.0

### Minor Changes

- [#160](https://github.com/asyncdotengineering/porulle/pull/160) [`97dbe39`](https://github.com/asyncdotengineering/porulle/commit/97dbe39674692ea9dbf66df7645b58d727ab3da7) Thanks [@octalpixel](https://github.com/octalpixel)! - **BREAKING.** Removes dead and pass-through surface found by a deletion-test audit, and fixes the bugs that duplication was hiding. Full removal → replacement tables: `docs/migration-0.64-to-0.65.md`.

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

### Patch Changes

- Updated dependencies [[`97dbe39`](https://github.com/asyncdotengineering/porulle/commit/97dbe39674692ea9dbf66df7645b58d727ab3da7)]:
  - @porulle/core@0.65.0

## 0.64.0

## 0.63.0

## 0.62.0

## 0.61.0

## 0.60.0

## 0.59.0

## 0.58.0

## 0.57.1

## 0.57.0

## 0.56.0

## 0.55.0

## 0.54.0

## 0.53.1

## 0.53.0

## 0.52.0

## 0.51.0

## 0.50.3

## 0.50.2

## 0.50.1

## 0.50.0

## 0.49.0

## 0.48.1

## 0.48.0

## 0.47.0

## 0.46.0

## 0.45.0

## 0.44.0

## 0.43.0

## 0.42.0

## 0.41.0

## 0.40.1

## 0.40.0

## 0.39.0

## 0.38.0

## 0.37.0

## 0.36.0

## 0.35.1

## 0.35.0

## 0.34.0

## 0.33.0

## 0.32.0

## 0.31.0

## 0.30.0

## 0.29.0

## 0.28.0

## 0.27.0

## 0.26.0

## 0.25.0

## 0.24.1

## 0.24.0

## 0.23.0

## 0.22.0

## 0.21.0

## 0.20.3

## 0.20.2

## 0.20.1

## 0.20.0

## 0.19.0

## 0.18.0

## 0.17.0

## 0.16.0

## 0.15.0

## 0.14.0

## 0.13.0

## 0.12.0

## 0.11.0

## 0.10.8

## 0.10.6

## 0.10.5

## 0.10.4

## 0.10.3

## 0.10.2

## 0.10.1

## 0.10.0

## 0.9.0

## 0.8.0

## 0.7.0

## 0.6.0
