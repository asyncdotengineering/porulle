# UnifiedCommerce starter

## Prerequisites

- PostgreSQL reachable from your machine (create a database, e.g. `createdb unified_commerce`)
- [Bun](https://bun.sh/) installed

## Install

```bash
bun install
```

## Configure

```bash
cp .env.example .env
```

Edit `.env`: set `DATABASE_URL`, generate `BETTER_AUTH_SECRET` (`openssl rand -hex 32`), and keep `BETTER_AUTH_URL` aligned with where the app listens (default `http://localhost:4000`).

## Migrate

Push the Drizzle schema (core, Better Auth, and any installed `@porulle/plugin-*` packages):

```bash
bun run db:push
```

## Run

```bash
bun run dev
```

The process listens on `PORT` from `.env`, or **4000** by default.

## First request

With Postgres migrated and the server up:

```bash
curl http://localhost:4000/api/health
```

Expect JSON with `"status":"ok"` when the database probe succeeds.

## Next steps

- Documentation: [porulle-docs.vercel.app](https://porulle-docs.vercel.app) — full docs site. Source under [apps/docs](https://github.com/asyncdotengineering/porulle/tree/main/apps/docs).
- Add plugins or adapters via `bun add @porulle/plugin-<name>` and re-run `bun run db:push` so plugin tables are included.
