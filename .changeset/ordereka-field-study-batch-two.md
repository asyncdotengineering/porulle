---
"@porulle/adapter-neon": minor
"@porulle/sdk": minor
---

Two client/runtime gaps from the ordereka field study: **`@porulle/adapter-neon`** (#55) — a Workers-grade Neon `DatabaseAdapter` using the Neon HTTP driver for plain queries and a fresh WebSocket `Pool` per `transaction()` (ended after each call, so no isolate-shared-pool flake), Hyperdrive-aware via an optional binding, with `.execute()` normalized to the postgres-js row-array shape; and **`OfflineQueue` in `@porulle/sdk`** (#54) — an offline-first operation queue with pluggable persistence (`memoryStorage`/`webStorage`), automatic `idempotencyKey` stamping (pairs with core's order/checkout replay so a sale queued offline lands exactly once), FIFO drain on reconnect with exponential backoff, observable pending/failed state including server error bodies, and manual `retry`/`drop`.
