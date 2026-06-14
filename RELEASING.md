# Releasing

How `@porulle/*` packages are versioned and published. This repo uses
**pnpm workspaces + [Changesets](https://github.com/changesets/changesets)**,
with all `@porulle/*` packages in a single **`fixed`** group (they always share
one version) and **`access: public`** (see `.changeset/config.json`).

## Package manager: pnpm

The repo is managed with **pnpm** (`packageManager` in `package.json`,
`pnpm-workspace.yaml`, `pnpm-lock.yaml`). Install with `pnpm install`.

Internal dependencies between `@porulle/*` packages use the **`workspace:*`
protocol** (e.g. `"@porulle/core": "workspace:*"`). This is the correct,
robust convention with pnpm because **`pnpm publish` rewrites `workspace:*` to
the depended-on package's *current* `package.json` version at publish time**
(`workspace:*` → `1.2.3`, `workspace:^` → `^1.2.3`). Verified: `pnpm pack` of a
package depending on `@porulle/core` (at 0.5.0) emits `"@porulle/core": "0.5.0"`
in the tarball — never the literal `workspace:*`, and never a stale version.

> Why not bun? `changeset publish` shells to `npm`, which does **not** strip
> `workspace:*` (it would publish the literal string — uninstallable, the #24
> bug). And `bun publish` strips from the **lockfile**, which isn't reliably
> re-synced after a bump, so it can publish a *stale* version. pnpm reads the
> live `package.json`, so neither failure mode exists. (Both were reproduced
> before migrating; see git history.)

### pnpm gotchas baked into config

- **`onlyBuiltDependencies`** (`pnpm-workspace.yaml`) — pnpm 10 blocks
  postinstall scripts by default; `esbuild` and `sharp` are allowlisted because
  they build native binaries (esbuild powers vitest/tsup/drizzle-kit).
- **All internal deps must be `workspace:*`, not `*`** — pnpm only links a
  workspace package when the spec is the workspace protocol; a bare `*` makes
  pnpm try to fetch the (private) package from npm and 404.
- **`overrides`** live under `pnpm-workspace.yaml` (`drizzle-orm`).

## The release flow

```bash
# 1. While developing, add a changeset per change (bump type + summary).
pnpm run changeset            # interactive; commit the generated .changeset/*.md

# 2. Cut the version. Bumps every @porulle/* (fixed group) to one version,
#    updates each CHANGELOG, bumps workspace: ranges, re-syncs the lockfile.
pnpm run version-packages     # = changeset version && pnpm install --lockfile-only
#    Review + commit the result (a "Version Packages" commit/PR).

# 3. Publish. Builds ALL publishable packages (nested adapters/plugins/import
#    included — note the `./packages/**` filter), publishes via pnpm (which
#    strips workspace:*), creates git tags, and pushes them.
pnpm run release              # = turbo run build --filter=./packages/** && changeset publish && git push --follow-tags
```

Then create a GitHub release for the version tag (`gh release create vX.Y.Z`).

`changeset publish` detects pnpm and publishes with it, so `workspace:*` is
stripped correctly. Non-publishable packages are excluded via `private: true`
(`@porulle/eslint-config`, `@porulle/typescript-config`) or the
`.changeset/config.json` `ignore` list (`@porulle/docs` and the `apps/*`).

> **Build filter must be `./packages/**`** — `./packages/*` only matches the
> direct children of `packages/` and silently skips the nested
> `packages/{adapters,plugins,import}/*`, which would then publish without a
> fresh `dist`.

## Forcing a specific version (e.g. the 0.5.0 de-alpha jump)

Changesets only bumps semver by one step (`0.1.0` → `0.2.0`), so a deliberate
jump like `0.1.0` → `0.5.0` is done by setting every publishable
`package.json` `version` to the target, then `pnpm run release`. Internal
`workspace:*` ranges need no edits — pnpm resolves them at publish. After such
a jump, resume the normal changeset flow.

## Prerequisites

- `npm whoami` is a member of the `@porulle` org with publish rights.
- If npm 2FA-for-publish is enabled, run the publish step interactively (OTP) or
  use an automation token (`NPM_TOKEN`) in CI.
- For CI automation, the [`changesets/action`](https://github.com/changesets/action)
  opens a "Version Packages" PR and publishes on merge (pair with
  `pnpm/action-setup`).
