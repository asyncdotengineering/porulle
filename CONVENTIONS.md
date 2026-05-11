# Engineering Conventions

Mandatory rules for all source, test, script, and adapter code in this repo. New
code that violates these is rejected at review. Existing code that violates them
is fixed when touched, not preserved.

---

## 1. Drizzle is a first-class citizen — raw SQL is an escape hatch

**Rule:** every database read or write goes through Drizzle's typed query
builder. `db.execute(sql\`...\`)` is permitted only when Drizzle's typed
surface genuinely cannot express the operation.

### What "first-class" means

- **Reads:** `db.select().from(table).where(eq(table.col, value))` — never
  `db.execute(sql\`SELECT ...\`)`.
- **Writes:** `db.insert(table).values({...}).onConflictDoNothing()` — never
  `db.execute(sql\`INSERT INTO ...\`)`.
- **Updates:** `db.update(table).set({...}).where(...)` — never
  `db.execute(sql\`UPDATE ...\`)`.
- **Joins:** Drizzle's `innerJoin` / `leftJoin` / `with` — never raw `JOIN`.
- **Test seeds:** typed inserts. A column rename in `core/schema` should
  break the test at compile time, not runtime.

### Why this matters

Raw SQL strings are nominally typed `sql\`...\`` but TypeScript can't see
the column names, the value shapes, or the return type. Three concrete failure
modes the typed builder eliminates:

1. **Column drift.** Renaming a column from `is_visible` → `isVisible` in
   the schema doesn't break raw `INSERT INTO ... is_visible ...` strings —
   it fails at runtime when the test fires the query. With the typed
   builder, TypeScript errors at compile time.

2. **Enum drift.** `status: 'published'` (a string literal) compiles fine
   in raw SQL, but if the schema enum is `["draft", "active", "archived"]`,
   the INSERT silently fails at runtime. The typed builder rejects
   `status: "published"` immediately because it's not in the enum.

3. **Type mismatch.** Raw SQL bindings accept any value. Typed builder
   knows `quantityOnHand` is `integer` and rejects strings. Catches the
   `null vs undefined` Drizzle bug class (see `MEMORY.md`).

### The escape hatch — when raw `sql\`\`` is unavoidable

These are the **only** legitimate cases. Add a justification comment **when
the reason isn't self-evident from context** — a `pg_catalog` introspection
query is obviously escape-hatch territory and needs no ceremonial label, but
a raw `INSERT` next to typed Drizzle calls needs a sentence explaining why
this one is different.

| Use case | Example | Why typed builder doesn't fit |
|----------|---------|-------------------------------|
| Sequence operations | `sql\`SELECT nextval('order_number_seq')\`` | Drizzle has `pgSequence` for declaration but no first-class `nextval` runtime call |
| Database introspection | `sql\`SELECT * FROM pg_indexes WHERE ...\`` | Reads catalog tables not in your schema |
| Migration / DDL outside drizzle-kit | `sql\`CREATE EXTENSION IF NOT EXISTS pgcrypto\`` | DDL beyond what `pgTable` declares |
| Performance-critical raw query | `sql\`SELECT ... USING INDEX ...\`` | Needs an index hint Drizzle doesn't expose |
| Bulk operations Drizzle batches inefficiently | `sql\`COPY ... FROM ...\`` | `COPY` for bulk import |
| `setval()`, `LOCK TABLE`, `VACUUM`, etc. | `sql\`SELECT setval(...)\`` | Server-side admin operations |

If your case isn't on this list, the answer is: **use the typed builder**.

### Anti-patterns

```typescript
// ❌ DON'T — column names + values both unchecked
const rawDb = db as { execute: (q: unknown) => Promise<unknown> };
await rawDb.execute(sql\`INSERT INTO customers (id, email, organization_id) VALUES (\${id}, \${email}, \${orgId})\`);

// ❌ DON'T — typed enough to look safe, still loses column-rename safety
await db.execute(sql\`UPDATE orders SET status = 'cancelled' WHERE id = \${orderId}\`);

// ❌ DON'T — escape-hatch import bypassing the typed `db` handle
import { sql } from "drizzle-orm";  // raw sql in non-escape-hatch context
```

### Correct patterns

```typescript
// ✅ DO — typed insert, column rename breaks compile, enum violations rejected
await db.insert(customers).values([
  { id, email, organizationId: orgId },
]).onConflictDoNothing();

// ✅ DO — typed update, .set() typechecks against the table's column types
await db.update(orders)
  .set({ status: "cancelled" })
  .where(eq(orders.id, orderId));

// ✅ DO — escape hatch with explicit justification comment
// Sequence reads aren't expressible via Drizzle's typed surface — single-row
// raw query is the canonical pattern for monotonic counter generation.
const row = await db.execute(sql\`SELECT nextval('order_number_seq') AS seq\`);
```

