---
"@porulle/adapter-shopify": minor
---

Let a caller point the Shopify adapter at a different origin, and read RFC 8288's bare `rel` token

`ShopifyConnectorOptions.baseUrl` overrides the origin for every Shopify call — the Admin API and
both OAuth endpoints. Absent, it resolves to `https://{store.storeDomain}` and the request is
byte-identical to the one this adapter has always made, so no existing caller sees a difference.

It is an ORIGIN rather than a base URL because Shopify's host is per-store: the shop still rides
inside the path the adapter appends. A caller pointing at a local stand-in passes
`http://127.0.0.1:<port>/shopify` and the stand-in serves Shopify's own address table unprefixed.

There is deliberately no `mock` flag and no URL rewriting inside `fetchImpl`. The shipped path must
be the tested path; a branch inside the adapter means the code a test exercises is not the code that
runs, and reaching a stand-in by rewriting URLs inside an injected fetch is the same failure wearing
a hook.

The `Link` header's pagination relation is now read as a quoted string OR a bare token, both of
which RFC 8288 permits. The argument is the asymmetry rather than the likelihood: a reader that
accepts only `rel="next"` and meets `rel=next` does not throw — it finds no next link, ends the
walk, and reports a SUCCESSFUL import of a partial catalogue. Accepting both cannot make a malformed
header parse as a valid one, so the permissive direction has no matching cost.
