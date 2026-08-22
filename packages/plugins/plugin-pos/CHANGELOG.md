# @porulle/plugin-pos

## 0.13.0

### Minor Changes

- [`eee722a`](https://github.com/asyncdotengineering/porulle/commit/eee722a82aa87d73d03db6c7786656c3960978d7) Thanks [@octalpixel](https://github.com/octalpixel)! - **Breaking:** `POST /api/pos/returns` now requires a `payment` object in the request body. The refund ledger move and the first payout are recorded atomically in one transaction — abandoning between ledger and cash drawer is no longer possible. Split tender remains supported via `POST /api/pos/returns/{id}/payments`.

### Patch Changes

- Updated dependencies [[`9884856`](https://github.com/asyncdotengineering/porulle/commit/988485672556a94013f30f95c5534540dd2c48ca), [`27de203`](https://github.com/asyncdotengineering/porulle/commit/27de203251c4ddae251fafa28be80a8523e6f3ea), [`7a4f0a1`](https://github.com/asyncdotengineering/porulle/commit/7a4f0a1193805271b2c97a8268dc9e5916565d50), [`baa6bb3`](https://github.com/asyncdotengineering/porulle/commit/baa6bb3f229af6ecaa5603519daaa3a68037e767), [`7da1f88`](https://github.com/asyncdotengineering/porulle/commit/7da1f884127a42e06eb7e97e4c7d2f53a3160840), [`07c0b22`](https://github.com/asyncdotengineering/porulle/commit/07c0b22914079571a967a1f872929c22d5495d71), [`8b60de4`](https://github.com/asyncdotengineering/porulle/commit/8b60de4d9d123298c1bb959f2e490d9245a5db16), [`fb876e4`](https://github.com/asyncdotengineering/porulle/commit/fb876e411e9575980395523e1dc038fdddae9b77), [`88b8d18`](https://github.com/asyncdotengineering/porulle/commit/88b8d18feafd8175a10c1539981b61af87427156), [`14a6fb2`](https://github.com/asyncdotengineering/porulle/commit/14a6fb2125b7c0592d760e99b890815b27545214), [`8f4ecc3`](https://github.com/asyncdotengineering/porulle/commit/8f4ecc313e3ca30112c45d75df65fa2e1edb08ca), [`d56b71b`](https://github.com/asyncdotengineering/porulle/commit/d56b71b340d3b9a69cca0af7144953db6f635ba3)]:
  - @porulle/core@0.13.0
  - @porulle/db@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.12.0
  - @porulle/db@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.11.0
  - @porulle/db@0.11.0

## 0.10.8

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.10.8
  - @porulle/db@0.10.8

## 0.10.6

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.10.6
  - @porulle/db@0.10.6

## 0.10.5

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.10.5
  - @porulle/db@0.10.5

## 0.10.4

### Patch Changes

- Updated dependencies [[`26a5a72`](https://github.com/asyncdotengineering/porulle/commit/26a5a722ae2e2a94d284e71f8e824ab2c985cce0)]:
  - @porulle/core@0.10.4
  - @porulle/db@0.10.4

## 0.10.3

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.10.3
  - @porulle/db@0.10.3

## 0.10.2

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.10.2
  - @porulle/db@0.10.2

## 0.10.1

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.10.1
  - @porulle/db@0.10.1

## 0.10.0

### Patch Changes

- Updated dependencies [[`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce), [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce), [`8f8c564`](https://github.com/asyncdotengineering/porulle/commit/8f8c564deb399a86c50d27d8ca07e5334888bf30), [`ff3d5e6`](https://github.com/asyncdotengineering/porulle/commit/ff3d5e6e876f090119fd025aa6b5499f0dccd9fb), [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce), [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce)]:
  - @porulle/core@0.10.0
  - @porulle/db@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.9.0
  - @porulle/db@0.9.0

## 0.8.0

### Minor Changes

- f40b3d1: POS-grade money movement from the ordereka field study (#51–#53). **Core (#52):** line-level refund primitives — first-class `refundedQuantity` on order line items enforced by `POST /api/orders/{id}/refunds` (per-line refundable quantity), an optional per-operator daily refund cap read from `settings.policies.refundDailyCap` (403 with the cap surfaced; `GET /api/orders/refunds/cap` reports usage), and an audited undo window (`POST .../refunds/{refundId}/undo`, `policies.refundUndoWindowMinutes`, default 15) backed by a new `order_refunds` ledger table. Plugins can now receive the Better Auth instance (`PluginContext.auth`), contribute named API-key scopes via the manifest (`apiKeyScopes`), and scope definitions accept `keyExpiration` bounds; `createPluginTestApp` wires a real auth instance + middleware. **plugin-pos:** PIN auth runtime (#51) — `PUT /pos/auth/pin` (PBKDF2 via Web Crypto, Workers-safe), `POST /pos/auth/pin-login` minting a short-lived per-shift Better Auth API key under the plugin-registered `pos` scope, and `POST /pos/auth/override` for manager-by-PIN approvals (new `pos_operator_pins` table); exchanges (#53) — `POST /pos/exchanges` runs the return refund and the replacement order in ONE database transaction, cross-links refund/original/replacement, settles even exchanges immediately and leaves uneven ones open for tender. Consumers regenerate migrations (`order_refunds`, `pos_operator_pins`, `order_line_items.refunded_quantity`).

### Patch Changes

- Updated dependencies [5c580c4]
- Updated dependencies [ae7c329]
- Updated dependencies [157221c]
- Updated dependencies [f40b3d1]
- Updated dependencies [230f405]
  - @porulle/core@0.8.0
  - @porulle/db@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.7.0
  - @porulle/db@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.6.0
  - @porulle/db@0.6.0
