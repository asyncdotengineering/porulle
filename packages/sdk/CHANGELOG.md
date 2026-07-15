# @porulle/sdk

## 0.9.0

## 0.8.0

### Minor Changes

- df61d25: Two client/runtime gaps from the ordereka field study: **`@porulle/adapter-neon`** (#55) — a Workers-grade Neon `DatabaseAdapter` using the Neon HTTP driver for plain queries and a fresh WebSocket `Pool` per `transaction()` (ended after each call, so no isolate-shared-pool flake), Hyperdrive-aware via an optional binding, with `.execute()` normalized to the postgres-js row-array shape; and **`OfflineQueue` in `@porulle/sdk`** (#54) — an offline-first operation queue with pluggable persistence (`memoryStorage`/`webStorage`), automatic `idempotencyKey` stamping (pairs with core's order/checkout replay so a sale queued offline lands exactly once), FIFO drain on reconnect with exponential backoff, observable pending/failed state including server error bodies, and manual `retry`/`drop`.

## 0.7.0

### Minor Changes

- Resolve admin-panel API gaps ([#33](https://github.com/asyncdotengineering/porulle/issues/33)–[#38](https://github.com/asyncdotengineering/porulle/issues/38)):

  - **Pricing**: `setBasePrice` now upserts on the natural key instead of appending a duplicate row, and `?include=pricing` exposes `id` + `createdAt` so consumers can identify the authoritative price.
  - **CSRF**: the global `csrf()` guard is skipped for API-key / bearer (server-to-server) requests, and genuine origin rejections surface a distinguishable `CSRF_ORIGIN_REJECTED` code.
  - **Catalog media**: `?include=media` is now backed by a real media/entity link lookup (role, sortOrder, url) instead of always returning `[]`.
  - **Local storage adapter / starter**: the `/assets/*` `serveStatic` mount strips the `/assets` prefix so adapter-generated URLs resolve correctly.
  - **Orders**: new REST endpoints for draft/manual order creation (`POST /orders`), payment capture (`POST /orders/{id}/capture`), and refund (`POST /orders/{id}/refund`).
  - **Variants**: `/variants/generate` documents its request body and returns a `422` for a missing/invalid strategy instead of a `500`.

## 0.6.0
