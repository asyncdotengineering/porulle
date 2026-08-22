---
"@porulle/core": minor
---

Give `config.routes` a tenant-scoped database handle.

`config.routes` receives the kernel, and `kernel.database.db` is unscoped — nothing resolves an organization and nothing warned. It is the simplest way to add an endpoint, so it was the easiest place to write a query that silently reads every tenant's rows.

The handle passed to `config.routes` now carries both:

```ts
routes: (app, kernel) => {
  app.get("/api/reviews", async (c) => {
    // Scoped: constrained to the request's organization, even with no WHERE.
    const rows = await kernel.database.scoped.select().from(reviews);
    return c.json({ data: rows });
  });
}
```

`kernel.database.db` is **unchanged** and still returns the raw handle, so no existing behaviour moves — but accessing it now emits a rate-limited warning naming `scoped`. Reach for it deliberately when you need cross-organization access, and filter by `organizationId` yourself.

Note that raw `db.execute()` is never tenant-scoped on either handle: the scoping proxy wraps `select`, `insert`, `update` and `delete`, and cannot inject a predicate into arbitrary SQL.
