# RFC-018: Schema-Driven Input Types

- **Status:** Proposed
- **Author:** Engineering
- **Date:** 2026-03-17
- **Scope:** `packages/core/src/modules/*/service.ts`, `packages/core/src/interfaces/rest/schemas/*.ts`, `packages/core/src/interfaces/rest/routes/*.ts`
- **Motivation:** Eliminate 19 duplicated type definitions and 24 `as unknown as` double-casts by deriving service input types from Zod schemas via `z.infer<>`
- **Prior art:** tRPC, Elysia, oRPC --- all derive handler input types from the validation schema as a single source of truth
- **Estimated effort:** 2-3 engineering-days

---

## 1. Problem

The codebase maintains two parallel descriptions of every API input shape:

1. **Zod schemas** in `packages/core/src/interfaces/rest/schemas/*.ts` --- used by `@hono/zod-openapi` to validate HTTP request bodies and generate the OpenAPI spec.

2. **TypeScript interfaces** in `packages/core/src/modules/*/service.ts` --- used by service methods as parameter types (e.g., `CreateEntityInput`, `SetBasePriceInput`, `InventoryAdjustInput`).

Both describe the same shape but are defined independently. TypeScript sees them as two unrelated types because structural type compatibility does not flow across the `OpenAPIHono.openapi()` generic boundary. The result: every route handler must cast the Zod-validated body to the service input type:

```typescript
// packages/core/src/interfaces/rest/routes/catalog.ts
const result = await kernel.services.catalog.create(
  c.req.valid("json") as CreateEntityInput,   // type assertion bridges the gap
  c.get("actor"),
);
```

This pattern appears 24 times across 7 route files.

### 1.1 What Can Go Wrong

If a developer adds a field to the Zod schema but forgets to add it to the service interface (or vice versa), the two types silently diverge. The assertion hides the mismatch. The bug surfaces at runtime --- the service receives a property that TypeScript does not know about, or the client sends a field that the service ignores without error.

### 1.2 How Other Frameworks Solve This

**tRPC** derives the handler input type from the Zod schema passed to `.input()`. The schema IS the type. There is no separate interface to maintain:

```typescript
// tRPC: single source of truth
const appRouter = t.router({
  createUser: publicProcedure
    .input(z.object({ name: z.string(), email: z.string().email() }))
    .mutation(({ input }) => {
      // input is z.infer<typeof schema> --- { name: string; email: string }
      // no cast, no separate interface
      return db.insert(users).values(input);
    }),
});
```

**Elysia** does the same --- the schema defines the type, the handler receives the inferred type, OpenAPI docs are generated from the schema:

```typescript
// Elysia: single source of truth
new Elysia()
  .post("/users", ({ body }) => {
    // body is typed as { name: string } from the schema below
    return db.insert(users).values(body);
  }, {
    body: t.Object({ name: t.String() })
  })
```

In both cases, there is **one schema that serves three purposes**: runtime validation, compile-time type inference, and OpenAPI spec generation. There is no separate interface.

---

## 2. Current State (Audit)

### 2.1 Duplicated Pairs (19 total)

| Service Type (interface) | Zod Schema | Module |
|--------------------------|-----------|--------|
| `CreateEntityInput` | `CreateEntityBodySchema` | catalog |
| `UpdateEntityInput` | `UpdateEntityBodySchema` | catalog |
| `SetAttributesInput` | `SetAttributesBodySchema` | catalog |
| `CreateCategoryInput` | `CreateCategoryBodySchema` | catalog |
| `UpdateCategoryInput` | `UpdateCategoryBodySchema` | catalog |
| `CreateBrandInput` | `CreateBrandBodySchema` | catalog |
| `UpdateBrandInput` | `UpdateBrandBodySchema` | catalog |
| `CreateOptionTypeInput` | `CreateOptionTypeBodySchema` | catalog |
| `CreateOptionValueInput` | `CreateOptionValueBodySchema` | catalog |
| `CreateVariantInput` | `CreateVariantBodySchema` | catalog |
| `CreateCartInput` | `CreateCartBodySchema` | cart |
| `AddCartItemInput` | `AddCartItemBodySchema` | cart |
| `UpdateCartItemInput` | `UpdateCartItemQuantityBodySchema` | cart |
| `CreatePromotionInput` | `CreatePromotionBodySchema` | promotions |
| `InventoryAdjustInput` | `InventoryAdjustBodySchema` | inventory |
| `InventoryReserveInput` | `InventoryReserveBodySchema` | inventory |
| `InventoryReleaseInput` | `InventoryReleaseBodySchema` | inventory |
| `SetBasePriceInput` | `SetBasePriceBodySchema` | pricing |
| `CreatePriceModifierInput` | `CreateModifierBodySchema` | pricing |

