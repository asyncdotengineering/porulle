---
"@porulle/adapter-local-storage": patch
"@porulle/adapter-meilisearch": patch
"@porulle/adapter-neon": patch
"@porulle/adapter-pg-search": patch
"@porulle/adapter-pglite": patch
"@porulle/adapter-postgres": patch
"@porulle/adapter-r2": patch
"@porulle/adapter-resend": patch
"@porulle/adapter-s3": patch
"@porulle/adapter-ses": patch
"@porulle/adapter-shopify": patch
"@porulle/adapter-stripe": patch
"@porulle/adapter-tax-manual": patch
"@porulle/adapter-taxjar": patch
"@porulle/adapter-woocommerce": patch
"@porulle/core": patch
"@porulle/import-flat": patch
"@porulle/import-shopify": patch
"@porulle/import-woocommerce": patch
"@porulle/jobs-cloudflare": patch
"@porulle/jobs-inngest": patch
"@porulle/jobs-pg-boss": patch
"@porulle/jobs-trigger": patch
"@porulle/plugin-appointments": patch
"@porulle/plugin-channel-connector": patch
"@porulle/plugin-giftcards": patch
"@porulle/plugin-layaway": patch
"@porulle/plugin-loyalty": patch
"@porulle/plugin-marketplace": patch
"@porulle/plugin-notifications": patch
"@porulle/plugin-pos": patch
"@porulle/plugin-pos-restaurant": patch
"@porulle/plugin-procurement": patch
"@porulle/plugin-production": patch
"@porulle/plugin-reviews": patch
"@porulle/plugin-scheduled-orders": patch
"@porulle/plugin-uom": patch
"@porulle/plugin-warehouse": patch
"@porulle/plugin-wishlist": patch
"@porulle/sdk": patch
---

**Breaking: package exports are rebuilt so every loader resolves them.** In 0.65.0 most packages exported their root entry under `import` only, so `require()` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`. drizzle-kit loads schema files through `require()`, so a schema importing a plugin failed while drizzle-kit still exited 0 and generated nothing. Every export entry is now `{ "@porulle/source": src, "types": dist .d.ts, "default": dist .js }`, and `./package.json` is exported.

- `require()` and `import()` both load every entry. The packages are ESM. `require()` of ESM needs Node ≥ 20.19 or ≥ 22.12, so `engines.node` is now `>=20.19.0`.
- Types come from the published `dist/*.d.ts`, not from `src/*.ts`.
- The `bun` condition is gone. Bun loads `dist` like Node does. Inside this monorepo the source entry is the namespaced `@porulle/source` condition, enabled by `customConditions` in tsconfig.
- The release now runs `scripts/check-package-exports.mjs` between build and publish. It resolves and loads every entry through `require()` and `import()`, and runs `publint --strict` and `attw`.
