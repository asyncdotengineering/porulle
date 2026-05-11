# RFC-060: Remove Hardcoded org_default

## Problem

`DEFAULT_ORG_ID = "org_default"` is a hardcoded constant used as a silent fallback across 258 locations in the codebase. This causes three problems:

1. **Silent misconfiguration.** If a multi-store `storeResolver` fails or returns `null`, requests silently scope to `org_default` instead of erroring. Data lands in the wrong store.

2. **Not Better Auth native.** Better Auth's organization plugin expects orgs to be created via `auth.api.createOrganization()` — a proper API call that creates the org, adds the creator as owner, and sets `activeOrganizationId` on the session. UC bypasses this by inserting a raw row at boot via `ensureDefaultOrg()`.

3. **Hardcoded identity.** The string `"org_default"` is scattered across services, middleware, tests, and seed scripts. It's not configurable and can't be changed per deployment.

## How other projects handle this

| Project | Pattern |
|---------|---------|
| **Autumn** | On first login, checks for pending invites. If none, creates a personal org via `auth.api.createOrganization()` |
| **Deco CMS** | `databaseHooks.user.create.after` — auto-creates a personal org on signup (configurable via `autoCreateOrganizationOnSignup`) |
| **Superset** | Seed script creates initial org via `auth.api.createOrganization()`. Subsequent users join via invite |
| **Shopmon** | Seed script creates org via `auth.api.createOrganization()` in `apply-fixtures.ts` |

All of them use `auth.api.createOrganization()` — none hardcode an org ID constant.

## Proposed design

### New config option: `defaultOrganizationId`

```ts
export default defineConfig({
  auth: {
    // Explicit org ID for single-store deployments.
    // Created by the seed script via auth.api.createOrganization().
    // If not set and no storeResolver is configured, requests without
    // org context will fail with 422 instead of silently falling back.
    defaultOrganizationId: process.env.UC_ORG_ID,

    // For multi-store SaaS — resolves org from request context.
    // Takes precedence over defaultOrganizationId for customer requests.
    storeResolver: async (request) => {
      return request.headers.get("x-store-id") ?? null;
    },
  },
});
```

### Org creation moves to seed scripts

The seed script creates the org via Better Auth's native API. The org ID is stored in `.env` and passed to the config:

```ts
// scripts/seed.ts
const org = await commerce.auth.api.createOrganization({
  body: {
    name: "My Store",
    slug: "my-store",
    userId: adminUser.id,  // creator becomes owner
  },
});

console.log(`Org created: ${org.id}`);
// Write to .env: UC_ORG_ID=org_abc123...
```

### resolveOrgId becomes strict

```ts
// BEFORE: silent fallback
export function resolveOrgId(actor: unknown): string {
  if (actor?.organizationId) return actor.organizationId;
  return DEFAULT_ORG_ID;  // ← silent, dangerous
}

// AFTER: explicit or fail
export function resolveOrgId(actor: unknown, config?: { defaultOrganizationId?: string }): string {
  if (actor?.organizationId) return actor.organizationId;
  if (config?.defaultOrganizationId) return config.defaultOrganizationId;
  throw new CommerceValidationError(
    "No organization context. Set auth.defaultOrganizationId in config or configure auth.storeResolver."
  );
}
```

### Middleware resolution order

```
1. Actor has activeOrganizationId from Better Auth session → use it
2. Actor has org membership in a known org → use it
3. storeResolver returns an org ID from request → use it
4. config.auth.defaultOrganizationId is set → use it
5. None of the above → fail with 422 (not silent fallback)
```

### ensureDefaultOrg removed from boot

`createCommerce()` no longer calls `ensureDefaultOrg()`. Org creation is the developer's responsibility via:

- Seed script: `auth.api.createOrganization()`
- CLI: `bunx @unifiedcommerce/cli org create --name "My Store"`
- Admin API: `POST /api/auth/organization/create`

For backwards compatibility during migration, if `defaultOrganizationId` is not set and no `storeResolver` is configured, the engine logs a deprecation warning and falls back to `"org_default"` (creating it if needed). This fallback is removed in the next major version.

## Migration plan

### Phase 1: Add new config, keep fallback (non-breaking)

**Files changed: 5**

1. **`packages/core/src/config/types.ts`**
   - Add `defaultOrganizationId?: string` to `AuthConfig`

2. **`packages/core/src/auth/org.ts`**
   - `resolveOrgId()` accepts optional config parameter
   - If no org found and no config default: log deprecation warning, return `DEFAULT_ORG_ID`
   - Export `DEFAULT_ORG_ID` as deprecated