### 2.2 Current `z.infer` Usage

**Zero.** No service input type is currently derived from a Zod schema. All 19 are hand-written interfaces.

### 2.3 Unmatched Types

Four service types have no corresponding Zod schema because they are used for query parameter parsing or internal options, not request body validation: `ListParams`, `GetOptions`, `ListOrdersParams`, `ChangeStatusInput`. These do not need migration --- they are not part of the duplication problem.

---

## 3. Solution

Invert the dependency: the Zod schema becomes the single source of truth. The service input type is derived from it via `z.infer<typeof schema>`. The schema file moves from the REST layer to a shared `schemas/` location accessible by both the service layer and the route layer.

### 3.1 New File Layout

```
packages/core/src/modules/catalog/
  schemas.ts          -- Zod schemas (CreateEntityBodySchema, etc.)
  service.ts          -- service methods use z.infer<typeof schema> as parameter types
  repository.ts       -- unchanged
  schema.ts           -- Drizzle table definitions (unchanged)

packages/core/src/interfaces/rest/
  schemas/catalog.ts  -- re-exports from modules/catalog/schemas.ts + route configs
  routes/catalog.ts   -- handlers use c.req.valid("json") directly, no cast
```

The Zod schemas move from `interfaces/rest/schemas/*.ts` (route-layer) to `modules/*/schemas.ts` (domain-layer). The route-layer schema files become thin re-exports that compose the Zod body schemas into `createRoute()` configs.

### 3.2 Why Not Keep Schemas in the Route Layer?

Because the service layer needs the type. If the schema stays in the route layer and the service imports `z.infer<typeof schema>` from there, the dependency arrow goes from domain to transport --- an architectural inversion. Moving the schema to the domain layer preserves the layering: routes depend on domain, domain does not depend on routes.

---

## 4. Pseudocode

### 4.1 Before (current pattern)

```
FILE modules/catalog/service.ts:
    INTERFACE CreateEntityInput:
        type: string
        slug: string
        metadata?: Record<string, unknown>

    FUNCTION create(input: CreateEntityInput, actor: Actor):
        // ... service logic

FILE interfaces/rest/schemas/catalog.ts:
    CONST CreateEntityBodySchema = z.object({
        type: z.string(),
        slug: z.string(),
        metadata: z.record(z.unknown()).optional(),
    })

    CONST createEntityRoute = createRoute({
        method: "post",
        path: "/api/catalog/entities",
        request: { body: { content: { "application/json": { schema: CreateEntityBodySchema } } } },
        responses: { ... },
    })

FILE interfaces/rest/routes/catalog.ts:
    IMPORT { CreateEntityInput } from "modules/catalog/service"
    IMPORT { createEntityRoute } from "schemas/catalog"

    router.openapi(createEntityRoute, async (c) => {
        const body = c.req.valid("json") as CreateEntityInput  // <-- TYPE ASSERTION
        const result = await kernel.services.catalog.create(body, actor)
    })
```

### 4.2 After (schema-driven)

```
FILE modules/catalog/schemas.ts:                   // NEW: Zod schemas live in domain layer
    CONST CreateEntityBodySchema = z.object({
        type: z.string(),
        slug: z.string(),
        metadata: z.record(z.unknown()).optional(),
    })

    TYPE CreateEntityInput = z.infer<typeof CreateEntityBodySchema>
    // { type: string; slug: string; metadata?: Record<string, unknown> }

FILE modules/catalog/service.ts:
    IMPORT type { CreateEntityInput } from "./schemas"   // type comes from Zod

    FUNCTION create(input: CreateEntityInput, actor: Actor):
        // ... service logic (UNCHANGED)

FILE interfaces/rest/schemas/catalog.ts:
    RE-EXPORT { CreateEntityBodySchema } from "modules/catalog/schemas"   // re-export for route configs

    CONST createEntityRoute = createRoute({
        method: "post",
        path: "/api/catalog/entities",
        request: { body: { content: { "application/json": { schema: CreateEntityBodySchema } } } },
        responses: { ... },
    })

FILE interfaces/rest/routes/catalog.ts:
    IMPORT { createEntityRoute } from "schemas/catalog"

    router.openapi(createEntityRoute, async (c) => {
        const body = c.req.valid("json")                   // <-- NO CAST NEEDED
        const result = await kernel.services.catalog.create(body, actor)
        // TypeScript infers body as z.infer<typeof CreateEntityBodySchema>
        // which IS CreateEntityInput -- same type, zero assertion
    })
```

---

## 5. Code Blueprint

