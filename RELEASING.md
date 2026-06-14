# Releasing

How `@porulle/*` packages are versioned and published. This repo uses **bun
workspaces + [Changesets](https://github.com/changesets/changesets)**, with all
`@porulle/*` packages in a single **`fixed`** group (they always share one
version) and **`access: public`** (see `.changeset/config.json`).

## Dependency-range strategy: explicit `^x.y.z`, **not** `workspace:*`

Internal `@porulle/*` dependencies are pinned with caret ranges (e.g.
`"@porulle/core": "^0.5.0"`), **not** the `workspace:*` protocol. This is a
deliberate choice for a **bun + Changesets** stack:

- `changeset publish` shells out to **`npm`**, and **npm does not understand or
  strip the `workspace:` protocol** — it publishes the literal `"workspace:*"`,
  producing uninstallable manifests (this was issue #24).
- bun's own `bun publish` *does* strip `workspace:` → version, **but** it reads
  the version from the **lockfile**, which `bun install` does not reliably
  re-sync after a version bump — so `workspace:*` can publish a **stale** version
  (verified: a `bun pm pack` after bumping to `0.5.0` emitted `"@porulle/core":
  "0.1.0"`). See [bun#16074](https://github.com/oven-sh/bun/issues/16074),
  [changesets#1389](https://github.com/changesets/changesets/discussions/1389).

With explicit caret ranges there is **no `workspace:` protocol to strip**, so
`changeset publish` (npm) is correct as-is. `changeset version` keeps the ranges
in sync automatically (`updateInternalDependencies: "patch"` bumps `^0.5.0` →
`^0.6.0` on each release). Local dev still links workspaces because the local
package version satisfies the caret range.

> Trade-off vs `workspace:*`: ranges are slightly less "automatic," but
> `changeset version` maintains them, and this avoids every bun/npm
> workspace-stripping sharp edge. If you ever migrate to **pnpm**, the cleaner
> convention is `workspace:*` + `pnpm -r publish` (pnpm strips the protocol from
> the *current* package.json at publish, and orchestrates the whole monorepo) —
> at which point you'd switch the manifests back to `workspace:*`.

## The release flow

```bash
# 1. While developing, add a changeset per change (bump type + summary).
bun run changeset            # interactive; commit the generated .changeset/*.md

# 2. Cut the version. Bumps every @porulle/* (fixed group) to one version,
#    updates each CHANGELOG, bumps internal ^ ranges, re-syncs the lockfile.
bun run version-packages     # = changeset version && bun install
#    Review + commit the result (a "Version Packages" commit/PR).

# 3. Publish. Builds ALL publishable packages (the nested adapters/plugins/
#    import included — note the `./packages/**` filter), publishes via npm,
#    creates git tags, and pushes them.
bun run release              # = turbo run build --filter=./packages/** && changeset publish && git push --follow-tags
```

Then create a GitHub release for the version tag (`gh release create vX.Y.Z`).

### Gotchas baked into the scripts

- **Build filter must be `./packages/**`** — `./packages/*` only matches the
  direct children of `packages/` (core, cli, sdk, db) and silently skips the
  nested `packages/adapters/*`, `packages/plugins/*`, `packages/import/*`, which
  would then publish without a fresh `dist`.
- **`bun install` after `changeset version`** keeps `bun.lock` in step with the
  new versions.
- Non-publishable packages are excluded via `private: true`
  (`@porulle/eslint-config`, `@porulle/typescript-config`) or the
  `.changeset/config.json` `ignore` list (`@porulle/docs` and the `apps/*`).

## Forcing a specific version (e.g. the 0.5.0 de-alpha jump)

Changesets only bumps semver by one step (`0.1.0` → `0.2.0`), so a deliberate
jump like `0.1.0` → `0.5.0` is done by setting every publishable
`package.json` `version` to the target and the internal `^` ranges to match,
then running `bun run release`. After such a manual jump, resume the normal
changeset flow.

## Prerequisites

- `npm whoami` is a member of the `@porulle` org with publish rights.
- If npm 2FA-for-publish is enabled, run the publish step interactively (to
  enter the OTP) or use an automation token (`NPM_TOKEN`) in CI.
- For CI automation, the [`changesets/action`](https://github.com/changesets/action)
  opens a "Version Packages" PR and publishes on merge.
