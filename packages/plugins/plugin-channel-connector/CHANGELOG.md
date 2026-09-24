# @porulle/plugin-channel-connector

## 0.50.1

### Patch Changes

- [#139](https://github.com/asyncdotengineering/porulle/pull/139) [`6cee26c`](https://github.com/asyncdotengineering/porulle/commit/6cee26cf719a9f4af46d0e5025b61a1891fa8b7e) Thanks [@octalpixel](https://github.com/octalpixel)! - `channel/reconcile` counts a product as `converged` when an upstream change to only its price, tags, categories or brand is written. 0.50.0 counted `converged` from what was written, but price and taxonomy writes never raised a change flag, so those changes reported `converged: 0`.

  - Converge now reads a product's base prices once and writes only those that differ. An unchanged price no longer re-writes its row or fires `pricing.afterCreate` on every sync.
  - Category and brand links that already exist are not re-written; a link that is added counts as a change.

- Updated dependencies []:
  - @porulle/core@0.50.1

## 0.50.0

### Minor Changes

- [#138](https://github.com/asyncdotengineering/porulle/pull/138) [`269e445`](https://github.com/asyncdotengineering/porulle/commit/269e445300d6afe05039fd9d0d56eda7067f8816) Thanks [@octalpixel](https://github.com/octalpixel)! - Stop a reconcile over an unchanged catalogue from rewriting it, and let two stores in one organization sell the same handle.

  - `inventory.setAbsolute` to the quantity already on hand is a no-op: no movement row and no `inventory.afterAdjust` (the permission is still checked). One sim reconcile had re-announced 1,243 unchanged levels.
  - `channel/reconcile` counts `converged` from what it actually wrote, not from a changed sync hash, so `driftAlert` no longer fires on an unchanged catalogue. Reconcile and inventory sync compare negative remote stock as the zero it is stored as, so oversold variants are not re-levelled on every run.
  - Product slugs stay unique per organization (the storefront resolves `/:idOrSlug` org-wide). A handle another store already holds becomes `<handle>-<store domain label>`, falling back to `<handle>-<label>-<store id prefix>`. Once a slug is assigned it is kept on every later converge, so shared links don't break.
  - A duplicate SKU inside one store now fails only that item, with its error, instead of failing the page and causing a retry.
  - New: `channelCatalogItemSchema`, `channelCatalogVariantSchema`, `channelInventoryLevelSchema` (and the nested schemas) exported from `@porulle/core`. A compile-time check keeps them equal to the `ChannelCatalogItem` interfaces. Parse catalog items at a trust boundary (queue, R2, fixtures) with these rather than re-declaring a subset.

### Patch Changes

- Updated dependencies [[`269e445`](https://github.com/asyncdotengineering/porulle/commit/269e445300d6afe05039fd9d0d56eda7067f8816)]:
  - @porulle/core@0.50.0

## 0.49.0

### Minor Changes

- [`bd48f59`](https://github.com/asyncdotengineering/porulle/commit/bd48f595b827e64920bb7243c2310f31d1f2b97c) Thanks [@octalpixel](https://github.com/octalpixel)! - Add the catalog import fast path: a page of new products lands in one transaction.

  `catalog.importProducts(page, { sourceStoreId, errorPolicy }, actor)` is the importer
  path the editor path never was. Measured on the PGlite query log, one 12-variant
  product cost 564 statements through `create` + `createVariant` + `setAttributes` +
  taxonomy links, because every call re-read the entity, recorded a revision and wrote
  one row per statement. The fast path reads the page's taken slugs and shared
  vocabulary once (creating what is missing with `ON CONFLICT DO NOTHING`, so two
  consumers landing pages that share a brand both succeed), writes each item multi-row
  inside its own savepoint, records one revision per item and fires one
  `catalog.afterImport` hook per page — which the audit module records as one row.
  Twenty such products cost 262 statements, 13.1 per item. `errorPolicy` is Saleor's:
  `reject-failed-rows` (the default) isolates a bad item behind its savepoint and
  reports it by ref and code; `reject-everything` rolls the page back. It creates and
  never updates; a caller that finds an item already present routes it through the
  editor path.

  The channel connector gains the page-shaped half: `fetchCatalogPage` returns one
  connector page and writes nothing; `convergeCatalogPage` sends never-mapped items
  down the fast path, skips mapped-and-unchanged items for free, and routes changed or
  orphaned items through the existing converge. Only each new item's hero image is
  fetched, streamed under `HERO_IMAGE_BYTE_CAP` (1 MiB — a larger one is reported, not
  stored, and the product still lands), and linked at entity level as `primary` plus to
  the variants it shows; `selectImportImages` returns that hero and the first photo of
  each other variant, which come back as `deferredMedia` for the host to land later.

  `@porulle/core/testing` now exports `createPGliteTestAdapter`, whose query log is the
  only statement counter that sees what core issues.

### Patch Changes

- [`850382f`](https://github.com/asyncdotengineering/porulle/commit/850382f61970a6e31ecd0bb5a594fb84b46bf971) Thanks [@octalpixel](https://github.com/octalpixel)! - Stop the catalog import re-reading and re-writing what has not changed.

  Measured on a deployed Worker: ~379 I/O operations per product with at most one in
  flight at a time outside media. Three sources, all removable without changing what
  the import produces:

  - `applyTaxonomy` read the organization's whole categories, brands and tags tables
    once per PRODUCT. They are now read once per converge run and shared.
  - `upsertOptionAxes` read back every option type and option value it had just
    created, and issued an UPDATE for each one whether or not `displayName` or
    `sortOrder` had moved. The row is constructed from what was sent, and the update
    is conditional.
  - `upsertVariants` read `variant_option_values` once per variant, and wrote the
    variant's `syncHash` on every pass regardless of whether the variant changed.
    The read is one query for the whole entity; the write is conditional.

  A repeat sync of an unchanged product drops from 41 to 23 service-issued statements
  on the new `import-statement-budget` test's fixture, a ratio of 0.80 to 0.52.

- Updated dependencies [[`bd48f59`](https://github.com/asyncdotengineering/porulle/commit/bd48f595b827e64920bb7243c2310f31d1f2b97c)]:
  - @porulle/core@0.49.0

## 0.48.1

### Patch Changes

- [#137](https://github.com/asyncdotengineering/porulle/pull/137) [`fb7fce8`](https://github.com/asyncdotengineering/porulle/commit/fb7fce87f657318d23955a50c457c139a45109cb) Thanks [@octalpixel](https://github.com/octalpixel)! - Forward `entityIds` and `failures` from a bounded catalog batch into the step's return value.

  `convergeCatalogItems` has reported the entity ids a batch committed since 0.48.0, and the bounded
  `importCatalog` overload declares them — but `channel/import-catalog`'s own `runBatch` dropped both
  fields on the way out, so nothing downstream of the durable step could see them. `walkBatches` keeps
  only `last`, which makes the resolved value of each `step.do` the only per-batch seam a host
  application has: a host that wants to emit one message per converged page, instead of one enqueue
  per product, had nowhere to read the page from.

  `entityIds` is forwarded unconditionally, matching the service's own return. Omitting it when empty
  would make "this batch committed nothing" and "this build does not report entities" the same
  `undefined` at the seam, and a caller that collapses those enqueues nothing and reports success.

- Updated dependencies []:
  - @porulle/core@0.48.1

## 0.48.0

### Minor Changes

- [#136](https://github.com/asyncdotengineering/porulle/pull/136) [`c6b9827`](https://github.com/asyncdotengineering/porulle/commit/c6b9827b5619b22626d496d8f42409c6380a4e0d) Thanks [@octalpixel](https://github.com/octalpixel)! - Report the entity ids a catalog batch committed

  `convergeCatalogItems` reported how much it imported and what failed, but not _which_ entities it committed. A caller that wanted to act on the page it had just converged had no way to name it, so the only shape available was one enqueue per product — which is what put 1,303 nested Workflow instance creations behind a single sweep.

  `CatalogConvergenceStats` and the bounded import's outcome now carry `entityIds`: committed only, in input order, failures excluded, de-duplicated. `BatchOutcome` carries it alongside `failures`, and both stay JSON because they cross a durable step boundary.

  `entityIds` is returned **unconditionally**, while every sibling field on that outcome is conditional-on-non-empty. The asymmetry is deliberate: a caller must be able to tell "this batch committed nothing" from "this build does not report entities". Collapsing those two makes a caller enqueue nothing and report success.

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.48.0

## 0.47.0

### Patch Changes

- Updated dependencies [[`71ace6a`](https://github.com/asyncdotengineering/porulle/commit/71ace6a67d7dcae1602f2bbf6d91c97435a06ec8)]:
  - @porulle/core@0.47.0

## 0.46.0

### Minor Changes

- [#132](https://github.com/asyncdotengineering/porulle/pull/132) [`63d0562`](https://github.com/asyncdotengineering/porulle/commit/63d0562af8c12314509545a6c4379946b9629e6f) Thanks [@octalpixel](https://github.com/octalpixel)! - Isolate converge failures to the item that caused them.

  `convergeCatalogItems` returned `PluginErr` on the first item that failed. In `importCatalog` that return happens BEFORE the `connected_stores.catalogCursor` write, while every item already converged in the batch stays committed. The retry re-fetched the same page, re-converged the same prefix and failed on the same item again, so one malformed product halted the rest of a merchant's catalog at whatever position it sat in, permanently — no retry advanced past it.

  The four in-loop aborts and any unforeseen throw now record the item and continue. `consumed` was already incremented before the body, so a failed item still advances the offset and the walk moves on. Saleor calls this choice REJECT_FAILED_ROWS as against REJECT_EVERYTHING; this is the former.

  `CatalogConvergenceStats` gains a required `failures: CatalogConvergenceFailure[]`, and `importCatalog` returns `failures` on both paths when non-empty. Surfacing it is the point: recording a failure without returning it would turn a loud halt into a silent drop, which is worse than the behaviour it replaces. `CatalogConvergenceFailure { externalId, error }` is exported from the package entry and keys on the merchant's id, because a failed create leaves no entity to name.

  A dry run reports `failures: []`; it converges nothing, so it can fail nothing.

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

### Minor Changes

- [#129](https://github.com/asyncdotengineering/porulle/pull/129) [`d91e1bb`](https://github.com/asyncdotengineering/porulle/commit/d91e1bb7be0f69698e6fd6a6aacee2886891680b) Thanks [@octalpixel](https://github.com/octalpixel)! - Let a consumer confine which connected stores a read returns.

  `listStores` filtered on `organizationId` alone, so every caller saw every store in the
  organization. That is right for a single-tenant deployment and wrong for a marketplace, where one
  organization holds many sellers.

  `ChannelConnectorPluginOptions.confineStoreReads` takes a request context and returns the store ids
  the caller may read: `null` to decline to confine, which is the default and leaves existing
  behaviour untouched, or an array, where `[]` means none. The ids are applied in the WHERE clause
  rather than filtered out of the result, so no other caller of `listStores` is left unconfined and a
  change to the returned shape cannot silently break the confinement.

  It takes ids rather than a tenant on purpose: `vendor`, `seller` and `team` are models a consumer
  owns, and this package is generic commerce. The consumer resolves the meaning and hands back the
  answer.

  No status predicate was added or removed — `listStores` has never had one, and disconnected stores
  keep being returned.

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.43.0

## 0.42.0

### Patch Changes

- Updated dependencies [[`e9f1de6`](https://github.com/asyncdotengineering/porulle/commit/e9f1de6d18a35e706153c2e596799d35c00ffbc2)]:
  - @porulle/core@0.42.0

## 0.41.0

### Minor Changes

- [#127](https://github.com/asyncdotengineering/porulle/pull/127) [`7f3dacc`](https://github.com/asyncdotengineering/porulle/commit/7f3daccf2c40ce2425ae34badff43086cec4df66) Thanks [@octalpixel](https://github.com/octalpixel)! - Close five defects found by auditing what core declares against what it does

  **`assertOwnership` refuses a credential-less caller 401 instead of 403.** It was the last guard in `auth/permissions.ts` not given `isUnauthenticatedActor`, and its no-actor branch threw a 403 whose own message read "Authentication required." An API-key actor still gets 403 — it presented a credential — and a blank-string identity still gets 403, both by construction of the predicate rather than by special-casing. Behaviour change for any caller reaching ownership checks without a session.

  **A list route's declared pagination shape now matches the one it serves.** `paginatedResponse` declared `meta: { page, limit, total? }` while `GET /api/orders` and `GET /api/catalog/entities` served `meta: { pagination: { page, limit, total, totalPages } }`. The OpenAPI document, and therefore every generated SDK type, described a `meta.total` the server never sent — a consumer reading it got `undefined` with no type error and no test failure, because every list handler sits under a `@ts-expect-error`. The schema moved to match the wire, not the reverse; `meta.pagination` was already the house shape in the customer schemas. The customer-portal orders route, whose two return paths disagreed with each other, now serves the nested shape on both.

  **`PriceResolutionContext` no longer accepts a `customerId` it discards.** The resolver's only customer-dimension matching reads `customerGroupIds`; nothing ever derived groups from the id, so a caller passing the obvious field got list price while believing otherwise. The field is removed rather than wired up because `customer_group_members` has no writer — `addToGroup`, `removeFromGroup` and `findGroupsByCustomerId` exist on the repository and are called by nothing — so resolving from it would have added a database round trip to a money path to answer a guaranteed miss. Callers now derive the parameter type from the service instead of restating it, so the removal cannot silently drift back. Group-scoped pricing through an explicit `customerGroupIds` is unchanged.

  **`sendOrderStatusEmail` is deleted.** It had never sent an email: it declared its own result shape while `changeStatus` passed the hydrated order, so `result.newStatus` was always `undefined` and the hook returned early on every call since it was written. It was unexported and its behaviour was empty, so nothing can regress. The `orders.afterStatusChange` seam and its other subscribers are untouched.

  **A store whose connector is unregistered no longer answers a silent success.** `executeCatalogPushJob` returned `Ok({ noop: true })` both for a registered connector that cannot push a catalog and for a provider not registered at all — a store pointing at nothing, which is what a removed or renamed connector leaves behind. The absent case now returns a named error in the same words the rest of the service uses. A registered-but-push-less connector stays a no-op, and a store with catalog writes deliberately disabled stays a no-op whether or not a connector is registered.

  Also: the headline checkout suite no longer passes on failure. `api-checkout.test.ts` asserted `expect([201, 422, 500]).toContain(response.status)` in four cases, so a created order, a validation failure and an internal error were all green in the suite covering the framework's most important route. Each case now asserts one status and the shape behind it.

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

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.39.0

## 0.38.0

### Minor Changes

- [#123](https://github.com/asyncdotengineering/porulle/pull/123) [`26b2da1`](https://github.com/asyncdotengineering/porulle/commit/26b2da16f4fe03a28566d91d6ca7aa4f46fea3c5) Thanks [@octalpixel](https://github.com/octalpixel)! - Import a product's images concurrently, within the Worker's connection budget, and stop loading the whole organization's media for every product.

  `applyMedia` downloaded and re-uploaded a product's images one at a time inside a loop that was itself serial — two external round trips per image, carrying the whole payload. Measured on a deployed Worker, an import cost ~9.24 s per product and the image phase was about three quarters of it, across 448 images in a 100-product catalog.

  The images of a product are independent of each other, so they now resolve with a bounded concurrency of three. The bound is not a preference: a Cloudflare Worker may hold at most six simultaneous outbound connections per invocation and one image costs two of them, so a fourth would queue behind the platform limit rather than go faster. Two images of the same product that resolve to the same asset share one upload — and, deliberately, not its tally, so `mediaImported` still counts one stored object once.

  The per-product `media_assets` lookup loaded every asset the organization owned, which is O(n²) in catalog size and grows exactly where the thousand- and five-thousand-product cases live. It is now one query narrowed to that product's own channel image identifiers, with matching expression indexes on `media_assets` for `(organization_id, metadata->>'channelImageUrlHash')` and `(organization_id, metadata->>'channelImageExternalId')`.

### Patch Changes

- Updated dependencies [[`26b2da1`](https://github.com/asyncdotengineering/porulle/commit/26b2da16f4fe03a28566d91d6ca7aa4f46fea3c5)]:
  - @porulle/core@0.38.0

## 0.37.0

### Minor Changes

- [#122](https://github.com/asyncdotengineering/porulle/pull/122) [`f28bef1`](https://github.com/asyncdotengineering/porulle/commit/f28bef11a0ae73b1011aa29f7772d2c8fa6b05cd) Thanks [@octalpixel](https://github.com/octalpixel)! - `channel_catalog_conflicts.entity_id` and `channel_catalog_pushes.entity_id` cascade on delete.

  Both name a `sellable_entities.id` and neither was tied to it, so deleting an entity left rows
  behind — and each sits under a unique index that the dangling row then holds against that entity
  being recreated: `channel_catalog_conflicts_open_unique` on `(store_id, entity_id, field_path)
WHERE state = 'open'`, and `channel_catalog_pushes_store_entity_unique` on `(store_id, entity_id)`.
  That is the same defect that made an interrupted import unrecoverable through `channel_entity_map`,
  fixed in 0.28.0, sitting in two tables nobody had yet deleted an entity out of.

  Consumers that manage their own migrations need the two `ALTER TABLE ... ADD CONSTRAINT ... ON
DELETE cascade` statements; the constraint names follow drizzle's convention,
  `channel_catalog_conflicts_entity_id_sellable_entities_id_fk` and
  `channel_catalog_pushes_entity_id_sellable_entities_id_fk`.

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

### Minor Changes

- [#115](https://github.com/asyncdotengineering/porulle/pull/115) [`75e635f`](https://github.com/asyncdotengineering/porulle/commit/75e635fbba971358b3934de8a4d5964e96a6a349) Thanks [@octalpixel](https://github.com/octalpixel)! - Walk a batched sweep's batches inside one job instance instead of chaining a successor per batch.

  `channel/import-catalog` and `channel/sync-inventory` each created their own
  successor by enqueueing from inside the running instance. On Cloudflare that
  spends one of a request chain's **32 Worker invocations** per batch, and they
  never come back, so a chain of any length dies part-way through with
  `Subrequest depth limit exceeded` — at the coordinator call, before the handler
  runs, which is why the cursor survives and the catalog merely looks incomplete.

  Both tasks are now `durableSteps` handlers that walk their batches to
  exhaustion as successive top-level steps of one instance. A step spends no
  chain depth, so the walk is flat however many batches it takes. The per-batch
  bound, the cursor format and the resume behaviour are unchanged — only the
  wrapper moved.

  Each step's name carries its batch index. The engine keys a step by name and
  replays a repeat, so a loop that reuses one name finishes instantly and writes
  a single batch.

  The import still hands off to inventory exactly once when the catalog is whole:
  one enqueue of a _different_ task, costing a single level rather than one per
  page.

  `CHANNEL_MAX_BATCHES_PER_SWEEP` turns a cursor that stops advancing into a
  refusal that names the store, rather than a loop that runs until the step
  budget is gone.

  **Consumers on Cloudflare should size `limits.subrequests` for a whole
  catalog.** The subrequest limit is counted per Workflow _instance_, not per
  step, and chaining used to refresh it each time; one instance now carries the
  whole sweep.

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

### Minor Changes

- [#112](https://github.com/asyncdotengineering/porulle/pull/112) [`d05152a`](https://github.com/asyncdotengineering/porulle/commit/d05152a635b1d25f59610c6da62615722b52526f) Thanks [@octalpixel](https://github.com/octalpixel)! - Finish a store's inventory sync, and stop creating a Workflow instance per enqueue

  Three changes, one finding: work that scaled with inventory LEVELS where it should have scaled
  with PRODUCTS.

  Measured on a deployed Worker on 2026-09-14, one operator sweep of a 100-product store:
  `channel/sync-inventory` was killed by `WorkflowTimeoutError: Execution timed out after 600000ms`
  having written **232 of ~1,299 levels**, leaving **23 of 104 products** with any stock at all. The
  600,000 ms is Cloudflare's documented default `WorkflowStepConfig.timeout` of ten minutes, per
  attempt — nothing in this repository sets it. Raising it is not the fix: a 1,000-product merchant is
  roughly 13,000 levels, which at the measured 2.6 s each is about nine hours in a single attempt that
  discards everything if it fails.

  **`syncInventory` is bounded and resumable**, the way `importCatalog` already was. It processes at
  most `CHANNEL_INVENTORY_MAX_ITEMS_PER_INVOCATION` levels from a resume position persisted on
  `connected_stores.inventory_cursor`, returns `{ synced, exhausted }`, and the task enqueues its own
  continuation until the store is drained. The bound counts levels **walked**, never work done: a sync
  where nothing has changed does no work at all, and a bound on work would not bound it. Because the
  cursor now holds a position, the last-sync time moved to `connected_stores.lastSyncAt`; a cursor
  written by an earlier release is read as "start from the beginning".

  **A superseding enqueue coalesces before a Workflow instance exists.** Previously every enqueue
  created an instance and the supersede terminated the one before it, so N enqueues on one key meant N
  instances, N coordinator round trips and N−1 terminations to run one job — **1,303 instances to run
  at most 104 jobs** in the sweep above. An enqueue whose key already has a pending, not-yet-started
  instance with an identical input now reuses it. A differing input still terminates and replaces, so
  supersede stays latest-wins; an instance that has already started is never coalesced into, because
  it has read its input.

  **The concurrency gate no longer holds network I/O.** `release` looped `workflow.get` and
  `sendEvent` inside `blockConcurrencyWhile`, and `acquire`'s stale-holder check made a binding call
  under it too — so `porulle-turn:acquire` was observed held for 33 seconds and the Durable Object was
  reset with "A call to blockConcurrencyWhile() waited for too long". `release` now computes the next
  holder inside the gate and wakes outside it, and `acquire` reads state inside, asks about staleness
  outside, then re-enters and decides against the state as it is then. That re-read is what keeps two
  concurrent acquirers finding a dead holder from both being granted.

  Coordinator state written by an earlier release is read without a migration: `pendingHashes` is
  backfilled on read, so an object does not crash on its own history.

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.31.0

## 0.30.0

### Minor Changes

- [#111](https://github.com/asyncdotengineering/porulle/pull/111) [`7a9c0a8`](https://github.com/asyncdotengineering/porulle/commit/7a9c0a8adb9484825787d35b053e6cd3f8add486) Thanks [@octalpixel](https://github.com/octalpixel)! - An import sweep now levels inventory for the store it just finished importing.

  `channel/import-catalog` chains itself while the catalog is not exhausted and, when it is,
  returned — and nothing after it wrote `inventory_levels`. The only writers are `reconcile` and
  `syncInventory`, and `reconcile` was reachable only through the hourly `channel/reconcile-sweep`
  cron. A deployment that removes its crons therefore loses a data-plane write silently: every
  product imported afterwards arrives with no inventory row, rolls up as out of stock, and is
  published that way, with every suite still green.

  Measured on the deployment that hit it: 104 entities, 1303 variants, 273 inventory rows, and only
  25 of 104 entities carrying any inventory row at all — all-or-nothing per product, because the 25
  are what the sweep wrote before it stopped running.

  The exhausted branch now enqueues `channel/sync-inventory` for the same store, inside the same
  continuation chain, so "import this store" remains one operator action and leaves a catalog someone
  can buy from. A batch that is still mid-catalog does not reach for inventory; levels are set once,
  after the catalog is whole.

  Worth naming because it is the reusable lesson rather than the fix: the chain was rewritten in
  [#110](https://github.com/asyncdotengineering/porulle/issues/110) ("Finish a catalog in one import sweep instead of thirty products of it") _after_ the sweep
  that carried inventory was already dead. A chain gets rewritten and the thing that used to run
  beside it is in nobody's head.

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.30.0

## 0.29.0

### Minor Changes

- Finish a catalog in one import sweep instead of roughly thirty products of it.

  `channel/import-catalog` imported about thirty products and then died: on a
  Cloudflare Worker every query on the job path is its own HTTPS subrequest —
  roughly 320 per imported product — so an unbounded import exhausts the
  per-invocation subrequest cap and fails on whichever query comes next.

  `importCatalog` now takes `options: { maxItems }` and reports `exhausted`. It is
  overloaded, so the unbounded signature is unchanged and carries no `exhausted`,
  and every existing caller is untouched. The resume position is carried in
  `connectedStores.catalogCursor` as `{ pageCursor, offset }`, because a connector
  may return a whole catalog in one page and a cursor that can only name a page
  cannot resume inside one; a legacy bare cursor still parses. Resumption skips in
  memory before anything is converged, so a batch's cost does not grow with the
  catalog behind it. The task enqueues its own continuation until the catalog is
  exhausted, and a bounded invocation succeeds rather than erroring, so a real
  failure stays distinguishable from normal progress.

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.29.0

## 0.28.0

### Minor Changes

- [#109](https://github.com/asyncdotengineering/porulle/pull/109) [`94eaa29`](https://github.com/asyncdotengineering/porulle/commit/94eaa29d73a136c4118d2c89c968d3595646b548) Thanks [@octalpixel](https://github.com/octalpixel)! - Tie `channel_entity_map`'s identity to the entity it names.

  `channel_entity_map` was the importer's only record of identity and nothing connected it to the
  `sellable_entities` row it pointed at, which made an interrupted catalog import unrecoverable:

  - `entity_id` now carries a foreign key to `sellable_entities` with `ON DELETE CASCADE`. Deleting an
    entity previously left its `kind='variant'` map rows dangling, and because those rows hold the
    unique `(store_id, kind, external_id)` slot, the product could never be imported again — so the
    obvious operator repair made the situation permanently worse.
  - A new entity and its `kind='entity'` map row are now written in one transaction, through
    `catalog.create`'s transaction context. The map row is inserted with a sentinel `sync_hash` that
    no real hash can equal, so an import interrupted mid-item re-converges on the next run instead of
    being skipped as unchanged.
  - The identity check reads the map row and the entity together and resolves divergence in both
    directions: a mapping whose entity is gone is cleared rather than skipped for ever, and an entity
    on this store with the item's slug and no mapping is adopted rather than colliding. Previously
    that collision returned an error from `convergeCatalogItems`, aborting the entire import run
    rather than one item.

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

- [`d6f27f6`](https://github.com/asyncdotengineering/porulle/commit/d6f27f6b24cb0de70b77529f81d0677d0b235a5f) Thanks [@octalpixel](https://github.com/octalpixel)! - **Breaking:** `resolveOrgId` no longer consults the boot-time `auth.defaultOrganizationId` before strict resolution. An actor-less call with strict org resolution enabled now throws `OrgResolutionError` where it previously resolved to the configured default organization.

  Explicit `defaultOrgId` arguments and actor `organizationId` are unchanged. Set `auth.strictOrgResolution: false` or `STRICT_ORG_RESOLUTION=false` to restore the previous behaviour where the boot default answers actor-less calls.

  `resolveOrgIdForCommerce(actor, config)` is the sanctioned migration path for callers that hold `CommerceConfig`. Hand-built `HookContext` values should thread `commerceConfig`; without it, an orgless actor throws under strict resolution.

  Published plugin packages now use the same config-aware organization resolution, including checkout hooks and plugin routes, so upgrading core and these plugins together preserves actor-less requests on deployments that declare a default organization.

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

- [#77](https://github.com/asyncdotengineering/porulle/pull/77) [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce) Thanks [@octalpixel](https://github.com/octalpixel)! - Add verified channel webhooks, provider subscription registration, mirror convergence, guarded cross-boundary refund approval, and per-store catalog/inventory reconciliation with drift reporting.

- [#77](https://github.com/asyncdotengineering/porulle/pull/77) [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce) Thanks [@octalpixel](https://github.com/octalpixel)! - Add Shopify and WooCommerce catalog synchronization plus paid order injection with transparent customer shipping details, remote status confirmation, and tiered failed-export handling.

- [#77](https://github.com/asyncdotengineering/porulle/pull/77) [`8f8c564`](https://github.com/asyncdotengineering/porulle/commit/8f8c564deb399a86c50d27d8ca07e5334888bf30) Thanks [@octalpixel](https://github.com/octalpixel)! - Add generic one-click store onboarding: Shopify OAuth and WooCommerce `/wc-auth` endpoint flows via new engine-plugin routes (`/api/channels/oauth/{provider}/start` + `/callback`), signed single-use callback state, and connector `buildAuthUrl`/`completeAuth` methods — alongside the existing credential-paste path. Add Shopify mandatory GDPR compliance webhook ingress: `POST /api/channels/compliance/{provider}` unauthenticated route, app-secret HMAC verification (`verifyAppWebhook`), `shop_domain` store resolution, and idempotent dispatch to existing redaction methods (`customers/data_request`, `customers/redact`, `shop/redact`).

- [#77](https://github.com/asyncdotengineering/porulle/pull/77) [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce) Thanks [@octalpixel](https://github.com/octalpixel)! - Add externally sourced catalog provenance, store-scoped SKU uniqueness, the core channel connector contract, and the standalone channel connector engine plugin, including mandatory pre-payment live stock validation for channel checkout lines.

### Patch Changes

- [#78](https://github.com/asyncdotengineering/porulle/pull/78) [`bcd6751`](https://github.com/asyncdotengineering/porulle/commit/bcd6751050133d3546d303f4f9a6b95ad716530a) Thanks [@octalpixel](https://github.com/octalpixel)! - Fan out Shopify compliance redaction across every connected store that shares a `shop_domain`. `customers/redact` / `shop/redact` / `customers/data_request` now resolve all matching stores (via `getStoresByDomain`) and apply to each, so PII is erased on every copy rather than only the first match.

- Updated dependencies [[`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce), [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce), [`8f8c564`](https://github.com/asyncdotengineering/porulle/commit/8f8c564deb399a86c50d27d8ca07e5334888bf30), [`ff3d5e6`](https://github.com/asyncdotengineering/porulle/commit/ff3d5e6e876f090119fd025aa6b5499f0dccd9fb), [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce), [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce)]:
  - @porulle/core@0.10.0
