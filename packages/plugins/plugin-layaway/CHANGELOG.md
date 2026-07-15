# @porulle/plugin-layaway

## 0.9.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.9.0

## 0.8.0

### Minor Changes

- ae7c329: Order operations + retail tax + layaway from the ordereka field study (#56–#58). **Core:** order notes + activity timeline (#56) — `POST/GET/DELETE /api/orders/{id}/notes` (author, pinned-first ordering) and `GET /api/orders/{id}/timeline` merging status history, notes, and refund-ledger events (both directions) newest-first; new `order_notes` table. Product tax classes (#57) — `taxClass` is a first-class column on sellable entities and variants (variant overrides entity; writable on create/update), `/api/tax/classes` CRUD behind `tax:manage` (rateBps + `isDefault` for unclassed lines), and checkout computes per-line tax by class with cart-level discounts pro-rated across lines before tax; the order now stores per-line `taxAmount` (and `discountAmount`) from checkout. When an org defines classes they take precedence over region rates/adapter; new `tax_classes` table. **`@porulle/plugin-layaway`** (#58): partial-payment plans — create a plan from items (deposit % or amount, optional initial payment) which reserves stock while active; record installments in any tender; at full payment the plan completes automatically (core order created and cross-linked, stock hold released); forfeit releases the hold and runs the `onForfeit` policy hook. Consumers regenerate migrations (`order_notes`, `tax_classes`, `layaways`, `layaway_payments`, `sellable_entities.tax_class`, `variants.tax_class`).

### Patch Changes

- Updated dependencies [5c580c4]
- Updated dependencies [ae7c329]
- Updated dependencies [157221c]
- Updated dependencies [f40b3d1]
- Updated dependencies [230f405]
  - @porulle/core@0.8.0
