# RFC-050: API Key Scoping & Dev Key Removal

## Status: Draft

## Problem

UnifiedCommerce ships a hardcoded `enableDevKey` / `devKey` bypass in the auth middleware. When enabled, any request with `x-api-key: dev-staff-key` gets full admin access without going through Better Auth's API key validation. This is:

1. **A security risk** — the dev key grants `*:*` permissions. In marketplace deployments, a leaked dev key gives access to all vendor data, all customer data, all financial operations.
2. **Not how Better Auth works** — Better Auth already has a full API key plugin with permissions, rate limiting, prefixes, and multiple configurations. We're bypassing it instead of using it.
3. **Confusing** — the auth middleware tries Better Auth validation first (which fails for the dev key), then falls back to the dev key check. This logs `Failed to validate API key: Invalid API key` on every request, even though the request succeeds.
4. **Not production-portable** — the engine refuses to boot with `enableDevKey: true` in production. So developers must switch auth strategies when deploying, which means the dev experience and production experience are different.

## Goals

1. **Remove `enableDevKey` and `devKey`** from the engine entirely
2. **Use Better Auth's API key plugin** as the sole API key mechanism
3. **Define permission scopes in `commerce.config.ts`** as named presets (storefront, admin, pos-terminal, ai-agent)
4. **Add a CLI command** to generate real API keys for each scope
5. **Use session-based auth** (Better Auth's default) for admin portals and storefronts — not API keys
6. **Make the starter work out-of-the-box** with a seed-generated key, not a hardcoded bypass

## Design

### Auth Strategy Matrix

| Client | Auth Method | Why |
|--------|-----------|-----|
| Admin portal (web) | Session cookie | Human user, browser-based, supports 2FA, org switching |
| Storefront (web) | Session cookie | Customer login, cart persistence, order history |
| Mobile app | Bearer token (session) | Better Auth session token via `Authorization: Bearer` |
| Server-to-server | API key (`x-api-key`) | Webhooks, CI, microservices — no human session |
| AI agent (MCP) | API key (`x-api-key`) | Claude Code, Cursor — scoped to safe operations |
| POS terminal | API key (`x-api-key`) | Dedicated hardware, fixed scope |

### Permission Scope Presets

Defined in `commerce.config.ts` under `auth.apiKeyScopes`:

```ts
export default defineConfig({
  auth: {
    // Session-based roles (existing — unchanged)
    roles: {
      owner: { permissions: ["*:*"] },
      admin: { permissions: ["*:*"] },
      customer: { permissions: ["catalog:read", "cart:*", "orders:read:own"] },
    },

    // API key scope presets (NEW)
    apiKeyScopes: {
      storefront: {
        prefix: "uc_pub_",
        description: "Public storefront — read catalog, manage carts, create orders",
        permissions: {
          catalog: ["read"],
          cart: ["create", "read", "update"],
          orders: ["create", "read"],
          search: ["read"],
        },
        rateLimit: { maxRequests: 100, timeWindow: 60_000 },
      },
      admin: {
        prefix: "uc_adm_",
        description: "Full admin access — all operations",
        permissions: {
          "*": ["*"],
        },
        rateLimit: { maxRequests: 1000, timeWindow: 60_000 },
      },
      "pos-terminal": {
        prefix: "uc_pos_",
        description: "POS terminal — ring sales, manage shifts, process returns",
        permissions: {
          catalog: ["read"],
          cart: ["create", "read", "update"],
          orders: ["create", "read"],
          inventory: ["read"],
          pos: ["operate"],
        },
        rateLimit: { maxRequests: 500, timeWindow: 60_000 },
      },
      "ai-agent": {
        prefix: "uc_ai_",
        description: "AI agent — read catalog, check inventory, query analytics",
        permissions: {
          catalog: ["read", "create"],
          inventory: ["read", "adjust"],
          orders: ["read"],
          cart: ["create", "update"],
          analytics: ["read"],
          mcp: ["access"],
        },
        rateLimit: { maxRequests: 200, timeWindow: 60_000 },
      },
    },
  },
});
```

### Permission Format

Better Auth uses `Record<string, string[]>` for permissions:

```ts
// Better Auth format
{ catalog: ["read", "write"], orders: ["read"] }
```

UC currently uses flat strings: `"catalog:read"`, `"orders:read:own"`. The migration:

```ts
// Old (UC flat string)
"catalog:read"

// New (Better Auth structured)
{ catalog: ["read"] }

// Conversion: split on ":" — first segment is resource, rest are actions
```

The core's `assertPermission()` function will be updated to accept both formats during migration.

### CLI Command

```bash
# Generate a key for a predefined scope
bunx @unifiedcommerce/cli api-key create --scope storefront
# → Created storefront API key: uc_pub_a1b2c3d4...
# → Permissions: catalog:read, cart:*, orders:create/read, search:read
# → Rate limit: 100 req/min

bunx @unifiedcommerce/cli api-key create --scope admin
# → Created admin API key: uc_adm_x9y8z7...
# → Permissions: *:*
# → Rate limit: 1000 req/min

# List existing keys
bunx @unifiedcommerce/cli api-key list

# Revoke a key
bunx @unifiedcommerce/cli api-key revoke uc_pub_a1b2c3d4
```

The CLI:
1. Reads `commerce.config.ts` to find available scopes
2. Boots the engine in-process (same as the seed script)
3. Creates a user if none exists (or uses the admin user from seed)
4. Calls `auth.api.createApiKey()` with the scope's permissions, prefix, and rate limits
5. Prints the key — this is the only time the full key is visible

### Better Auth Configuration

The engine will configure Better Auth's API key plugin with multiple configurations — one per defined scope:

```ts
// In packages/core/src/auth/setup.ts
import { apiKey } from "@better-auth/api-key";

const apiKeyConfigs = Object.entries(config.auth.apiKeyScopes ?? {}).map(
  ([scopeId, scope]) => ({
    configId: scopeId,
    defaultPrefix: scope.prefix,
    rateLimit: scope.rateLimit
      ? {
          enabled: true,
          maxRequests: scope.rateLimit.maxRequests,
          timeWindow: scope.rateLimit.timeWindow,
        }
      : undefined,
  }),
);

export const auth = betterAuth({
  plugins: [
    apiKey(apiKeyConfigs),
    // ...other plugins
  ],
});
```

### Auth Middleware Changes

The current middleware flow:

```
Request → try Better Auth session → try Better Auth API key → try dev key bypass → 401
```

New flow:

```
Request → try Better Auth session → try Better Auth API key → 401
```

No dev key fallback. The `Failed to validate API key` error disappears because all API keys are real Better Auth keys.

When a request arrives with `x-api-key`:
1. Call `auth.api.verifyApiKey({ body: { key } })`
2. If `valid: true`, extract the permissions from the key
3. Map Better Auth permissions (`{ catalog: ["read"] }`) to UC actor permissions (`["catalog:read"]`)
4. Construct the actor with the key's permissions, userId, and organizationId

### Session Auth for Admin/Storefront

Better Auth sessions work automatically — no changes needed. The existing flow:

1. User signs in via `POST /api/auth/sign-in/email` (or social, passkey, etc.)
2. Better Auth sets a session cookie
3. Subsequent requests include the cookie
4. The auth middleware calls `auth.api.getSession({ headers })` and constructs the actor

For admin portals: the admin user signs in, gets a session, and the session carries the admin role with `*:*` permissions.

For storefronts: the customer signs in, gets a session, and the session carries the customer role.

For mobile apps: the session token is returned as a Bearer token (`Authorization: Bearer <token>`) instead of a cookie. Better Auth supports this natively.

### Seed Script Changes

The seed script will:
1. Create an admin user (email/password)
2. Generate a `storefront` API key and an `admin` API key
3. Print both keys
4. Save them to `.env.local`

```ts
// In seed script
const adminKey = await auth.api.createApiKey({
  body: {
    configId: "admin",
    userId: adminUser.id,
    name: "seed-admin-key",
  },
});

const storefrontKey = await auth.api.createApiKey({
  body: {
    configId: "storefront",
    userId: adminUser.id,
    name: "seed-storefront-key",
  },
});

console.log(`Admin API key:      ${adminKey.key}`);
console.log(`Storefront API key: ${storefrontKey.key}`);

// Write to .env.local
writeFileSync(".env.local", [
  `DATABASE_URL=postgres://localhost:5432/uc_store_starter`,
  `NEXT_PUBLIC_API_KEY=${storefrontKey.key}`,
  `UC_ADMIN_KEY=${adminKey.key}`,
].join("\n"));
```

### Starter Experience

```bash
bun install
bun run setup          # pushes schema, seeds data, generates keys
                       # → prints: Admin key: uc_adm_... / Storefront key: uc_pub_...
                       # → saved to .env.local
