# @porulle/adapter-local-storage

`StorageAdapter` that writes to the local filesystem. Useful for development and single-node deployments. **Not for production** unless you've thought hard about backups, disk pressure, and multi-instance behavior — use S3 or R2 there.

## Usage

```ts
import { defineConfig } from "@porulle/core";
import { localStorageAdapter } from "@porulle/adapter-local-storage";

export default defineConfig({
  storage: localStorageAdapter({
    basePath: "./.data/media",
    baseUrl: "http://localhost:4000/assets",
  }),
  // …
});
```

Then serve the `basePath` directory at `baseUrl` (the example apps mount Hono's `serveStatic` for `/assets/*`).

## Path-traversal protection

Every key passes through `resolveSafePath()` which:

- Resolves the key against `basePath`
- Verifies the result stays inside `basePath`
- Rejects `..`, NUL bytes, absolute paths, and any input that would escape the storage root

This closed a CVE-class arbitrary-file-write surface (a key like `../../../../etc/passwd` would otherwise write outside the storage root). See `packages/core/test/` for the regression tests.

## What it implements

`upload`, `getUrl`, `getSignedUrl`, `delete`, `list` — all return `Result<T>`.

## See also

- [`SECURITY.md`](../../../SECURITY.md) — storage hardening
- `@porulle/adapter-s3`, `@porulle/adapter-r2` — production storage adapters
