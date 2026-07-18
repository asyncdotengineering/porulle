---
"@porulle/adapter-pglite": minor
---

Add `@porulle/adapter-pglite` — a zero-infrastructure `DatabaseAdapter` backed by PGlite (embedded WASM PostgreSQL). No database server, connection string, or migration step: construct it and the store runs. It pushes the core schema and seeds the default organization on init. Ideal for local dev, demos, tests, and CI; swap to `@porulle/adapter-postgres` for production (same `DatabaseAdapter` contract, same PostgreSQL).