### 5.1 `packages/core/src/modules/catalog/schemas.ts` (new file)

```typescript
import { z } from "@hono/zod-openapi";

// ─── Entity Schemas ───────────────────────────────────────────────────

export const CreateEntityBodySchema = z.object({
  type: z.string().min(1),
  slug: z.string().min(1),
  status: z.string().optional(),
  isVisible: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).openapi("CreateEntityRequest");

export type CreateEntityInput = z.infer<typeof CreateEntityBodySchema>;

export const UpdateEntityBodySchema = z.object({
  status: z.string().optional(),
  isVisible: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).openapi("UpdateEntityRequest");

export type UpdateEntityInput = z.infer<typeof UpdateEntityBodySchema>;

export const SetAttributesBodySchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  description: z.string().optional(),
  richDescription: z.unknown().optional(),
  seoTitle: z.string().optional(),
  seoDescription: z.string().optional(),
}).openapi("SetAttributesRequest");

export type SetAttributesInput = z.infer<typeof SetAttributesBodySchema>;

// ... remaining catalog schemas (categories, brands, options, variants)
```

### 5.2 Updated `packages/core/src/modules/catalog/service.ts`

```typescript
// BEFORE:
export interface CreateEntityInput {
  type: string;
  slug: string;
  status?: string;
  isVisible?: boolean;
  metadata?: Record<string, unknown>;
}

// AFTER:
export type { CreateEntityInput } from "./schemas";
// The interface is DELETED. The type is re-exported from schemas.ts.
// Service methods continue to use CreateEntityInput as before -- no changes to method signatures.
```

### 5.3 Updated `packages/core/src/interfaces/rest/schemas/catalog.ts`

```typescript
// BEFORE: defines Zod schemas inline
// AFTER: re-exports from domain layer
export { CreateEntityBodySchema, UpdateEntityBodySchema, SetAttributesBodySchema } from "../../../modules/catalog/schemas";

// Route configs remain here (they compose schemas into createRoute() objects)
import { CreateEntityBodySchema } from "../../../modules/catalog/schemas";

export const createEntityRoute = createRoute({
  method: "post",
  path: "/api/catalog/entities",
  request: { body: { content: { "application/json": { schema: CreateEntityBodySchema } } } },
  responses: { ... },
});
```

### 5.4 Updated `packages/core/src/interfaces/rest/routes/catalog.ts`

```typescript
// BEFORE:
import type { CreateEntityInput } from "../../../modules/catalog/service";

router.openapi(createEntityRoute, async (c) => {
  const result = await kernel.services.catalog.create(
    c.req.valid("json") as CreateEntityInput,   // type assertion
    c.get("actor"),
  );
});

// AFTER:
// No import of CreateEntityInput needed -- the type flows through Zod inference

router.openapi(createEntityRoute, async (c) => {
  const result = await kernel.services.catalog.create(
    c.req.valid("json"),                         // no cast -- types match
    c.get("actor"),
  );
});
```

---

## 6. Migration Strategy

The migration is mechanical. For each of the 19 pairs:

1. Move the Zod schema from `interfaces/rest/schemas/{module}.ts` to `modules/{module}/schemas.ts`
2. Add `export type FooInput = z.infer<typeof FooBodySchema>` next to the schema
3. In `modules/{module}/service.ts`, delete the hand-written interface and add `export type { FooInput } from "./schemas"`
4. In `interfaces/rest/schemas/{module}.ts`, replace the inline schema with a re-export from `modules/{module}/schemas`
5. In `interfaces/rest/routes/{module}.ts`, remove the `as FooInput` cast from `c.req.valid("json")`
6. Run `npx tsc --noEmit` to verify the types flow correctly

Each pair takes ~10 minutes. Total: ~3 hours of mechanical work, plus 1 hour for TypeScript verification, plus 1 hour for test runs.

### 6.1 Order of Migration

| Step | Module | Pairs | Reason |
|------|--------|-------|--------|
| 1 | catalog | 10 | Most casts, highest risk |
| 2 | inventory | 3 | Includes the SELECT FOR UPDATE flow |
| 3 | cart | 3 | Checkout pipeline dependency |
| 4 | pricing | 2 | Straightforward |
| 5 | promotions | 1 | Straightforward |
| 6 | orders | 1 (ChangeStatusInput) | Small |

### 6.2 What Does NOT Change

- Service method signatures (same parameter names, same behavior)
- Route behavior (same validation, same response shapes)
- OpenAPI spec (same schemas, same paths)
- Database queries (services still use the same Drizzle operations)
- Tests (same HTTP requests, same assertions)

The only thing that changes is WHERE the type is defined and HOW it reaches the service.

---

