# @porulle/plugin-marketplace

## 0.13.0

### Patch Changes

- [`d56b71b`](https://github.com/asyncdotengineering/porulle/commit/d56b71b340d3b9a69cca0af7144953db6f635ba3) Thanks [@octalpixel](https://github.com/octalpixel)! - **Breaking:** `resolveOrgId` no longer consults the boot-time `auth.defaultOrganizationId` before strict resolution. An actor-less call with strict org resolution enabled now throws `OrgResolutionError` where it previously resolved to the configured default organization.

  Explicit `defaultOrgId` arguments and actor `organizationId` are unchanged. Set `auth.strictOrgResolution: false` or `STRICT_ORG_RESOLUTION=false` to restore the previous behaviour where the boot default answers actor-less calls.

  `resolveOrgIdForCommerce(actor, config)` is the sanctioned migration path for callers that hold `CommerceConfig`. Hand-built `HookContext` values should thread `commerceConfig`; without it, an orgless actor throws under strict resolution.

  Published plugin packages now use the same config-aware organization resolution, including checkout hooks and plugin routes, so upgrading core and these plugins together preserves actor-less requests on deployments that declare a default organization.

- Updated dependencies [[`9884856`](https://github.com/asyncdotengineering/porulle/commit/988485672556a94013f30f95c5534540dd2c48ca), [`27de203`](https://github.com/asyncdotengineering/porulle/commit/27de203251c4ddae251fafa28be80a8523e6f3ea), [`7a4f0a1`](https://github.com/asyncdotengineering/porulle/commit/7a4f0a1193805271b2c97a8268dc9e5916565d50), [`baa6bb3`](https://github.com/asyncdotengineering/porulle/commit/baa6bb3f229af6ecaa5603519daaa3a68037e767), [`7da1f88`](https://github.com/asyncdotengineering/porulle/commit/7da1f884127a42e06eb7e97e4c7d2f53a3160840), [`07c0b22`](https://github.com/asyncdotengineering/porulle/commit/07c0b22914079571a967a1f872929c22d5495d71), [`8b60de4`](https://github.com/asyncdotengineering/porulle/commit/8b60de4d9d123298c1bb959f2e490d9245a5db16), [`fb876e4`](https://github.com/asyncdotengineering/porulle/commit/fb876e411e9575980395523e1dc038fdddae9b77), [`88b8d18`](https://github.com/asyncdotengineering/porulle/commit/88b8d18feafd8175a10c1539981b61af87427156), [`14a6fb2`](https://github.com/asyncdotengineering/porulle/commit/14a6fb2125b7c0592d760e99b890815b27545214), [`8f4ecc3`](https://github.com/asyncdotengineering/porulle/commit/8f4ecc313e3ca30112c45d75df65fa2e1edb08ca), [`d56b71b`](https://github.com/asyncdotengineering/porulle/commit/d56b71b340d3b9a69cca0af7144953db6f635ba3)]:
  - @porulle/core@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.11.0

## 0.10.8

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.10.8

## 0.10.6

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.10.6

## 0.10.5

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.10.5

## 0.10.4

### Patch Changes

- Updated dependencies [[`26a5a72`](https://github.com/asyncdotengineering/porulle/commit/26a5a722ae2e2a94d284e71f8e824ab2c985cce0)]:
  - @porulle/core@0.10.4

## 0.10.3

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.10.3

## 0.10.2

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.10.2

## 0.10.1

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.10.1

## 0.10.0

### Patch Changes

- Updated dependencies [[`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce), [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce), [`8f8c564`](https://github.com/asyncdotengineering/porulle/commit/8f8c564deb399a86c50d27d8ca07e5334888bf30), [`ff3d5e6`](https://github.com/asyncdotengineering/porulle/commit/ff3d5e6e876f090119fd025aa6b5499f0dccd9fb), [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce), [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce)]:
  - @porulle/core@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [5c580c4]
- Updated dependencies [ae7c329]
- Updated dependencies [157221c]
- Updated dependencies [f40b3d1]
- Updated dependencies [230f405]
  - @porulle/core@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.6.0
