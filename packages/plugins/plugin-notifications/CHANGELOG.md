# @porulle/plugin-notifications

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

### Patch Changes

- Updated dependencies [[`dd9c0fb`](https://github.com/asyncdotengineering/porulle/commit/dd9c0fbfb3073307d81253bcf5177f7f2f372b80)]:
  - @porulle/core@0.64.0

## 0.63.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.63.0

## 0.62.0

### Patch Changes

- Updated dependencies [[`821ebd4`](https://github.com/asyncdotengineering/porulle/commit/821ebd490a87ee52b85bd8ac538f3c6993219782)]:
  - @porulle/core@0.62.0

## 0.61.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.61.0

## 0.60.0

### Patch Changes

- Updated dependencies [[`a227273`](https://github.com/asyncdotengineering/porulle/commit/a2272739c3e7f73fa0b98c9dca970f6700632381)]:
  - @porulle/core@0.60.0

## 0.59.0

### Patch Changes

- Updated dependencies [[`0ec04dc`](https://github.com/asyncdotengineering/porulle/commit/0ec04dc860d7afb9e2367425c7264de2e9c066a9)]:
  - @porulle/core@0.59.0

## 0.58.0

### Patch Changes

- Updated dependencies [[`a8c90a0`](https://github.com/asyncdotengineering/porulle/commit/a8c90a0ae793c7471a03c54e2abe41f30b307a4d)]:
  - @porulle/core@0.58.0

## 0.57.1

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.57.1

## 0.57.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.57.0

## 0.56.0

### Patch Changes

- Updated dependencies [[`e3b8102`](https://github.com/asyncdotengineering/porulle/commit/e3b8102d85b528546ff37aca4ef8de6f8c8ef03e)]:
  - @porulle/core@0.56.0

## 0.55.0

### Patch Changes

- Updated dependencies [[`4c140bc`](https://github.com/asyncdotengineering/porulle/commit/4c140bcdd82e8e3cc3957f629941f878b2e3a6a4)]:
  - @porulle/core@0.55.0

## 0.54.0

### Patch Changes

- Updated dependencies [[`01484a9`](https://github.com/asyncdotengineering/porulle/commit/01484a92d8d8be6b99350198a7eda0a5c5a392fb)]:
  - @porulle/core@0.54.0

## 0.53.1

### Patch Changes

- Updated dependencies [[`98b8547`](https://github.com/asyncdotengineering/porulle/commit/98b8547673c3cfded32562ec1a313958562d961e)]:
  - @porulle/core@0.53.1

## 0.53.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.53.0

## 0.52.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.52.0

## 0.51.0

### Patch Changes

- Updated dependencies [[`579a00b`](https://github.com/asyncdotengineering/porulle/commit/579a00b46dc982aa6e0e5b3a5c9e4cce325e96e7)]:
  - @porulle/core@0.51.0

## 0.50.3

### Patch Changes

- Updated dependencies [[`54f215c`](https://github.com/asyncdotengineering/porulle/commit/54f215c3b833131c4378b54b8ab26c1b330ebef5)]:
  - @porulle/core@0.50.3

## 0.50.2

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.50.2

## 0.50.1

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.50.1

## 0.50.0

### Patch Changes

- Updated dependencies [[`269e445`](https://github.com/asyncdotengineering/porulle/commit/269e445300d6afe05039fd9d0d56eda7067f8816)]:
  - @porulle/core@0.50.0

## 0.49.0

### Patch Changes

- Updated dependencies [[`bd48f59`](https://github.com/asyncdotengineering/porulle/commit/bd48f595b827e64920bb7243c2310f31d1f2b97c)]:
  - @porulle/core@0.49.0

## 0.48.1

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.48.1

## 0.48.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.48.0

## 0.47.0

### Patch Changes

- Updated dependencies [[`71ace6a`](https://github.com/asyncdotengineering/porulle/commit/71ace6a67d7dcae1602f2bbf6d91c97435a06ec8)]:
  - @porulle/core@0.47.0

## 0.46.0

### Patch Changes

- Updated dependencies [[`63d0562`](https://github.com/asyncdotengineering/porulle/commit/63d0562af8c12314509545a6c4379946b9629e6f)]:
  - @porulle/core@0.46.0

## 0.45.0

### Patch Changes

- Updated dependencies [[`1e3ea65`](https://github.com/asyncdotengineering/porulle/commit/1e3ea6566ed1cd5dac9388af5511835d42e7f466)]:
  - @porulle/core@0.45.0

## 0.44.0

### Patch Changes

- Updated dependencies [[`adf43da`](https://github.com/asyncdotengineering/porulle/commit/adf43da78b7d48baf8a2074a65b759a1bee6df2f), [`74a4a60`](https://github.com/asyncdotengineering/porulle/commit/74a4a6040cef90e420e780a3deb189857db7a15a), [`05b4efc`](https://github.com/asyncdotengineering/porulle/commit/05b4efc72374f5787d91c85321c90a3f43fbc436)]:
  - @porulle/core@0.44.0

## 0.43.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.43.0

## 0.42.0

### Patch Changes

- Updated dependencies [[`e9f1de6`](https://github.com/asyncdotengineering/porulle/commit/e9f1de6d18a35e706153c2e596799d35c00ffbc2)]:
  - @porulle/core@0.42.0

## 0.41.0

### Patch Changes

- Updated dependencies [[`7f3dacc`](https://github.com/asyncdotengineering/porulle/commit/7f3daccf2c40ce2425ae34badff43086cec4df66)]:
  - @porulle/core@0.41.0

## 0.40.1

### Patch Changes

- Updated dependencies [[`bc1ca17`](https://github.com/asyncdotengineering/porulle/commit/bc1ca17f168ef3c6bbad5eec2144cf4e5853b912)]:
  - @porulle/core@0.40.1

## 0.40.0

### Patch Changes

- Updated dependencies [[`c16c3fa`](https://github.com/asyncdotengineering/porulle/commit/c16c3fa44a4bb662a75dd28362faea9f8697eecf)]:
  - @porulle/core@0.40.0

## 0.39.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.39.0

## 0.38.0

### Patch Changes

- Updated dependencies [[`26b2da1`](https://github.com/asyncdotengineering/porulle/commit/26b2da16f4fe03a28566d91d6ca7aa4f46fea3c5)]:
  - @porulle/core@0.38.0

## 0.37.0

### Patch Changes

- Updated dependencies [[`f28bef1`](https://github.com/asyncdotengineering/porulle/commit/f28bef11a0ae73b1011aa29f7772d2c8fa6b05cd)]:
  - @porulle/core@0.37.0

## 0.36.0

### Patch Changes

- Updated dependencies [[`1603287`](https://github.com/asyncdotengineering/porulle/commit/1603287a8a47a0ad4f5d14cc3a6e6b339cdee31d), [`9527725`](https://github.com/asyncdotengineering/porulle/commit/952772518cc07e2fedc8792847c3a9d22072f0e9)]:
  - @porulle/core@0.36.0

## 0.35.1

### Patch Changes

- Updated dependencies [[`93715ed`](https://github.com/asyncdotengineering/porulle/commit/93715ededae7c8fb35f1d2c81637136e8a887501)]:
  - @porulle/core@0.35.1

## 0.35.0

### Patch Changes

- Updated dependencies [[`217f9a6`](https://github.com/asyncdotengineering/porulle/commit/217f9a6f80630d66f50fa06a00322656bda9f61b)]:
  - @porulle/core@0.35.0

## 0.34.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.34.0

## 0.33.0

### Patch Changes

- Updated dependencies [[`bc4328b`](https://github.com/asyncdotengineering/porulle/commit/bc4328badd48a76be1c31df349e881a2a66359be)]:
  - @porulle/core@0.33.0

## 0.32.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.32.0

## 0.31.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.31.0

## 0.30.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.30.0

## 0.29.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.29.0

## 0.28.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.28.0

## 0.27.0

### Patch Changes

- Updated dependencies [[`687c7df`](https://github.com/asyncdotengineering/porulle/commit/687c7dfb546b023a9686b4af3ed446719b16b2fc)]:
  - @porulle/core@0.27.0

## 0.26.0

### Patch Changes

- Updated dependencies [[`8fd3716`](https://github.com/asyncdotengineering/porulle/commit/8fd3716a5fb5974c4a2b55f2d9a6bfecd6855a4a)]:
  - @porulle/core@0.26.0

## 0.25.0

### Patch Changes

- Updated dependencies [[`45b8c18`](https://github.com/asyncdotengineering/porulle/commit/45b8c18fa6ab40664794c0e8c7cefb69d60ba69c)]:
  - @porulle/core@0.25.0

## 0.24.1

### Patch Changes

- Updated dependencies [[`37c51fe`](https://github.com/asyncdotengineering/porulle/commit/37c51feb3dfad82fd6cf8e63dc18b07ea1b5caf5)]:
  - @porulle/core@0.24.1

## 0.24.0

### Patch Changes

- Updated dependencies [[`6832853`](https://github.com/asyncdotengineering/porulle/commit/6832853d83b02b5ba83c8e4008e4ec36b5e210eb)]:
  - @porulle/core@0.24.0

## 0.23.0

### Patch Changes

- Updated dependencies [[`cf30ee4`](https://github.com/asyncdotengineering/porulle/commit/cf30ee485b8050f393452a1bed7adf3e2bacc558)]:
  - @porulle/core@0.23.0

## 0.22.0

### Patch Changes

- Updated dependencies [[`0a719cd`](https://github.com/asyncdotengineering/porulle/commit/0a719cd9cbf6836f513b642e566e82d16ea3e97c)]:
  - @porulle/core@0.22.0

## 0.21.0

### Patch Changes

- Updated dependencies [[`f6d69fb`](https://github.com/asyncdotengineering/porulle/commit/f6d69fbe64165b2e9a6bd892ba433f69273f8dee)]:
  - @porulle/core@0.21.0

## 0.20.3

### Patch Changes

- Updated dependencies [[`17f743c`](https://github.com/asyncdotengineering/porulle/commit/17f743c2c4a7c08f111561748d140f84c214a60d)]:
  - @porulle/core@0.20.3

## 0.20.2

### Patch Changes

- Updated dependencies [[`ad671d2`](https://github.com/asyncdotengineering/porulle/commit/ad671d223368be15e1517917527dc2aa9c0f105e)]:
  - @porulle/core@0.20.2

## 0.20.1

### Patch Changes

- Updated dependencies [[`8ba7ebf`](https://github.com/asyncdotengineering/porulle/commit/8ba7ebfe90286c9bbc07651458c596aaa004b070)]:
  - @porulle/core@0.20.1

## 0.20.0

### Patch Changes

- Updated dependencies [[`e99bf87`](https://github.com/asyncdotengineering/porulle/commit/e99bf873d09fcb00bae42845b04f23e126e1293c)]:
  - @porulle/core@0.20.0

## 0.19.0

### Patch Changes

- Updated dependencies [[`d98a0cf`](https://github.com/asyncdotengineering/porulle/commit/d98a0cf04578f4c89a758a3544a5a7bc99e9444c)]:
  - @porulle/core@0.19.0

## 0.18.0

### Patch Changes

- Updated dependencies [[`7ca0da4`](https://github.com/asyncdotengineering/porulle/commit/7ca0da4237e05f890d403397d839eccc27bb5900)]:
  - @porulle/core@0.18.0

## 0.17.0

### Patch Changes

- Updated dependencies [[`4bc5a61`](https://github.com/asyncdotengineering/porulle/commit/4bc5a6137a01a2f221c4d1ba0c8d22d7e80b7f56)]:
  - @porulle/core@0.17.0

## 0.16.0

### Patch Changes

- Updated dependencies [[`983bc69`](https://github.com/asyncdotengineering/porulle/commit/983bc696af361445cf5d19b4d69b1a9f4a25fb83)]:
  - @porulle/core@0.16.0

## 0.15.0

### Patch Changes

- Updated dependencies [[`dd59c5c`](https://github.com/asyncdotengineering/porulle/commit/dd59c5cd0d456d90b0cfb0af6b744a2520dc8f57)]:
  - @porulle/core@0.15.0

## 0.14.0

### Patch Changes

- Updated dependencies [[`3f1de20`](https://github.com/asyncdotengineering/porulle/commit/3f1de204f0ebb07f634fe702ddc8a6f1d6fd7f22), [`0583eab`](https://github.com/asyncdotengineering/porulle/commit/0583eab02f80869f3aba3fdc2ae847712cbd6959), [`f476b2c`](https://github.com/asyncdotengineering/porulle/commit/f476b2c2687dc4bed24de65a1ab1abdf08853066), [`32136d4`](https://github.com/asyncdotengineering/porulle/commit/32136d49df43995e167e1198d1b768976e1eb85f)]:
  - @porulle/core@0.14.0

## 0.13.0

### Patch Changes

- Updated dependencies [[`6cfb51d`](https://github.com/asyncdotengineering/porulle/commit/6cfb51debf27bb2f9bac26320d95414bf3443905), [`98e75bb`](https://github.com/asyncdotengineering/porulle/commit/98e75bb0222d9079589d97dca74de0f0dda4e12c), [`8c2c116`](https://github.com/asyncdotengineering/porulle/commit/8c2c1160acf87b981b3be8606918cde057fed833), [`4f9e5b9`](https://github.com/asyncdotengineering/porulle/commit/4f9e5b939b72849b943de6fe2d2751dac8d6caba), [`5ee7ae3`](https://github.com/asyncdotengineering/porulle/commit/5ee7ae3628acb29ea56738423c8cfe5e10d26182), [`0948324`](https://github.com/asyncdotengineering/porulle/commit/0948324c22f1468dfeb73707f6f77d182bc58494), [`54bf6cf`](https://github.com/asyncdotengineering/porulle/commit/54bf6cfcb5f45b46cecdd9a1568a104ae647817c), [`f36de3a`](https://github.com/asyncdotengineering/porulle/commit/f36de3a4524c67eb79badeeb2a33f3502c75bf18), [`cf611f9`](https://github.com/asyncdotengineering/porulle/commit/cf611f9f6b21a4dd3eaee7e3cab8c9f7d2faf431), [`7688ce2`](https://github.com/asyncdotengineering/porulle/commit/7688ce2eb4e1eea74a9ec0bfab90cdb74078bcc6), [`bc5c825`](https://github.com/asyncdotengineering/porulle/commit/bc5c825919d3f0cbbf4849cdefb72b61c430fb0d), [`d6f27f6`](https://github.com/asyncdotengineering/porulle/commit/d6f27f6b24cb0de70b77529f81d0677d0b235a5f)]:
  - @porulle/core@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.11.0

## 0.10.8

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.10.8

## 0.10.6

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.10.6

## 0.10.5

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.10.5

## 0.10.4

### Patch Changes

- Updated dependencies [[`26a5a72`](https://github.com/asyncdotengineering/porulle/commit/26a5a722ae2e2a94d284e71f8e824ab2c985cce0)]:
  - @porulle/core@0.10.4

## 0.10.3

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.10.3

## 0.10.2

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.10.2

## 0.10.1

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.10.1

## 0.10.0

### Patch Changes

- Updated dependencies [[`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce), [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce), [`8f8c564`](https://github.com/asyncdotengineering/porulle/commit/8f8c564deb399a86c50d27d8ca07e5334888bf30), [`ff3d5e6`](https://github.com/asyncdotengineering/porulle/commit/ff3d5e6e876f090119fd025aa6b5499f0dccd9fb), [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce), [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce)]:
  - @porulle/core@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [5c580c4]
- Updated dependencies [ae7c329]
- Updated dependencies [157221c]
- Updated dependencies [f40b3d1]
- Updated dependencies [230f405]
  - @porulle/core@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.6.0