## 7. Impact on `router()` Builder Routes

Plugin routes that use the `router()` builder already avoid this problem. The `router()` handler receives `input: unknown` and the handler casts it with `input as z.infer<typeof Schema>`. This is a single safe cast (Zod-validated), not a double-cast through `unknown`.

After this RFC, the `router()` builder could be updated to also accept a generic type parameter that threads the Zod schema through to the handler's `input` field, eliminating even that single cast. This is a future enhancement, not part of this RFC.

---

## 8. Implementation Checklist

### Catalog (10 pairs)

- [ ] Create `modules/catalog/schemas.ts` with all 10 Zod schemas + `z.infer` types
- [ ] Delete 10 interfaces from `modules/catalog/service.ts`, replace with type re-exports
- [ ] Update `interfaces/rest/schemas/catalog.ts` to re-export from domain layer
- [ ] Remove 10 type casts from `interfaces/rest/routes/catalog.ts`
- [ ] Verify `npx tsc --noEmit` passes
- [ ] Verify `bun test` passes

### Inventory (3 pairs)

- [ ] Create `modules/inventory/schemas.ts`
- [ ] Delete 3 interfaces from service, re-export
- [ ] Update route schema file, remove 3 casts from route handlers
- [ ] Verify tsc + tests

### Cart (3 pairs)

- [ ] Create `modules/cart/schemas.ts`
- [ ] Delete 3 interfaces from service, re-export
- [ ] Update route schema file, remove 3 casts from route handlers
- [ ] Verify tsc + tests

### Pricing (2 pairs)

- [ ] Create `modules/pricing/schemas.ts`
- [ ] Delete 2 interfaces from service, re-export
- [ ] Update route schema file, remove 2 casts from route handlers
- [ ] Verify tsc + tests

### Promotions (1 pair)

- [ ] Create `modules/promotions/schemas.ts`
- [ ] Delete 1 interface from service, re-export
- [ ] Update route schema file, remove 1 cast from route handler
- [ ] Verify tsc + tests

### Orders (1 pair)

- [ ] Move `ChangeOrderStatusBodySchema` to `modules/orders/schemas.ts`
- [ ] Derive `ChangeStatusInput` via `z.infer`
- [ ] Verify tsc + tests

### Final verification

- [ ] `as unknown as` count in routes is 0 (currently 1 justified in catalog)
- [ ] `as SomeInput` count in routes is 0
- [ ] Zero hand-written service input interfaces remain for the 19 migrated pairs
- [ ] All 266 core tests pass
- [ ] All plugin tests pass
- [ ] OpenAPI spec at `/api/doc` is unchanged (same paths, same schemas)
- [ ] Regenerate SDK types: `bun run sdk:generate:local`

---

## 9. Success Criteria

- [ ] All 19 service input types derived from Zod schemas via `z.infer<>`
- [ ] Zero type assertions in route handlers for request body access
- [ ] Zod schemas are the single source of truth for input shapes
- [ ] Service layer does not import from the route/transport layer
- [ ] OpenAPI spec output is byte-identical before and after migration
- [ ] 266 core tests pass with zero regressions

---

## 10. Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `z.infer` produces subtly different types than the hand-written interface (e.g., optional vs undefined) | Medium | Medium | Run `npx tsc --noEmit` after each pair. The `exactOptionalPropertyTypes` flag will catch mismatches immediately. |
| Moving schemas to domain layer creates circular imports (schemas.ts imports from schema.ts which imports from... ) | Low | Medium | Zod schemas reference no Drizzle tables. They are pure validation definitions with no imports from the module's own code. |
| Plugin tests break because they import service input types that no longer exist as interfaces | Low | Low | The types are re-exported. `import type { CreateEntityInput } from "@unifiedcommerce/core"` will continue to resolve via the barrel export. |
| OpenAPI spec changes because Zod schema was slightly different from the interface | Low | High | Compare `/api/doc` output before and after each module migration. Byte-identical is the success criterion. |

---

## 11. References

- [tRPC input validators](https://trpc.io/docs/server/validators) --- derives handler input type from `.input(schema)`, zero casts
- [Elysia validation](https://elysiajs.com/essential/validation) --- schema defines the type, handler receives inferred type
- [oRPC](https://blog.logrocket.com/trpc-vs-orpc-type-safe-rpc/) --- works with Zod, Valibot, or ArkType; infers types from any schema
- [Hono Zod OpenAPI](https://hono.dev/examples/zod-openapi) --- `c.req.valid("json")` returns Zod-inferred type when used with `app.openapi(route, handler)`
- [Zod type inference](https://zod.dev/) --- `z.infer<typeof schema>` extracts the TypeScript type from a Zod schema