### How to enforce

- **Code review:** raw `sql\`\`` outside the escape-hatch list is a blocker.
- **Pre-commit hook (future):** lint rule that flags `db.execute(sql\`(INSERT|UPDATE|DELETE|SELECT)\`)` outside files allowlisted as escape hatches.
- **The `@unifiedcommerce/core/drizzle` re-export** should be the canonical drizzle import path for all plugins (see §2).

---

## 2. Drizzle imports flow through `@unifiedcommerce/core/drizzle`

**Rule:** plugins and apps import drizzle primitives (`pgTable`, `eq`, `sql`,
`PostgresJsDatabase`, etc.) from `@unifiedcommerce/core/drizzle`, not from
`drizzle-orm` or `drizzle-orm/pg-core` directly.

### Why

Bun's peer-dep deduping creates separate hash variants of `drizzle-orm`
based on which packages pull `drizzle-zod`. Plugins that imported
`pgTable` directly from `drizzle-orm/pg-core` resolved to a different
copy than core's `db` instance — TypeScript treated them as nominally
distinct types, breaking every `db.select().from(table)` call site at
compile time.

Routing through `@unifiedcommerce/core/drizzle` forces single-copy
resolution: plugins import via core, core has one drizzle copy, all
types unify.

### Anti-pattern

```typescript
// ❌ DON'T — pulls a separate drizzle copy via the plugin's node_modules
import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import { eq, sql } from "drizzle-orm";
```

### Correct pattern

```typescript
// ✅ DO — resolves through core's single drizzle copy
import { pgTable, text, uuid, eq, sql } from "@unifiedcommerce/core/drizzle";
```

### Exception — core itself

`packages/core/src/**/*` may import from `drizzle-orm` directly, since
core IS the package that exports the re-export. This is the only
exception.

---

## 3. No `as any`, no `@ts-ignore`, no `@ts-nocheck`

**Rule:** if TypeScript complains, fix the type — don't silence it.

Acceptable narrow casts:
- `as Record<string, unknown>` at a known-untyped boundary
- `as <ConcreteType>` where the value's runtime shape is verified
- `@ts-expect-error -- <reason>` only when fighting a documented library
  bug, paired with a comment naming the bug

Banned:
- `as any` — use `as unknown as <Type>` if you genuinely need to bridge
- `@ts-ignore` — replaced by `@ts-expect-error` (catches when the error
  goes away)
- `@ts-nocheck` — never. Apply per-line if you must.

---

## 4. Null vs undefined — match the runtime

**Rule:** Drizzle returns `null` for nullable columns. JavaScript code
defaults to `undefined`. The mismatch is the source class of the bug at
`MEMORY.md` ("null vs undefined for variantId"). Always:

- Use `!= null` (loose equality) to catch both.
- Use `isNull(col)` for SQL `IS NULL` — never pass `null` to `eq()`.
- Type guards on optional fields use `!= null`, not `!== undefined`.

---

## 5. exactOptionalPropertyTypes — conditional spread, not undefined

**Rule:** the project's tsconfig has `exactOptionalPropertyTypes: true`.
Never pass `field: undefined` for optional fields.

### Anti-pattern

```typescript
// ❌ DON'T — exactOptionalPropertyTypes rejects the explicit undefined
const input: { sku?: string } = {
  entityId: id,
  sku: maybeSku ?? undefined,
};
```

### Correct pattern

```typescript
// ✅ DO — conditional spread omits the field when absent
const input: { sku?: string } = {
  entityId: id,
  ...(maybeSku !== undefined ? { sku: maybeSku } : {}),
};
```

---

## 6. Every package.json has `"license": "MIT"`

Project rule from S0-01. New packages added without a license field will
fail `bun run lint`. Repo root has the canonical MIT LICENSE file.

---

## 7. Tests run without external infrastructure by default

**Rule:** `bun run test` should pass on a clean machine without provisioning
PostgreSQL, dev servers, or external services. Live-infra suites are
gated behind `bun run test:e2e` and excluded from default runs via
vitest config.

Plugin tests use PGlite (in-process Postgres-compatible) via
`createPluginTestApp`. App tests that need a live PG/server live in a
`.e2e.test.ts` file or are excluded from the default `vitest.config.ts`
include glob.

---

## How to update these conventions

1. Edit this file.
2. Update `MEMORY.md` (the auto-memory index) so the convention persists across sessions.
3. Mention the new convention in the next sprint's WARMDOWN.md if landed mid-project.

When a convention conflicts with an existing pattern in the codebase, the
convention wins — fix the existing pattern when you touch it.
