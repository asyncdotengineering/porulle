# @porulle/adapter-local-storage

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

### Minor Changes

- Resolve admin-panel API gaps ([#33](https://github.com/asyncdotengineering/porulle/issues/33)–[#38](https://github.com/asyncdotengineering/porulle/issues/38)):

  - **Pricing**: `setBasePrice` now upserts on the natural key instead of appending a duplicate row, and `?include=pricing` exposes `id` + `createdAt` so consumers can identify the authoritative price.
  - **CSRF**: the global `csrf()` guard is skipped for API-key / bearer (server-to-server) requests, and genuine origin rejections surface a distinguishable `CSRF_ORIGIN_REJECTED` code.
  - **Catalog media**: `?include=media` is now backed by a real media/entity link lookup (role, sortOrder, url) instead of always returning `[]`.
  - **Local storage adapter / starter**: the `/assets/*` `serveStatic` mount strips the `/assets` prefix so adapter-generated URLs resolve correctly.
  - **Orders**: new REST endpoints for draft/manual order creation (`POST /orders`), payment capture (`POST /orders/{id}/capture`), and refund (`POST /orders/{id}/refund`).
  - **Variants**: `/variants/generate` documents its request body and returns a `422` for a missing/invalid strategy instead of a `500`.

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.6.0
