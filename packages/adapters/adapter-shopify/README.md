# @porulle/adapter-shopify

Shopify ingress channel connector for Porulle.

## Catalog push and re-authorisation

Catalog push requires the `write_products` OAuth scope. The adapter advertises
`capabilities.pushCatalog: true`, but effective push access is resolved per
store from `credentials.grantedScopes` recorded during OAuth (`completeAuth`).

Stores connected before `write_products` was added to `REQUIRED_SCOPES` hold
tokens without that scope. When push is attempted, the adapter returns
`SHOPIFY_WRITE_PRODUCTS_SCOPE_MISSING` with `retriable: false` and a link to
Porulle's OAuth start route (when `appUrl` is configured).

Operators can recover without disconnecting the store:

1. Start Shopify OAuth again for the same store (`/api/channels/oauth/shopify/start` in a Porulle app with this adapter configured).
2. Approve the updated scope list, which now includes `write_products`.
3. Retry the catalog push job.

Use `shopifyReauthorizeUrl(options, params)` to build the authorize URL outside
the push error path, or `shopifyPushCatalogEnabled(store)` to check scope
coverage before enqueueing work.
