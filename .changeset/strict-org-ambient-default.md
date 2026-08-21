---
"@porulle/core": minor
"@porulle/plugin-giftcards": patch
"@porulle/plugin-channel-connector": patch
"@porulle/plugin-loyalty": patch
"@porulle/plugin-pos-restaurant": patch
"@porulle/plugin-appointments": patch
"@porulle/plugin-marketplace": patch
---

**Breaking:** `resolveOrgId` no longer consults the boot-time `auth.defaultOrganizationId` before strict resolution. An actor-less call with strict org resolution enabled now throws `OrgResolutionError` where it previously resolved to the configured default organization.

Explicit `defaultOrgId` arguments and actor `organizationId` are unchanged. Set `auth.strictOrgResolution: false` or `STRICT_ORG_RESOLUTION=false` to restore the previous behaviour where the boot default answers actor-less calls.

`resolveOrgIdForCommerce(actor, config)` is the sanctioned migration path for callers that hold `CommerceConfig`. Hand-built `HookContext` values should thread `commerceConfig`; without it, an orgless actor throws under strict resolution.

Published plugin packages now use the same config-aware organization resolution, including checkout hooks and plugin routes, so upgrading core and these plugins together preserves actor-less requests on deployments that declare a default organization.