bun run dev            # starts — storefront key used automatically
```

No hardcoded keys. No dev bypass. The generated keys are real Better Auth keys with proper scoping.

## Migration

This is a clean break. No backward compatibility, no deprecation period.

1. `config.auth.enableDevKey` — removed. Engine throws if present.
2. `config.auth.devKey` — removed. Engine throws if present.
3. `x-api-key: dev-staff-key` — no longer works. 401 immediately.

All existing consumers must generate real keys via the CLI.

## Implementation Plan

1. Add `apiKeyScopes` to `CommerceConfig` type
2. Configure Better Auth API key plugin with multiple configs from scopes
3. Remove `enableDevKey`, `devKey`, and the dev key fallback from auth middleware entirely
4. Add CLI command `api-key create/list/revoke`
5. Update seed scripts to generate real keys
6. Update starter to use generated keys
7. Update docs, skill, and tests

## References

- Better Auth API Key plugin: https://www.better-auth.com/docs/plugins/api-key
- Better Auth API Key advanced (multiple configs): https://www.better-auth.com/docs/plugins/api-key/advanced
- Better Auth sessions: https://www.better-auth.com/docs/concepts/session-management
- Stripe API key model: publishable key (pk_) + secret key (sk_)
- Medusa API key model: publishable key + admin key + CLI-generated
