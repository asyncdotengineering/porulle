# @porulle/cli

The command-line tool. Scaffolds new stores, runs migrations, mints API keys, doctors broken setups.

## Commands

| Command | What |
|---|---|
| `porulle init <name>` | scaffold a new store from `templates/starter/` — `commerce.config.ts`, `drizzle.config.ts`, server entry, package.json wired to `@porulle/*` workspace deps |
| `porulle dev` | start the example server with reload (delegates to the app's own `dev` script when present) |
| `porulle migrate` | apply pending Drizzle migrations against `DATABASE_URL` |
| `porulle generate migration` | drizzle-kit generate — produce a new SQL migration from schema diffs |
| `porulle deploy` | thin wrapper around the app's deploy script |
| `porulle import <file>` | run an import adapter (Shopify CSV, WooCommerce XML, flat JSON) |
| `porulle api-key create --scope <scope>` | mint an API key with the given permission scope (replaces the deprecated `auth.devKey`) |
| `porulle doctor` | environment + config sanity check |

## Install

When published:

```bash
bun add -g @porulle/cli
porulle init my-store
```

In the monorepo today (workspace dep):

```bash
cd apps/<app> && bunx porulle init <name>
```

## Starter template

`templates/starter/` is what `porulle init` copies. Adjust there to change the default scaffold.

## See also

- [Root README — Quick Start](../../README.md#quick-start)
- [`SECURITY.md`](../../SECURITY.md) — why `auth.devKey` was removed (`api-key create` replaces it)
