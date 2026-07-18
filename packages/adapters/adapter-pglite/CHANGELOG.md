# @porulle/adapter-pglite

## 0.10.0

### Minor Changes

- [#80](https://github.com/asyncdotengineering/porulle/pull/80) [`efaf9d7`](https://github.com/asyncdotengineering/porulle/commit/efaf9d764aee10afabd02c0c511dda008d65a926) Thanks [@octalpixel](https://github.com/octalpixel)! - Add `@porulle/adapter-pglite` — a zero-infrastructure `DatabaseAdapter` backed by PGlite (embedded WASM PostgreSQL). No database server, connection string, or migration step: construct it and the store runs. It pushes the core schema and seeds the default organization on init. Ideal for local dev, demos, tests, and CI; swap to `@porulle/adapter-postgres` for production (same `DatabaseAdapter` contract, same PostgreSQL).

### Patch Changes

- Updated dependencies [[`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce), [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce), [`8f8c564`](https://github.com/asyncdotengineering/porulle/commit/8f8c564deb399a86c50d27d8ca07e5334888bf30), [`ff3d5e6`](https://github.com/asyncdotengineering/porulle/commit/ff3d5e6e876f090119fd025aa6b5499f0dccd9fb), [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce), [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce)]:
  - @porulle/core@0.10.0
