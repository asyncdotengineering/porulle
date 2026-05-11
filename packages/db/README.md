# @porulle/db

The database surface plugins use instead of importing Drizzle directly.

```ts
import { defineTable, column, eq, and, sql } from "@porulle/db";
```

## Why this exists

If every plugin imported from `drizzle-orm` directly, the framework couldn't:
- Inject `organizationId` and `id` columns automatically
- Add the standard `createdAt` / `updatedAt` timestamps
- Generate the per-org index + composite unique constraints
- Hot-swap the underlying ORM if we ever needed to (today: Drizzle on PostgreSQL — tomorrow could be different)

`@porulle/db` is the thin contract that decouples plugins from the ORM. Drizzle stays as an implementation detail.

## API

### `defineTable(name, columns)`

Top-level table. Auto-injects: `id` (UUID PK), `organizationId` (text NOT NULL with org index), `createdAt` and `updatedAt` (timestamps).

```ts
import { defineTable, column } from "@porulle/db";

export const giftCards = defineTable("gift_cards", {
  code: column.text({ unique: true }),
  balance: column.integer(),
  status: column.text({ enum: ["active", "disabled"], default: "active" }),
});
```

### `column.*` builders

`column.text({ unique?, optional?, enum?, default? })`
`column.integer({ optional?, default? })`
`column.boolean({ default? })`
`column.timestamp({ optional? })`
`column.jsonb<T>({ optional?, default? })`
`column.uuid({ optional?, default? })` — for FKs to other org-scoped tables (child tables skip the auto-org column)

### Re-exported Drizzle operators

For query construction without importing `drizzle-orm` directly:

```ts
eq, ne, gt, gte, lt, lte, and, or, not, like, ilike, notLike,
inArray, notInArray, isNull, isNotNull, between, sql, desc, asc
```

## Conventions

- Every top-level table is org-scoped via the auto-injected `organizationId`. Cross-tenant queries are a closed surface — see [`SECURITY.md`](../../SECURITY.md).
- Child tables (FK to a parent that already carries `organizationId`) get `id` and `createdAt` only. The parent's org column protects the child rows.
- Drizzle hash drift across workspace copies has bitten us before — `@porulle/db` re-exports the operators so plugins inherit a single drizzle version.

## See also

- [Plugin Contract](https://github.com/asyncdotengineering/porulle/blob/main/apps/docs/src/content/docs/extending/plugin-contract.mdx) — Drizzle-first rule + org-scoping requirement
- `packages/core/src/kernel/database/` — how the kernel composes the schema
