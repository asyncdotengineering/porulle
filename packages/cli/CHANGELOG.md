# @porulle/cli

## 0.10.4

## 0.10.3

## 0.10.2

## 0.10.1

## 0.10.0

## 0.9.0

## 0.8.0

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

### Minor Changes

- [#32](https://github.com/asyncdotengineering/porulle/pull/32) [`dcc4fe9`](https://github.com/asyncdotengineering/porulle/commit/dcc4fe98a476ae91d12a13495db20fe2e7d5dd2e) Thanks [@octalpixel](https://github.com/octalpixel)! - `init` now pins scaffolded `@porulle/*` dependencies to the version of the CLI that created the project. The packages ship as a fixed-version group, so the running CLI's own version is the correct, coherent target; previously the starter template carried a static range (`^0.5.0`) that went stale on every release and — under 0.x caret semantics — left freshly scaffolded projects a full minor behind the CLI.
