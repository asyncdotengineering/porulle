# @porulle/adapter-pg-search

`SearchAdapter` powered by **PostgreSQL full-text search** (`tsvector` + `tsquery`). Zero extra infrastructure — your existing Postgres is the search engine.

## Usage

```ts
import { defineConfig } from "@porulle/core";
import { pgSearchAdapter } from "@porulle/adapter-pg-search";

export default defineConfig({
  search: {
    adapter: pgSearchAdapter({
      query: (sql, params) => yourPgClient.query(sql, params),
      tableName: "search_index",     // default
      dictionary: "english",          // default; pick "simple" for non-English heavy stores
    }),
  },
  // …
});
```

The `query` function should be a thin wrapper around your PG client (`postgres`, `pg`, etc.) that returns `{ rows: ... }`. The adapter sends parameterized queries — never string-concatenates user input.

## When to pick this over Meilisearch

| You want | Use |
|---|---|
| Zero new services, "just works on the existing DB" | `@porulle/adapter-pg-search` |
| Sub-50ms typo-tolerant search at 10k+ products | `@porulle/adapter-meilisearch` |
| Faceted search with rich aggregations | `@porulle/adapter-meilisearch` |
| <100 products and no search-quality requirements | this adapter is fine |

## Notes

- Identifiers (`tableName`, column names) are validated against `^[a-zA-Z_][a-zA-Z0-9_]*$` to defend against SQL identifier injection. Don't pass user input as `tableName`.
- The dictionary defaults to `english`. For multi-locale stores, pick `simple` and handle stemming at the query layer.

## See also

- [PostgreSQL Full Text Search](https://www.postgresql.org/docs/current/textsearch.html)
- `@porulle/adapter-meilisearch` — when you outgrow PG FTS
