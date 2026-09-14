# @porulle/plugin-channel-connector

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
