---
"@porulle/core": minor
---

Refuse to construct a server when no request could resolve an organization.

Strict organization resolution fails closed by default. A deployment configuring neither `auth.defaultOrganizationId` nor `auth.storeResolver` previously booted cleanly and then returned 503 `ORG_RESOLUTION_FAILED` on the first actor-less request — in production, on a path an operator may not exercise until a real visitor does.

`createServer` now refuses at construction, naming both remedies and the opt-out. An empty or whitespace-only `defaultOrganizationId` counts as absent, since that is what an unset environment variable produces.

**Breaking:** a deployment relying on the permissive fallback will now fail to start rather than fail per-request. Set `auth.defaultOrganizationId` for single-tenant, `auth.storeResolver` for multi-tenant, or `auth.strictOrgResolution: false` (or `STRICT_ORG_RESOLUTION=false`) to keep the previous behaviour during a migration.
