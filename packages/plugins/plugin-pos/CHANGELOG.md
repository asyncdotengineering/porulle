# @porulle/plugin-pos

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
