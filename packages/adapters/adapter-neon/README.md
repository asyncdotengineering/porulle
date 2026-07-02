# @porulle/adapter-neon

Workers-grade Neon `DatabaseAdapter` for `@porulle/core`.

Two transports, picked by query type — the design proven in production by
porulle's first adopter (a live iPad POS on Cloudflare Workers + Neon):

1. **Plain queries** go through `@neondatabase/serverless` HTTP — stateless,
   no socket-reuse races across Workers isolates.
2. **`transaction()`** creates a fresh WebSocket `Pool` per call, runs the
   transaction, then ends the pool. `drizzle-orm/neon-http` cannot run
   transactions, and isolate-shared WebSocket pools flake when reused across
   requests; a short-lived pool per transaction gives atomicity without the
   flake.

## Usage

```ts
import { defineConfig } from "@porulle/core";
import { neonAdapter } from "@porulle/adapter-neon";

export default defineConfig({
  databaseAdapter: neonAdapter({
    connectionString: env.DATABASE_URL, // direct Neon URL
    // Optional: route per-transaction pools through Hyperdrive
    hyperdrive: env.HYPERDRIVE,
  }),
  // ...
});
```

- `connectionString` — direct Neon URL (`postgresql://...neon.tech/...`).
  Used by the HTTP driver, and by transaction pools when no Hyperdrive
  binding is given.
- `hyperdrive` — optional Cloudflare Hyperdrive binding (any object exposing
  `connectionString`). When set, per-transaction pools connect through it;
  plain queries keep using the Neon HTTP driver against `connectionString`.

`.execute()` results are normalized to the postgres-js shape (an array of
rows), matching what `@porulle/core` and custom routes expect.
