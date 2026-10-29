---
"@porulle/core": minor
---

Load heavy module-scope work on first use instead of at import. `createServer` and `createCommerce` now import their implementation (kernel, REST routes and their zod schemas, Hono, better-auth setup) when first called, and `@porulle/core` declares `"sideEffects": false` so a bundler drops what a consumer never uses. A Cloudflare Worker that bundles core no longer pays that module-init CPU at upload time (Cloudflare refuses an upload whose startup exceeds 1 s). Public API and behaviour are unchanged; the two factories were already async.
