# MCP Removal Closed Report (Option A)

Date: 2026-05-10
Base commit at start: 092ece6

## Status
MCP removal implementation has been applied in the working tree, but the 7-commit chain could not be created in this environment because `.git` is not writable (`Operation not permitted` when creating `.git/index.lock`).

## Verification
- `bunx tsc --noEmit -p packages/core/tsconfig.json`: PASS
- `cd packages/core && bunx vitest run`: 384 passed, 1 skipped, 3 failed
  - Failing tests are pre-existing webhook DNS/network resolution tests:
    - `packages/core/test/webhooks.test.ts` (2 failures)
    - `packages/core/test/webhooks-single-retry.test.ts` (1 failure)

## Adopter Impact
Framework no longer ships MCP handlers/tools in core/plugin manifests; adopters should integrate any MCP layer externally against the REST API.

## Commit SHAs
Not available from this session because commits could not be created due to `.git` write restriction in the execution sandbox.