3. **`packages/core/src/auth/middleware.ts`**
   - Read `config.auth.defaultOrganizationId` before falling back to `DEFAULT_ORG_ID`
   - Pass config to `resolveOrgId()` calls

4. **`packages/core/src/runtime/commerce.ts`**
   - If `config.auth.defaultOrganizationId` is set, use it instead of calling `ensureDefaultOrg()`
   - If neither is set, call `ensureDefaultOrg()` with deprecation warning

5. **`packages/core/src/kernel/jobs/drizzle-adapter.ts`**
   - Use config default instead of `DEFAULT_ORG_ID`

### Phase 2: Update all service calls (non-breaking)

**Files changed: ~20**

Every `resolveOrgId(actor)` call in service files becomes `resolveOrgId(actor, this.deps.config)`:

- `packages/core/src/modules/catalog/service.ts` (14 calls)
- `packages/core/src/modules/orders/service.ts` (8 calls)
- `packages/core/src/modules/cart/service.ts` (10 calls)
- `packages/core/src/modules/customers/service.ts` (9 calls)
- `packages/core/src/modules/inventory/service.ts` (3 calls)
- `packages/core/src/modules/promotions/service.ts` (6 calls)
- `packages/core/src/modules/pricing/service.ts` (2 calls)
- `packages/core/src/modules/fulfillment/service.ts` (2 calls)
- `packages/core/src/modules/webhooks/service.ts` (1 call)
- `packages/core/src/modules/media/service.ts` (1 call)
- `packages/core/src/modules/audit/service.ts` (2 calls)
- `packages/core/src/modules/search/service.ts` (1 call)
- Plugin files with `resolveOrgId` (6 files)

### Phase 3: Update seed scripts and starters

**Files changed: ~15**

1. **Seed scripts** in `apps/*/src/scripts/seed.ts`:
   - Replace `ensureDefaultOrg()` with `auth.api.createOrganization()`
   - Write org ID to `.env`

2. **Starter configs** (`uc-store-starter`, `uc-admin-panel`):
   - Add `defaultOrganizationId: process.env.UC_ORG_ID` to auth config

3. **Test utilities** (`packages/core/src/test-utils/`):
   - `createTestConfig()` sets `defaultOrganizationId` to a generated test org ID
   - Test actors use the test org ID instead of hardcoded `"org_default"`

### Phase 4: Update plugin tests

**Files changed: ~15**

All plugin test-utils.ts files with hardcoded `organizationId: "org_default"`:
- Replace with `DEFAULT_TEST_ORG_ID` imported from test utilities
- Or derive from the test kernel's config

### Phase 5: Update docs

**Files changed: ~8**

- `explanation/identity-model.mdx` — update org resolution section
- `explanation/organizations.mdx` — update org_default references
- `guides/multi-tenancy.mdx` — update setup instructions
- `reference/configuration.mdx` — add `defaultOrganizationId` docs
- `guides/nextjs.mdx` — update seed instructions
- `guides/tanstack-start.mdx` — update seed instructions
- RFCs and security docs — update references

### Phase 6: Remove fallback (next major version)

**Files changed: 3**

1. `resolveOrgId()` throws instead of warning when no default is configured
2. `ensureDefaultOrg()` removed from exports
3. `DEFAULT_ORG_ID` constant removed

## Scope summary

| Phase | Files | Breaking? | Description |
|-------|-------|-----------|-------------|
| 1 | 5 | No | Add `defaultOrganizationId` config, deprecation warnings |
| 2 | ~20 | No | Pass config to all `resolveOrgId()` calls |
| 3 | ~15 | No | Update seed scripts to use `auth.api.createOrganization()` |
| 4 | ~15 | No | Update plugin test fixtures |
| 5 | ~8 | No | Update documentation |
| 6 | 3 | **Yes** | Remove `DEFAULT_ORG_ID` constant and `ensureDefaultOrg()` |
| **Total** | **~66** | Phase 6 only | |

## CLI addition

```bash
# Create an organization
bunx @unifiedcommerce/cli org create --name "My Store" --slug "my-store"

# Output:
# Organization created: org_abc123...
# Add to .env: UC_ORG_ID=org_abc123...
```

## Backwards compatibility

- Phases 1-5 are fully backwards compatible
- Existing deployments with `ensureDefaultOrg()` continue to work with deprecation warning
- Phase 6 is a major version bump (0.x → 1.0 or next minor with migration guide)
- The deprecation period gives teams time to update seed scripts

## Decision

- [ ] Approve RFC
- [ ] Start implementation (Phase 1-2 first, publish, then Phase 3-5)
