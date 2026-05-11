# @porulle/adapter-s3

`StorageAdapter` for AWS S3 (or any S3-compatible bucket — DigitalOcean Spaces, MinIO, Backblaze B2 with the right `endpoint`).

## Usage

```ts
import { defineConfig } from "@porulle/core";
import { s3StorageAdapter } from "@porulle/adapter-s3";

export default defineConfig({
  storage: s3StorageAdapter({
    bucket: "acme-media",
    region: "us-east-1",
    publicBaseUrl: "https://media.acme.com",     // CDN or static.acme.com
    signedUrlExpiresIn: 3600,                     // 1 hour
    credentials: {                                // optional — falls back to AWS credential chain
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  }),
  // …
});
```

For S3-compatible providers, set `endpoint` and `forcePathStyle`:

```ts
s3StorageAdapter({
  bucket: "acme-media",
  region: "us-east-1",
  endpoint: "https://nyc3.digitaloceanspaces.com",
  forcePathStyle: true,
  // …
});
```

## What it implements

`upload`, `getUrl` (returns `publicBaseUrl/<key>`), `getSignedUrl` (presigned GET via `@aws-sdk/s3-request-presigner`), `delete`, `list` (paginated via `ListObjectsV2`).

## Notes

- Bring your own AWS SDK config — the adapter doesn't override credential resolution; it uses `@aws-sdk/client-s3` defaults if you omit `credentials`.
- The `client` and `signUrl` options exist for unit tests; production code should leave them unset.

## See also

- `@porulle/adapter-r2` — Cloudflare R2 (no AWS SDK, lighter)
- [`SECURITY.md`](../../../SECURITY.md) — media-upload MIME validation is enforced in `@porulle/core`
