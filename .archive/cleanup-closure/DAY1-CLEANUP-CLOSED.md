# Day 1 Cleanup Closure

## B2 — Inventory withTransaction extraction
- Added `withTransaction<T>(ctx, fn)` in `packages/core/src/modules/inventory/service.ts`.
- Refactored transaction wrapping in `reserve`, `release`, and `adjust` to use the helper while preserving `TxContext` behavior.
- Verification:
  - `bunx tsc --noEmit -p packages/core/tsconfig.json` passed.
  - `cd packages/core && bunx vitest run test/inventory-robustness.test.ts test/api-inventory.test.ts` passed.

## B3 — Catalog split into bounded sub-services
- Split catalog internals into:
  - `packages/core/src/modules/catalog/entity-service.ts`
  - `packages/core/src/modules/catalog/category-service.ts`
  - `packages/core/src/modules/catalog/brand-service.ts`
- Converted `packages/core/src/modules/catalog/service.ts` into a thin facade delegating to the three sub-services.
- Preserved public `CatalogService` method names/signatures and `kernel.services.catalog.*` surface.
- Verification:
  - `bunx tsc --noEmit -p packages/core/tsconfig.json` passed.
  - `cd packages/core && bunx vitest run test/api-catalog.test.ts test/catalog-inventory.test.ts` passed.

## Context
- A1/A2/A3/B1 were previously landed via claude-glm.
- This closure adds B2 + B3 only.
