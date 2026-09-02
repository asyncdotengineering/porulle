---
"@porulle/adapter-shopify": minor
"@porulle/core": minor
---

Write product images on Shopify catalog push.

`pushCatalog` refused any item carrying `images` with
`SHOPIFY_IMAGES_NOT_WRITTEN`, so media attached through `MediaService` could
never reach the Shopify product. The adapter now creates or updates product
images through the Admin REST API: the `primary` image is written first at
position 1, the rest follow `sortOrder`, `alt` and `variantExternalIds` map to
`alt` and `variant_ids`, and `video` / `document` roles fail the item with
`SHOPIFY_IMAGE_ROLE_UNSUPPORTED`.

`ChannelPushCatalogItemOutcome` gains `images?: ChannelPushCatalogImageOutcome[]`
— one entry per image with `ok`, the Shopify image id as `externalId`, and the
error when a write failed. Persist that id and send it back as
`image.externalId` to update in place; without it the adapter matches by the
uploaded file name against Shopify's CDN path before creating a new image.

Callers that treated `SHOPIFY_IMAGES_NOT_WRITTEN` as the signal to fall back to
a manual upload should read the per-image outcomes instead.
