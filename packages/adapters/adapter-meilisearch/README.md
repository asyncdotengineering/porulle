# @porulle/adapter-meilisearch

`SearchAdapter` for [Meilisearch](https://www.meilisearch.com). Indexes catalog entities and answers `/api/search` and `/api/search/suggest` queries.

## Usage

```ts
import { defineConfig } from "@porulle/core";
import { meilisearchAdapter } from "@porulle/adapter-meilisearch";
import { MeiliSearch } from "meilisearch";

const meili = new MeiliSearch({
  host: process.env.MEILI_HOST!,
  apiKey: process.env.MEILI_KEY!,
});

export default defineConfig({
  search: {
    adapter: meilisearchAdapter({
      client: meili,
      indexName: "porulle_catalog",
    }),
  },
  // …
});
```

## What it does

- Adds documents on catalog create/update via the kernel's `catalog.afterCreate` / `afterUpdate` hooks
- Removes documents on `catalog.afterDelete`
- Configures filterable attributes per the indexed schema
- Maps Meili's hits + facetDistribution into Porulle's `SearchQueryResult` shape

## Notes

- Bring your own Meilisearch instance — local Docker, Meilisearch Cloud, or self-hosted.
- The adapter assumes one index per organization or per tenant; configure the `indexName` accordingly.
- For Postgres-only deployments without a separate search service, use `@porulle/adapter-pg-search`.

## See also

- [Meilisearch docs](https://www.meilisearch.com/docs)
- `@porulle/adapter-pg-search` — Postgres FTS alternative (no extra service)
