# @porulle/adapter-shopify

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

### Minor Changes

- [#125](https://github.com/asyncdotengineering/porulle/pull/125) [`c16c3fa`](https://github.com/asyncdotengineering/porulle/commit/c16c3fa44a4bb662a75dd28362faea9f8697eecf) Thanks [@octalpixel](https://github.com/octalpixel)! - Breaking: the channel connector pushes an order to its merchant when payment lands, not when the order row is created

  **The default changed. If you use `@porulle/plugin-channel-connector` and your orders start in `pending_payment`, they are no longer pushed at creation** — they are pushed when they leave that state for anything but `cancelled`. This is a behaviour change, not only a new option: a consumer reading "added `pushOrderOn`" and nothing else would not learn that their push moved.

  Until now `buildHooks` registered an `orders.afterCreate` hook that enqueued `channel/push-order` the moment the order row existed, with no reference to payment. For any consumer with a payment step that pushed an unpaid order to a real merchant, who then picks, packs and ships it.

  `ChannelConnectorPluginOptions.pushOrderOn` selects the trigger:

  - `"payment"` (the new default) — an order created in `pending_payment` is not pushed; it is pushed on `orders.afterStatusChange` when it leaves `pending_payment` for anything but `cancelled`. An order created in `pending` is still pushed on creation, so a store with no payment step is unaffected.
  - `"create"` — the previous behaviour, for consumers who want it. Set this to keep today's timing.
  - `false` — no automatic push at all; enqueue `channel/push-order` yourself.

  The predicate is the _transition_ (`fromStatus === "pending_payment"`), not "the new status looks paid". Core commits a status with a compare-and-swap, so exactly one caller wins a given transition and the push fires exactly once by construction. Keying on the new status alone would re-push on every later move, because `exportOrder` short-circuits only on an already-`confirmed` export and pushes one still `exported` again.

  **`orders.afterStatusChange` hooks now receive the transition in `data`.** It was always `null`, because `runAfterHooks` was called with `null` as its original data while core had already built the `{ orderId, fromStatus, newStatus, reason? }` input for the _before_ hooks and then discarded it. A hook that needed to know which transition occurred could not find out; the order itself carries only the status it now has.

  `AfterHook` takes an optional second type parameter for this — `AfterHook<TResult, TData = TResult>` — so `data` and `result` may differ in shape where the committed entity is not the input. The default keeps every existing single-argument use identical, and `runAfterHooks` gained the matching parameter.

  **Known and deliberately unchanged:** core's own `sendOrderStatusEmail` reads `result.newStatus` and `result.previousStatus`, which the hydrated order does not carry, so it has never sent an email and still does not. Switching a dormant customer-facing email path on is a separate decision from moving the seam, and it is not made here.

  Also: `@porulle/adapter-shopify` now carries variant weight through `importCatalog`.

  Shopify's REST variant returns `grams`, plus `weight` with a `weight_unit`, on every variant. The adapter's internal response type declared none of them, so `importCatalog` discarded the weight and every imported product arrived weightless. Variants now map to `metadata.weightGrams`, the key `resolveWeightGrams` reads when it prices shipping.

  `grams` wins when present and positive; otherwise `weight` is converted from `g`, `kg`, `oz` or `lb`. An unrecognised `weight_unit` is refused rather than assumed to be grams — reading `"lbs"` as grams under-prices a parcel by a factor of 453. The key is **omitted** when no weight is known, never written as `0`, because `0` is indistinguishable from a genuinely weightless item. This half is additive: a consumer that ignores `variant.metadata` is unaffected.

### Patch Changes

- Updated dependencies [[`c16c3fa`](https://github.com/asyncdotengineering/porulle/commit/c16c3fa44a4bb662a75dd28362faea9f8697eecf)]:
  - @porulle/core@0.40.0

## 0.39.0

### Minor Changes

- [#124](https://github.com/asyncdotengineering/porulle/pull/124) [`d9aca5c`](https://github.com/asyncdotengineering/porulle/commit/d9aca5c1f7620b516afdb444b5e168ff7f884eb5) Thanks [@octalpixel](https://github.com/octalpixel)! - Let a caller point the Shopify adapter at a different origin, and read RFC 8288's bare `rel` token

  `ShopifyConnectorOptions.baseUrl` overrides the origin for every Shopify call — the Admin API and
  both OAuth endpoints. Absent, it resolves to `https://{store.storeDomain}` and the request is
  byte-identical to the one this adapter has always made, so no existing caller sees a difference.

  It is an ORIGIN rather than a base URL because Shopify's host is per-store: the shop still rides
  inside the path the adapter appends. A caller pointing at a local stand-in passes
  `http://127.0.0.1:<port>/shopify` and the stand-in serves Shopify's own address table unprefixed.

  There is deliberately no `mock` flag and no URL rewriting inside `fetchImpl`. The shipped path must
  be the tested path; a branch inside the adapter means the code a test exercises is not the code that
  runs, and reaching a stand-in by rewriting URLs inside an injected fetch is the same failure wearing
  a hook.

  The `Link` header's pagination relation is now read as a quoted string OR a bare token, both of
  which RFC 8288 permits. The argument is the asymmetry rather than the likelihood: a reader that
  accepts only `rel="next"` and meets `rel=next` does not throw — it finds no next link, ends the
  walk, and reports a SUCCESSFUL import of a partial catalogue. Accepting both cannot make a malformed
  header parse as a valid one, so the permissive direction has no matching cost.

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

### Minor Changes

- Complete the outbound catalog push path: Porulle can now write catalog data back to a connected store, not only read from it.

  **Both adapters implement `pushCatalog`.** Shopify writes native product fields and metafields in a Porulle-owned namespace, adds the `write_products` scope, and resolves push capability per store from the scopes that store actually granted — a store connected before the scope existed fails closed with a non-retriable error naming the re-authorisation route rather than 403ing forever. WooCommerce writes native fields, `meta_data` under a Porulle prefix, and global `pa_*` taxonomy attributes for fields marked filterable, since only those drive layered navigation. Both resolve placement from the payload's intent plus its remote key, and neither will guess a remote key it was not given.

  Three WooCommerce write semantics are handled explicitly because getting them wrong destroys merchant data: the product `attributes` array is replaced wholesale on update, so it is read-merge-written; underscore-prefixed meta keys are rerouted by WooCommerce to first-class property setters, so the Porulle prefix is enforced structurally; and the batch endpoint reports per-item failures inside an HTTP 200, so its body is parsed rather than its status trusted. Image pushes carry the imported attachment id and merge against the current gallery instead of rebuilding it.

  **Catalog writes are triggered, previewable, and reversible by a human.** A change to a platform-owned field enqueues a push for the stores that map the entity, skipping writes that originated from channel convergence so an import cannot bounce straight back out. `POST /api/channels/stores/:id/push-catalog/preview` returns the per-field diff a push would apply, assembled by the same builder the job uses, and distinguishes a remote value that is absent from one that was never read.

  **A shared field that changes on both sides now waits for a person.** Convergence holds the field, records both values, and surfaces the conflict for review at `GET /api/channels/conflicts`; resolving it applies the chosen value without reassigning ownership, so the field stays shared and can conflict again.

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.12.0

## 0.11.0

### Minor Changes

- Catalog data-quality primitives, lossless channel import, and the outbound catalog contract.

  **Catalog.** Custom-field values are now updatable and carry provenance: `source`, `status` (proposed/approved/rejected), `confidence`, `evidence`, `locale`, and approval stamps, with one approved value per (entity, field, locale). A review workflow ships whole: approve/reject endpoints that displace the live value atomically and preserve evidence, an org-scoped proposal queue, and `?include=customFields` on entity reads returning approved rows. `select` fields enforce their declared options exact-match. Runtime entity field definitions layer over code config with admin REST and archive-never-delete semantics. Every catalog mutation writes a full entity revision in the same transaction, with true restore, per-entity monotonic numbering, and org-scoped retention trim. Media assets carry an origin (merchant/generated/imported) with a derivation link, and entity-media uniqueness is enforced per level.

  **Search.** `SearchFilters.attributes` and `SearchDocument.attributes` add attribute filtering and facets (AND across names, OR within one), opt-in per field via `filterable`, indexing approved values only — implemented in the in-memory engine, `adapter-pg-search` (parameterized jsonb), and `adapter-meilisearch` (union-safe filterable settings). The REST search route accepts repeatable `attr.<name>` parameters with an allowlisted grammar.

  **Channels.** `ChannelCatalogItem` widens to the full catalog shape — per-locale attributes, images, option axes, tags, brand, categories, status, and variant prices with compare-at — while staying structurally unable to express checkout state. Both connectors import the full payloads their platforms return, with currency-gated minor-unit prices. Convergence writes real catalog tables idempotently and merges metadata per key. A resumable per-store backfill (REST, durable job, and `porulle channel:backfill`) upgrades catalogs imported before this release. Per-field catalog ownership (`platform`/`store`/`shared`) with deterministic precedence governs every inbound path, holding shared conflicts persistently; connecting a store never implies catalog write access, and per-store placement mappings resolve at read time over provider defaults. The `ChannelConnector` contract gains an optional `pushCatalog` capability with intent-based payloads, per-item outcomes with prior remote values, and a platform-owned-only assembly — the write paths land in a following release.

  Consumer migrations for the schema additions are documented per feature in the repository's `docs/migration-*.md` files. PostgreSQL 15+ is now required.

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

### Minor Changes

- [#77](https://github.com/asyncdotengineering/porulle/pull/77) [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce) Thanks [@octalpixel](https://github.com/octalpixel)! - Add Shopify and WooCommerce catalog synchronization plus paid order injection with transparent customer shipping details, remote status confirmation, and tiered failed-export handling.

- [#77](https://github.com/asyncdotengineering/porulle/pull/77) [`8f8c564`](https://github.com/asyncdotengineering/porulle/commit/8f8c564deb399a86c50d27d8ca07e5334888bf30) Thanks [@octalpixel](https://github.com/octalpixel)! - Add generic one-click store onboarding: Shopify OAuth and WooCommerce `/wc-auth` endpoint flows via new engine-plugin routes (`/api/channels/oauth/{provider}/start` + `/callback`), signed single-use callback state, and connector `buildAuthUrl`/`completeAuth` methods — alongside the existing credential-paste path. Add Shopify mandatory GDPR compliance webhook ingress: `POST /api/channels/compliance/{provider}` unauthenticated route, app-secret HMAC verification (`verifyAppWebhook`), `shop_domain` store resolution, and idempotent dispatch to existing redaction methods (`customers/data_request`, `customers/redact`, `shop/redact`).

### Patch Changes

- [#77](https://github.com/asyncdotengineering/porulle/pull/77) [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce) Thanks [@octalpixel](https://github.com/octalpixel)! - Add verified channel webhooks, provider subscription registration, mirror convergence, guarded cross-boundary refund approval, and per-store catalog/inventory reconciliation with drift reporting.

- [#78](https://github.com/asyncdotengineering/porulle/pull/78) [`92284bb`](https://github.com/asyncdotengineering/porulle/commit/92284bb44b019ffb95e751a028e58d941ec26fb3) Thanks [@octalpixel](https://github.com/octalpixel)! - Fix Shopify webhook verification to use the app client secret. Shopify signs every webhook for an app with the app's client/API secret key, not a per-store secret — `verifyWebhook` now verifies against the configured `clientSecret` instead of `store.webhookSecret` (which never matched real Shopify deliveries), and requires `clientSecret` to be configured. WooCommerce keeps its per-webhook secret.

- Updated dependencies [[`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce), [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce), [`8f8c564`](https://github.com/asyncdotengineering/porulle/commit/8f8c564deb399a86c50d27d8ca07e5334888bf30), [`ff3d5e6`](https://github.com/asyncdotengineering/porulle/commit/ff3d5e6e876f090119fd025aa6b5499f0dccd9fb), [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce), [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce)]:
  - @porulle/core@0.10.0
