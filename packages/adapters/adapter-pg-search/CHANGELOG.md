# @porulle/adapter-pg-search

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

### Minor Changes

- [`3f1de20`](https://github.com/asyncdotengineering/porulle/commit/3f1de204f0ebb07f634fe702ddc8a6f1d6fd7f22) Thanks [@octalpixel](https://github.com/octalpixel)! - Let `pgSearchAdapter` use the configured database instead of requiring a second connection.

  `PgSearchAdapterOptions.query` was required, so every consumer hand-wired raw SQL execution — typically by opening a second pool against the database porulle was already connected to.

  `SearchAdapter` gains an optional `init?(deps: { db })` hook, called by the search module when it wires the adapter, and `pgSearchAdapter()` now takes no required argument:

  ```ts
  search: {
    adapter: pgSearchAdapter();
  }
  ```

  A supplied `query` callback still takes precedence and is never overwritten by `init`, so pointing search at a separate database remains possible. Adapters that do not define `init` — including the meilisearch adapter — are unaffected.

### Patch Changes

- Updated dependencies [[`3f1de20`](https://github.com/asyncdotengineering/porulle/commit/3f1de204f0ebb07f634fe702ddc8a6f1d6fd7f22), [`0583eab`](https://github.com/asyncdotengineering/porulle/commit/0583eab02f80869f3aba3fdc2ae847712cbd6959), [`f476b2c`](https://github.com/asyncdotengineering/porulle/commit/f476b2c2687dc4bed24de65a1ab1abdf08853066), [`32136d4`](https://github.com/asyncdotengineering/porulle/commit/32136d49df43995e167e1198d1b768976e1eb85f)]:
  - @porulle/core@0.14.0

## 0.13.0

### Patch Changes

- Updated dependencies [[`6cfb51d`](https://github.com/asyncdotengineering/porulle/commit/6cfb51debf27bb2f9bac26320d95414bf3443905), [`98e75bb`](https://github.com/asyncdotengineering/porulle/commit/98e75bb0222d9079589d97dca74de0f0dda4e12c), [`8c2c116`](https://github.com/asyncdotengineering/porulle/commit/8c2c1160acf87b981b3be8606918cde057fed833), [`4f9e5b9`](https://github.com/asyncdotengineering/porulle/commit/4f9e5b939b72849b943de6fe2d2751dac8d6caba), [`5ee7ae3`](https://github.com/asyncdotengineering/porulle/commit/5ee7ae3628acb29ea56738423c8cfe5e10d26182), [`0948324`](https://github.com/asyncdotengineering/porulle/commit/0948324c22f1468dfeb73707f6f77d182bc58494), [`54bf6cf`](https://github.com/asyncdotengineering/porulle/commit/54bf6cfcb5f45b46cecdd9a1568a104ae647817c), [`f36de3a`](https://github.com/asyncdotengineering/porulle/commit/f36de3a4524c67eb79badeeb2a33f3502c75bf18), [`cf611f9`](https://github.com/asyncdotengineering/porulle/commit/cf611f9f6b21a4dd3eaee7e3cab8c9f7d2faf431), [`7688ce2`](https://github.com/asyncdotengineering/porulle/commit/7688ce2eb4e1eea74a9ec0bfab90cdb74078bcc6), [`bc5c825`](https://github.com/asyncdotengineering/porulle/commit/bc5c825919d3f0cbbf4849cdefb72b61c430fb0d), [`d6f27f6`](https://github.com/asyncdotengineering/porulle/commit/d6f27f6b24cb0de70b77529f81d0677d0b235a5f)]:
  - @porulle/core@0.13.0

## 0.12.0

### Patch Changes

- Fix six defects reported by an adopter integrating the published packages.

  **Catalog read endpoints now require `catalog:read`.** An unauthenticated caller could read any catalog entity by id and receive the full record, including `organizationId` and including entities in `draft` with `isVisible: false` — cross-tenant disclosure of unpublished merchant data in the documented one-organization-per-merchant posture. Entity, category and brand reads are guarded, and entity-by-id lookups are organization-scoped so an authenticated caller cannot read another organization's record either. Storefronts are unaffected: an anonymous visitor resolved through `storeResolver` receives the customer permission set, which grants `catalog:read`. That coupling is now pinned by a test, since dropping `catalog:read` from the customer defaults would silently 401 every public storefront.

  **Password sign-up failed on a fresh install.** better-auth 1.7 writes an `issuer` column to `account` that porulle's schema did not declare, so its Drizzle adapter built an INSERT against a column the migration did not know about. The column and its migration are added, the better-auth dependencies are aligned to the range actually installed, and a parity guard derived from better-auth's own `getAuthTables()` — not a hand-maintained field list — now fails the build if the declared schema drifts from what better-auth writes.

  **Seven packages published an entry point that did not exist.** `@porulle/adapter-meilisearch`, `@porulle/adapter-pg-search`, `@porulle/adapter-r2`, `@porulle/adapter-s3`, `@porulle/import-flat`, `@porulle/import-shopify` and `@porulle/import-woocommerce` declared `./dist/index.js` while their build emitted `dist/src/index.js`, so importing any of them threw. Each was missing `"rootDir": "src"` in its build config.

  **The CLI binary is now `porulle`**, matching every documented command; `unifiedcommerce` remains as an alias so existing invocations keep working.

  **`@porulle/adapter-local-storage` rejoins the release train**, so `@porulle/*` can be pinned to a single version. It had been excluded and left at 0.10.7 while the family moved on — which also broke `porulle init`, since the scaffolded project pins every `@porulle/*` dependency to the CLI's own version and the starter template imports the local-storage adapter.

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
