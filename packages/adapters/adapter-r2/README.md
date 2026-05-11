# @porulle/adapter-r2

`StorageAdapter` for [Cloudflare R2](https://developers.cloudflare.com/r2/), specifically when running on **Cloudflare Workers**. The adapter receives the R2 binding directly — no AWS SDK, no credentials in env.

## Usage (Workers)

```ts
import { r2StorageAdapter } from "@porulle/adapter-r2";

// In a Workers fetch handler:
export default {
  async fetch(request: Request, env: Env) {
    const config = defineConfig({
      storage: r2StorageAdapter({
        bucket: env.MEDIA_BUCKET,         // R2 binding
        publicBaseUrl: "https://media.acme.com",
      }),
      // …
    });
    const { app } = await createServer(config);
    return app.fetch(request, env);
  },
};
```

## Why a separate adapter from S3

R2 is API-compatible with S3, but on Workers you bypass the SDK entirely — the binding is a native object with `put`, `get`, `delete`, `list`. Using `@porulle/adapter-s3` on Workers would bundle the AWS SDK (~500KB), eat CPU on cold start, and force you to handle credentials. `@porulle/adapter-r2` is a few hundred lines and zero deps.

## Outside Workers

If you're consuming R2 from Node, use `@porulle/adapter-s3` with R2's S3 endpoint:

```ts
s3StorageAdapter({
  bucket: "acme-media",
  region: "auto",
  endpoint: "https://<account>.r2.cloudflarestorage.com",
  // …
});
```

## What it implements

`upload`, `getUrl`, `delete`, `list`. Signed URLs aren't supported by the binding directly — generate via `R2Bucket.createPresignedUrl()` outside the adapter if needed.

## See also

- [Cloudflare R2 docs](https://developers.cloudflare.com/r2/)
- `@porulle/adapter-s3` — for non-Workers consumption
