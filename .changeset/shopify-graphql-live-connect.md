---
"@porulle/core": minor
"@porulle/adapter-shopify": minor
"@porulle/adapter-woocommerce": minor
"@porulle/plugin-channel-connector": minor
---

Breaking: connect real Shopify stores end to end.

**`@porulle/adapter-shopify` is GraphQL-only, on Admin API 2026-10.** Shopify made REST legacy, deprecated its product and variant endpoints in 2024-04, and requires public apps to use GraphQL and expiring offline tokens. The connector now:

- runs OAuth as the authorization code grant with `expiring=1`, refuses a grant missing a required scope, and refreshes the one-hour token through `liveCredentials` (rotating refresh token);
- imports catalogue pages, re-reads products by id (`fetchCatalogItems`), reads inventory, the store profile, and creates paid orders (`orderCreate`, deduplicated on `sourceIdentifier`), all via GraphQL, with throttle-aware retries;
- reports `storefrontUrl` from `onlineStoreUrl`, never a guessed URL;
- takes `{ clientId, clientSecret, fetchImpl?, shopOrigin? }`. `appUrl`, `apiVersion`, `scopes` and `baseUrl` are gone; `shopOrigin(shop)` replaces `baseUrl` so a stand-in still sees the shop in the request.
- `REQUIRED_SCOPES` is `read_products, write_products, read_inventory, write_orders`. `pushCatalog` (REST) and the push-catalog exports are removed; `registerWebhooks` is removed — Shopify subscriptions are app-level, declared in `shopify.app.toml`.

**`@porulle/core` `ChannelConnector`:** new optional `normalizeStoreDomain`, `liveCredentials`, `fetchStoreProfile`, `fetchCatalogItems`; `verifyWebhook` is optional; `verifyAppWebhook` returns `{ id, topic, shopDomain, data }`; `ChannelCatalogItem.storefrontUrl`; `ChannelOrderSlice.customer.shippingAddress` is a typed `ChannelOrderAddress` (`line1`, `region`, `postalCode`, ISO `countryCode`, …) instead of a provider-spelled record.

**`@porulle/plugin-channel-connector`:**

- every connector is wrapped with live credentials (compare-and-swap persistence; a refused grant marks the store `error`); `resolveLiveCredentials` and `service.liveStore()` serve host-side Admin API calls;
- new `channels:connect` permission for OAuth start and disconnect; OAuth state carries the starting user; the callback lands the browser on `postConnectRedirect?connected=<id>` or `?connect_error=<code>&connect_message=…`; single use is recorded in the database only;
- `connectStore(orgId, input, actor)` refreshes an existing row for the same shop instead of adding a second, and runs `bindConnectedStore` in the same transaction and `afterStoreConnected` after commit;
- per-store webhook registration uses an absolute address on the new `publicUrl` option (relative addresses were refused by providers);
- `POST /api/channels/app-webhooks/{provider}` replaces `/compliance/{provider}`: verifies, deduplicates on the delivery id, and queues `channel/apply-webhook`. Product webhooks re-read the product and converge it (creating it if new), then call `onStoreCatalogChanged`; stock webhooks read the variant's summed stock; `orders/*` match their order by the payload's own id;
- `confineStoreReads` is renamed `confineStores` and also confines get, disconnect and reconcile-status.

**`@porulle/adapter-woocommerce`:** maps `ChannelOrderAddress` to WooCommerce's `shipping`/`billing` spelling (`address_1`, `postcode`, …).

Migration: pass `clientId`/`clientSecret` (and `shopOrigin` for a stand-in) to `shopifyConnector`; rename `confineStoreReads` → `confineStores`; set `publicUrl`; grant merchants `channels:connect`; write order addresses as `ChannelOrderAddress`; point Shopify's app webhooks at `/api/channels/app-webhooks/shopify`.
