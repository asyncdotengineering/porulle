# @porulle/adapter-neon

Workers-grade Neon `DatabaseAdapter` for `@porulle/core`.

Two transports, picked by query type — the design proven in production by
porulle's first adopter (a live iPad POS on Cloudflare Workers + Neon):

1. **Plain queries** go through `@neondatabase/serverless` HTTP — stateless,
   no socket-reuse races across Workers isolates.
2. **`transaction()`** creates a fresh client per call and closes it before the
   request completes. Direct Neon connections use a WebSocket `Pool`;
   Hyperdrive connections use Postgres.js over Workers TCP. This distinction is
   required because Neon WebSocket clients cannot speak to Hyperdrive's TCP
   endpoint. `drizzle-orm/neon-http` cannot run interactive transactions.

## Usage

```ts
import { defineConfig } from "@porulle/core";
import { neonAdapter } from "@porulle/adapter-neon";

export default defineConfig({
  databaseAdapter: neonAdapter({
    connectionString: env.DATABASE_URL, // direct Neon URL
    // Optional: route transactions through Hyperdrive using Postgres.js
    hyperdrive: env.HYPERDRIVE,
  }),
  // ...
});
```

- `connectionString` — direct Neon URL (`postgresql://...neon.tech/...`).
  Used by the HTTP driver, and by transaction pools when no Hyperdrive
  binding is given.
- `hyperdrive` — optional Cloudflare Hyperdrive binding (any object exposing
  `connectionString`). When set, transactions use a fresh Postgres.js client
  over Hyperdrive; plain queries keep using Neon HTTP against
  `connectionString`.

`.execute()` results are normalized to the postgres-js shape (an array of
rows), matching what `@porulle/core` and custom routes expect.
