# @porulle/adapter-pglite

## 0.10.2

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.10.2

## 0.10.1

### Patch Changes

- Push merged plugin schema on zero-migration boot.

  `buildSchema(config)` (the only merge of plugin `customSchemas`) had no callers,
  `pushSchema()` pushed core-only, and nothing pushed the merged schema at boot —
  so on a zero-migration (PGlite) boot no plugin's own tables were ever created and
  every plugin's routes 500'd with "relation … does not exist". Adapters now
  advertise `autoMigrate`; `createCommerce` pushes the merged core+plugin schema at
  boot when the adapter auto-migrates and plugins declared tables (guarded, so
  plugin-less stores and migration-managed Postgres are untouched). `pushSchema`
  gains an optional `config` to push the merged schema. This makes `@porulle`
  plugins (gift cards, loyalty, …) work on the zero-infra PGlite starter.

- Updated dependencies []:
  - @porulle/core@0.10.1

## 0.10.0

### Minor Changes

- [#80](https://github.com/asyncdotengineering/porulle/pull/80) [`efaf9d7`](https://github.com/asyncdotengineering/porulle/commit/efaf9d764aee10afabd02c0c511dda008d65a926) Thanks [@octalpixel](https://github.com/octalpixel)! - Add `@porulle/adapter-pglite` — a zero-infrastructure `DatabaseAdapter` backed by PGlite (embedded WASM PostgreSQL). No database server, connection string, or migration step: construct it and the store runs. It pushes the core schema and seeds the default organization on init. Ideal for local dev, demos, tests, and CI; swap to `@porulle/adapter-postgres` for production (same `DatabaseAdapter` contract, same PostgreSQL).

### Patch Changes

- Updated dependencies [[`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce), [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce), [`8f8c564`](https://github.com/asyncdotengineering/porulle/commit/8f8c564deb399a86c50d27d8ca07e5334888bf30), [`ff3d5e6`](https://github.com/asyncdotengineering/porulle/commit/ff3d5e6e876f090119fd025aa6b5499f0dccd9fb), [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce), [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce)]:
  - @porulle/core@0.10.0
