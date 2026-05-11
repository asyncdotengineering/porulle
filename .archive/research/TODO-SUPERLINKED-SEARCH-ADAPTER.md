# TODO: Superlinked Search Adapter — AI-Native Vector Search

## What is Superlinked

[Superlinked](https://github.com/superlinked/superlinked) is a Python framework for building AI-powered search and recommendation systems. It combines structured data (price, rating, category) with unstructured data (product descriptions, images) into a single vector space.

Key differentiator: **multi-modal embedding** — instead of treating text search and attribute filtering as separate systems, Superlinked encodes everything (text similarity + numeric ranges + categories + recency) into a unified vector. A query like "best cotton sarees under 5000" simultaneously matches on text ("cotton sarees"), price (< 5000), and rating (sort by best).

## Why This Matters for UnifiedCommerce

Current search adapters (Meilisearch, PG full-text) are keyword-based:
- `"cotton saree"` matches documents containing those words
- Filtering by price/rating is a separate SQL `WHERE` clause
- No understanding of semantic similarity ("silk wrap" doesn't match "saree")
- No personalization based on user behavior

Superlinked enables:
- **Semantic search**: "comfortable summer clothes" finds products without those exact words
- **Multi-signal ranking**: text relevance + price + rating + recency in one score
- **Personalization**: encode user behavior (views, purchases) into query vector
- **Natural language queries**: "best toothbrushes" understands rating + quality
- **Agent-friendly**: AI agents can construct queries with weighted signals

## Architecture

```
UnifiedCommerce Engine
  └── SearchAdapter interface (existing)
        ├── MeilisearchAdapter (keyword search)
        ├── PgSearchAdapter (PostgreSQL full-text)
        └── SuperlinkedAdapter (NEW — vector search)
              │
              ▼
        Superlinked Server (Python, self-hosted)
              │
              ├── Embedding models (sentence-transformers, open-clip)
              ├── Vector DB (Redis, MongoDB, Qdrant)
              └── REST API for indexing + querying
```

Superlinked runs as a **sidecar** (like Cube.js) — a separate Python process with its own REST API. The adapter communicates via HTTP.

## Implementation Plan

### Step 1: Define the Superlinked Schema

Map `SearchDocument` fields to Superlinked spaces:

```python
# superlinked/schema.py
from superlinked import framework as sl

class Product(sl.Schema):
    id: sl.IdField
    title: sl.String          # → TextSimilaritySpace
    description: sl.String    # → TextSimilaritySpace
    price: sl.Float           # → NumberSpace (MINIMUM mode — cheaper is better for "budget")
    rating: sl.Float          # → NumberSpace (MAXIMUM mode — higher is better)
    category: sl.String       # → CategoricalSimilaritySpace
    brand: sl.String          # → CategoricalSimilaritySpace
    created_at: sl.Timestamp  # → RecencySpace (newer products rank higher)

product = Product()

# Multi-modal embedding: all spaces combined into one vector
text_space = sl.TextSimilaritySpace(
    text=[product.title, product.description],
    model="Alibaba-NLP/gte-large-en-v1.5"
)
price_space = sl.NumberSpace(number=product.price, min_value=0, max_value=100000, mode=sl.Mode.MINIMUM)
rating_space = sl.NumberSpace(number=product.rating, min_value=1, max_value=5, mode=sl.Mode.MAXIMUM)
category_space = sl.CategoricalSimilaritySpace(
    category_input=product.category,
    categories=["product", "service", "digital", "bundle"],
)
recency_space = sl.RecencySpace(timestamp=product.created_at, period_time_list=[sl.PeriodTime(timedelta(days=30))])

index = sl.Index([text_space, price_space, rating_space, category_space, recency_space])
```

### Step 2: Create the TypeScript Adapter

```
packages/adapters/adapter-superlinked/
  src/
    index.ts          — SuperlinkedSearchAdapter implements SearchAdapter
    client.ts         — HTTP client for Superlinked REST API
  package.json
  tsconfig.json
```

```typescript
// packages/adapters/adapter-superlinked/src/index.ts
import type { SearchAdapter, SearchDocument, SearchQueryParams, SearchQueryResult, SearchSuggestParams } from "@unifiedcommerce/core";
import { Ok, Err } from "@unifiedcommerce/core";

export interface SuperlinkedAdapterOptions {
  /** Superlinked server URL. Default: http://localhost:8080 */
  serverUrl?: string;
  /** Embedding model for text. Default: "Alibaba-NLP/gte-large-en-v1.5" */
  textModel?: string;
  /** Query-time weight configuration */
  weights?: {
    text?: number;     // Default: 1.0
    price?: number;    // Default: 0.3
    rating?: number;   // Default: 0.5
    recency?: number;  // Default: 0.2
  };
}

export class SuperlinkedSearchAdapter implements SearchAdapter {
  readonly providerId = "superlinked";

  async index(documents: SearchDocument[]): Promise<Result<void>> {
    // POST /api/v1/ingest — send product data to Superlinked for embedding
    // Superlinked handles vectorization automatically
  }

  async remove(ids: string[]): Promise<Result<void>> {
    // DELETE /api/v1/ingest — remove documents from index
  }

  async search(params: SearchQueryParams): Promise<Result<SearchQueryResult>> {
    // POST /api/v1/search — send query with weighted signals
    // Superlinked returns ranked results with scores
    // Map back to SearchHit[] format
  }

  async suggest(params: SearchSuggestParams): Promise<Result<string[]>> {
    // Use text similarity with low limit for autocomplete suggestions
  }
}
```

### Step 3: Query-Time Weight Control

The power of Superlinked is **query-time weight adjustment**. Different queries emphasize different signals:

```typescript
// "best cotton sarees" — emphasize text + rating
search({ query: "best cotton sarees", weights: { text: 1.0, rating: 0.8 } })

// "cheap t-shirts" — emphasize text + low price
search({ query: "cheap t-shirts", weights: { text: 1.0, price: 1.0 } })

// "new arrivals" — emphasize recency
search({ query: "new arrivals", weights: { text: 0.5, recency: 1.0 } })

// AI agent: "find products similar to this one but cheaper"
search({ query: productDescription, weights: { text: 1.0, price: 0.8, rating: 0.3 } })
```

### Step 4: Docker Compose for Superlinked Server

```yaml
# docker-compose.superlinked.yml
services:
  superlinked:
    image: superlinkedai/superlinked-server:latest
    ports:
      - 8080:8080
    environment:
      - SUPERLINKED_EXPOSE_PII=false
    volumes:
      - ./superlinked:/app/config
    depends_on:
      - redis

  redis:
    image: redis:7-alpine
    ports:
      - 6379:6379
```

### Step 5: Integration with Commerce Config

```typescript
import { defineConfig } from "@unifiedcommerce/core";
import { superlinkedAdapter } from "@unifiedcommerce/adapter-superlinked";

export default defineConfig({
  search: {
    adapter: superlinkedAdapter({
      serverUrl: "http://localhost:8080",
      textModel: "Alibaba-NLP/gte-large-en-v1.5",
      weights: { text: 1.0, price: 0.3, rating: 0.5, recency: 0.2 },
    }),
  },
});
```

## How It Differs from Current Adapters

| Feature | Meilisearch | PG Full-Text | Superlinked |
|---------|-------------|--------------|-------------|
| Keyword matching | Yes | Yes | Yes (via text embedding) |
| Semantic understanding | No | No | Yes — "comfortable" matches "cotton" |
| Multi-signal ranking | No (filter only) | No | Yes — text + price + rating in one score |
| Personalization | No | No | Yes — encode user behavior |
| Natural language queries | No | No | Yes — LLM parses intent into weights |
| Query-time weight tuning | No | No | Yes — adjust signals per query |
| Agent-friendly | Limited | Limited | Built for AI agents |
| Infrastructure | Meilisearch server | PostgreSQL (already have) | Superlinked server + vector DB |
| Latency | ~5ms | ~10ms | ~50-100ms (embedding + search) |

## Dependencies

| Package | Purpose |
|---------|---------|
| `@unifiedcommerce/adapter-superlinked` | TypeScript adapter (HTTP client) |
| `superlinked` (Python) | Server-side framework |
| Redis / MongoDB / Qdrant | Vector storage backend |

## Considerations

- Superlinked is Python-based — requires a separate Python process alongside the Node.js engine
- Embedding model download on first run (~500MB for gte-large)
- Higher latency than keyword search (~50-100ms vs ~5ms) — compensated by better relevance
- Requires vector DB infrastructure (Redis is the simplest option)
- The `SearchAdapter` interface may need extending for weight parameters — consider adding an optional `weights` field to `SearchQueryParams`

## Research Links

- GitHub: https://github.com/superlinked/superlinked
- Docs: https://docs.superlinked.com
- E-commerce use case: https://github.com/superlinked/superlinked/tree/main/notebook/use_cases/e_commerce
- Vector DB comparison: https://superlinked.com/vector-db-comparison
