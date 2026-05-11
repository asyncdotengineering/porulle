# Day 3a Critical/High Fixes — Completion Note

Date: 2026-05-10
Workspace HEAD: `c7b4906abded8e273f61cb71eea701d6865155db`

## Fixes Implemented

1. Pricing cross-tenant isolation (CRITICAL)
- Org-scoped pricing repo reads (`findPricesByEntityId`, `findModifiersByEntityId`, `findActiveModifiers`) with required `orgId`.
- Actor/org threading through pricing resolution/list paths and checkout hook pricing resolution.
- REST write-side guard for modifier creation: rejects `entityId` outside actor org.
- Regressions:
  - `packages/core/test/pricing-cross-tenant.test.ts`
  - `packages/core/test/api-pricing.test.ts` (cross-tenant modifier create rejection)

2. Media cross-tenant attach (HIGH)
- `/api/media/attach` now passes actor to service.
- `MediaService.attachToEntity(input, actor, ctx)` enforces org-scoped entity + asset lookup and returns NOT_FOUND on cross-tenant probes.
- `CatalogRepository.findEntityById` now supports optional `orgId` scoping parameter (backward-compatible default behavior for existing callers).
- Regression:
  - `packages/core/test/media-cross-tenant.test.ts`

## Verification

- Typecheck: `bunx tsc --noEmit -p packages/core/tsconfig.json` ✅
- Tests: `cd packages/core && bunx vitest run` ⚠️ `391 passed / 1 skipped / 3 failed`
  - Remaining failures are unchanged, pre-existing DNS-dependent webhook tests:
    - `test/webhooks.test.ts` (2)
    - `test/webhooks-single-retry.test.ts` (1)

## Commit Status Blocker

Unable to create required two commits in this environment due Git index lock write permission failure:

`fatal: Unable to create '.git/index.lock': Operation not permitted`

Planned commit subjects:
1. `sec(pricing): org-scope all read methods + write-side cross-tenant guard (Day 3a CRITICAL)`
2. `sec(media): require actor + org-scope attachToEntity (Day 3a HIGH)`
