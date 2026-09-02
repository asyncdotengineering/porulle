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

## Product images

`pushCatalog` writes `item.images` to the product's images through the Admin
REST API (`/products/{id}/images.json`). Roles `primary`, `gallery` and
`thumbnail` are written as images; `video` and `document` fail the item with
`SHOPIFY_IMAGE_ROLE_UNSUPPORTED`. The `primary` image is written first and
takes position 1, the rest follow `sortOrder`; `alt` and `variantExternalIds`
map to the image's `alt` and `variant_ids`.

Each item outcome carries `images[]` with the Shopify image id as
`externalId`. Persist it and send it back as `image.externalId` on the next
push so the adapter updates that image in place. Without an id the adapter
falls back to matching the uploaded file name against the CDN path Shopify
keeps (`boot.jpg` matches `boot.jpg` and `boot_a1b2c3.jpg`); a file name that
matches nothing creates a new image. Dry runs do not touch images.
