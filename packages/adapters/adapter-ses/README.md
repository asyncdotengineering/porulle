# @porulle/adapter-ses

Transactional email via [AWS SES v2](https://docs.aws.amazon.com/ses/latest/dg/Welcome.html).

## Usage

```ts
import { defineConfig } from "@porulle/core";
import { sesEmailAdapter } from "@porulle/adapter-ses";

export default defineConfig({
  email: {
    send: sesEmailAdapter({
      region: "us-east-1",
      from: "Acme Store <orders@acme.com>",      // must be a verified SES identity
      credentials: {                              // optional — falls back to AWS credential chain
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
      subjects: { "order-confirmation": (d) => `Order ${d.orderNumber}` },
      templates: { "order-confirmation": (d) => `<p>Thanks!</p>` },
    }),
  },
  // …
});
```

## Notes

- The `from` address must be a verified identity in SES (domain or address). If you're in the SES sandbox, all recipients must be verified too.
- Credentials are optional — the adapter uses the default AWS credential chain (env vars, IAM role, profile) if `credentials` is omitted.
- For Workers / non-Node runtimes, prefer `@porulle/adapter-resend` (the AWS SDK isn't worker-friendly).

## See also

- [AWS SES v2 API reference](https://docs.aws.amazon.com/ses/latest/APIReference-V2/Welcome.html)
- `@porulle/adapter-resend` — simpler, edge-friendly alternative
