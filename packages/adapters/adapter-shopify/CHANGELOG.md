# @porulle/adapter-shopify

## 0.74.4

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.74.4

## 0.74.3

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.74.3

## 0.74.2

### Patch Changes

- Updated dependencies [[`162c4ad`](https://github.com/asyncdotengineering/porulle/commit/162c4ad92de86515f838fa9ff51b8c7cc275c3be)]:
  - @porulle/core@0.74.2

## 0.74.1

### Patch Changes

- Updated dependencies [[`b00ab8d`](https://github.com/asyncdotengineering/porulle/commit/b00ab8d6b7fef07fe69b3a46b5723a3f9dd950d0)]:
  - @porulle/core@0.74.1

## 0.74.0

### Minor Changes

- [#179](https://github.com/asyncdotengineering/porulle/pull/179) [`5234288`](https://github.com/asyncdotengineering/porulle/commit/52342881291d7998c5f23b8c43d0e521836bc3b3) Thanks [@octalpixel](https://github.com/octalpixel)! - Real WooCommerce stores, and store webhooks decoded by their connector.

  - **Core channels contract.** A connector now decodes its own deliveries into provider-neutral `ChannelEvent`s (`decodeWebhook`), declares the topics it subscribes a store to (`webhookTopics`), can remove its subscriptions (`unregisterWebhooks`), check and repair them (`webhookHealth`), and answer an order's current state as events (`orderEvents`). `verifyWebhook` may answer `Ok(null)` for a delivery to acknowledge without acting on (a subscription ping). `completeAuth` receives the `state` it was started with. New code `CHANNEL_TOTAL_MISMATCH`; store status `connecting`.
  - **Channel plugin.** `handleWebhook` acts on `ChannelEvent`s only — no Shopify topic or payload field reaches it — and reports a delivery its connector does not map as `processed: false`. The per-store webhook route answers 200 for anything verified and applies it as a `channel/apply-webhook` job, deduplicated per store. A WooCommerce key callback is saved and answered at once and finished by `channel/complete-connect`; the browser's return lands on the store, and a merchant's "deny" on a message saying so. Disconnect removes the store's subscriptions. New: `POST /stores/{id}/health` (on a merchant's visit, at most every 10 minutes), `refreshStaleRemoteOrders` + `channel/refresh-order` for read points, store columns `status_reason`, `health`, `last_event_at`, export column `remote_checked_at`. A product change read fresh now reports skipped and conflicting fields in the store's reconcile report (it reported only warnings). The payload-converge webhook path, which no real connector reached, is removed.
  - **Shopify adapter.** Decodes its own webhooks (`decodeWebhook`); a stock delivery's inventory item is resolved to its variant and summed stock by `inventoryItem { variant }`.
  - **WooCommerce adapter, rewritten against WooCommerce 11.1.2.** https-only store URLs (sub-directory installs kept, private hosts refused), Basic-header auth with query-string fallback learned once and persisted, firewall pages and revoked keys classified, every answer parsed. Imports simple products as one priced variant with sale/compare-at prices, permalinks and variation images; skips grouped and external products; reads stock per variation including untracked products. Orders go in at exactly the shopper's total (zero-rate lines, discount allocated, delivery as a shipping line), are found by our meta key before any create (no duplicates on retry), are refused when the store lacks the stock, and are cancelled again if the store oversold or totalled them differently. Store cancels, fulfilments with tracking (native fulfilments, Shipment Tracking, meta, or status only) and refunds decode to events; a cancel at the store restocks.

### Patch Changes

- Updated dependencies [[`5234288`](https://github.com/asyncdotengineering/porulle/commit/52342881291d7998c5f23b8c43d0e521836bc3b3)]:
  - @porulle/core@0.74.0

## 0.73.3

### Patch Changes

- [#178](https://github.com/asyncdotengineering/porulle/pull/178) [`7577885`](https://github.com/asyncdotengineering/porulle/commit/757788525ccc8335e28bacc9aa69371aee3cec18) Thanks [@octalpixel](https://github.com/octalpixel)! - Read live Shopify's stock refusal as out of stock. Shopify (2026-10, measured) refuses an `orderCreate` it cannot reserve stock for with `code: INVALID`, `field: ["order","lineItems"]`, "Line items Unable to reserve inventory" — not the documented `INVENTORY_CLAIM_FAILED`. The adapter now answers `CHANNEL_OUT_OF_STOCK` for either, so the marketplace cancels the order and refunds the shopper instead of leaving a paid order whose export failed.

- Updated dependencies []:
  - @porulle/core@0.73.3

## 0.73.2

### Patch Changes

- [#177](https://github.com/asyncdotengineering/porulle/pull/177) [`80be680`](https://github.com/asyncdotengineering/porulle/commit/80be680ea5cd587230a7a61ad73f5f26cf1c3f84) Thanks [@octalpixel](https://github.com/octalpixel)! - Shopify returns carry a reason. Live Shopify (2026-10) refuses a `returnRequest` line with no reason ("Return reason can't be blank") although the schema marks it optional. `requestReturn` now resolves the shopper's reason to Shopify's reason library by handle ("Too small" → `too-small`), falling back to `other-reason`, and sends it as `returnReasonDefinitionId` on every line.

- Updated dependencies []:
  - @porulle/core@0.73.2

## 0.73.1

### Patch Changes

- [#176](https://github.com/asyncdotengineering/porulle/pull/176) [`2554f7c`](https://github.com/asyncdotengineering/porulle/commit/2554f7c1d164ddb0b295b9da9279478212ebbe31) Thanks [@octalpixel](https://github.com/octalpixel)! - Ask for `read_returns` and `write_returns` when a store connects, which returns need.

- Updated dependencies []:
  - @porulle/core@0.73.1

## 0.73.0

### Minor Changes

- [#175](https://github.com/asyncdotengineering/porulle/pull/175) [`740dd11`](https://github.com/asyncdotengineering/porulle/commit/740dd11e8552eb346380a6fe4b5f008ebfa6e891) Thanks [@octalpixel](https://github.com/octalpixel)! - Returns. Connectors gain an optional `requestReturn` (Shopify: the order's fulfilment lines are matched by variant and `returnRequest` asks the store to take them back, with the shopper's reason as the customer note). The channel connector's `requestReturn(orgId, orderId, { lines, reason, note })` names each line by the store's own variant id, refuses a line the store has no record of before asking anything, and records the return in `channel_returns`; `returns/approve|decline|close|cancel|reopen` move it. The refund arrives on `refunds/create` as before.

### Patch Changes

- Updated dependencies [[`740dd11`](https://github.com/asyncdotengineering/porulle/commit/740dd11e8552eb346380a6fe4b5f008ebfa6e891)]:
  - @porulle/core@0.73.0

## 0.72.0

### Minor Changes

- [`df5b5f7`](https://github.com/asyncdotengineering/porulle/commit/df5b5f78a831a0622c5acf955bd794ce07ceb280) Thanks [@octalpixel](https://github.com/octalpixel)! - Send a discounted order's discount to the store. `ChannelOrderSlice.discount` carries the code the shopper used (`DISCOUNT` when none was typed) and the amount, when the slice is the whole order, and the slice total has it taken off. Shopify receives it as `discountCode.itemFixedDiscountCode`, so the store's total equals what the shopper paid.

### Patch Changes

- Updated dependencies [[`df5b5f7`](https://github.com/asyncdotengineering/porulle/commit/df5b5f78a831a0622c5acf955bd794ce07ceb280)]:
  - @porulle/core@0.72.0

## 0.71.0

### Minor Changes

- [#173](https://github.com/asyncdotengineering/porulle/pull/173) [`7b19139`](https://github.com/asyncdotengineering/porulle/commit/7b191394ea3a81759e29311c644b0293df0b3d2d) Thanks [@octalpixel](https://github.com/octalpixel)! - A store refusing an order for stock now cancels the platform order. Connectors answer `CHANNEL_OUT_OF_STOCK` for that refusal (Shopify: `orderCreate`'s `INVENTORY_CLAIM_FAILED`); the channel connector fails the export for good and cancels the order, so the host's cancel path refunds the shopper. Any other refusal still waits for an operator.

### Patch Changes

- Updated dependencies [[`7b19139`](https://github.com/asyncdotengineering/porulle/commit/7b191394ea3a81759e29311c644b0293df0b3d2d)]:
  - @porulle/core@0.71.0

## 0.70.2

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.70.2

## 0.70.1

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.70.1

## 0.70.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.70.0

## 0.69.0

### Minor Changes

- [#169](https://github.com/asyncdotengineering/porulle/pull/169) [`6d42ee6`](https://github.com/asyncdotengineering/porulle/commit/6d42ee6bb797f034839f9f63f45664573b4a155d) Thanks [@octalpixel](https://github.com/octalpixel)! - Cancel channel orders in both directions. Connectors gain an optional `cancelOrder` (Shopify: `orderCancel`, restocking, refunding nothing at the store, notifying no one), and a store refusal answers `CHANNEL_CANCEL_REFUSED`. The channel connector cancels at the store before the platform cancels, so a store that has shipped blocks the cancel; a store's `orders/cancelled` cancels the platform order without cancelling back; an order cancelled before its push ran is never pushed.

### Patch Changes

- Updated dependencies [[`6d42ee6`](https://github.com/asyncdotengineering/porulle/commit/6d42ee6bb797f034839f9f63f45664573b4a155d)]:
  - @porulle/core@0.69.0

## 0.68.4

### Patch Changes

- [#168](https://github.com/asyncdotengineering/porulle/pull/168) [`51e3a25`](https://github.com/asyncdotengineering/porulle/commit/51e3a2585bd5a17d32c6b2638111fe85030b2c35) Thanks [@octalpixel](https://github.com/octalpixel)! - Send the order's delivery charge to the merchant's store. `ChannelOrderSlice` gains an optional `shipping`, filled when the slice is the whole order and the charge is above zero, and `grandTotal` now includes it. The Shopify adapter sends it as a `shippingLines` entry, so the order total matches the payment. Found on a real store: the shopper paid Rs 24,900 + Rs 350 delivery, and the merchant's order read Rs 24,900 with no shipping line. An order split across stores still carries no shipping, because one charge cannot be divided honestly.

- Updated dependencies [[`51e3a25`](https://github.com/asyncdotengineering/porulle/commit/51e3a2585bd5a17d32c6b2638111fe85030b2c35)]:
  - @porulle/core@0.68.4

## 0.68.3

### Patch Changes

- Updated dependencies [[`8e81888`](https://github.com/asyncdotengineering/porulle/commit/8e8188840dd4da549b8917919554bddb24fa9e75)]:
  - @porulle/core@0.68.3

## 0.68.2

### Patch Changes

- [#166](https://github.com/asyncdotengineering/porulle/pull/166) [`6b1e062`](https://github.com/asyncdotengineering/porulle/commit/6b1e06204fb31ae69401571730dae798de9168d8) Thanks [@octalpixel](https://github.com/octalpixel)! - Mark every exported order line `requiresShipping: true`. Shopify's `orderCreate` defaults it to false, so a real store showed each pushed order as "Shipping not required" although it carried the shopper's address, and the merchant could not ship it the normal way. The workerd test now pushes an order and asserts what Shopify receives.

- Updated dependencies []:
  - @porulle/core@0.68.2

## 0.68.1

### Patch Changes

- [#165](https://github.com/asyncdotengineering/porulle/pull/165) [`73ea076`](https://github.com/asyncdotengineering/porulle/commit/73ea0768eec7d525f245eb44ce95d8a8b499fc50) Thanks [@octalpixel](https://github.com/octalpixel)! - Call `fetch` unbound on Cloudflare Workers. The Shopify adapter called its fetch as `target.fetchImpl(...)` and core's webhook delivery as `this.fetchImpl(...)`; workerd's global `fetch` throws "Illegal invocation" for any `this` but the global scope, so every Admin API call (store profile, import, orders) failed on a Worker while every Node test passed. The adapter now carries a workerd test that runs it with the runtime's own `fetch`.

- Updated dependencies [[`73ea076`](https://github.com/asyncdotengineering/porulle/commit/73ea0768eec7d525f245eb44ce95d8a8b499fc50)]:
  - @porulle/core@0.68.1

## 0.68.0

### Minor Changes

- [#164](https://github.com/asyncdotengineering/porulle/pull/164) [`abb4c23`](https://github.com/asyncdotengineering/porulle/commit/abb4c23d151df9fe6f050ce91292b1829deeacc0) Thanks [@octalpixel](https://github.com/octalpixel)! - Breaking: recover from a credential the provider retires early; refuse an owned shop before OAuth; level stock on a first reconcile.

  - `@porulle/core` exports `CHANNEL_CREDENTIALS_REJECTED`, and `liveCredentials(store, { force })` may be asked to refresh regardless of the stated expiry.
  - `@porulle/adapter-shopify` answers a 401/403 from the Admin API with `CHANNEL_CREDENTIALS_REJECTED` (was `SHOPIFY_UNAUTHORIZED`) and refreshes on `force`.
  - `@porulle/plugin-channel-connector` retries a call rejected that way ONCE on credentials refreshed by force; a second rejection is the answer, and a refused refresh marks the store for reconnection. `ConnectClaims` receives the canonical `storeDomain`, and OAuth start resolves claims AFTER normalising the shop and BEFORE redirecting — a provider such as Shopify retires a shop's other grants as soon as a new one is issued, so a refusal must happen before the merchant reaches the consent screen.
  - Fix: `reconcile` levelled stock against the mappings it read before converging, so a reconcile that imported products for the first time left them with no inventory level. It now levels against the mappings after convergence.
  - Fix: the editor convergence path (every reconcile) created and updated variants without their `metadata`, so a reconciled variant lost the provider facts the import fast path keeps — Shopify's inventory item id (what a stock webhook resolves its variant by) and the weight shipping prices by. Variant metadata now merges per key on every path; an unchanged variant writes nothing. An unchanged reconcile keeps its statement budget: mappings are re-read for stock levelling only when convergence wrote something.

### Patch Changes

- Updated dependencies [[`abb4c23`](https://github.com/asyncdotengineering/porulle/commit/abb4c23d151df9fe6f050ce91292b1829deeacc0)]:
  - @porulle/core@0.68.0

## 0.67.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.67.0

## 0.66.0

### Minor Changes

- [#162](https://github.com/asyncdotengineering/porulle/pull/162) [`9f3af48`](https://github.com/asyncdotengineering/porulle/commit/9f3af484b356975ae32fcfe62043bf456a851e4a) Thanks [@octalpixel](https://github.com/octalpixel)! - Breaking: connect real Shopify stores end to end.

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

### Patch Changes

- Updated dependencies [[`9f3af48`](https://github.com/asyncdotengineering/porulle/commit/9f3af484b356975ae32fcfe62043bf456a851e4a)]:
  - @porulle/core@0.66.0

## 0.65.1

### Patch Changes

- [#161](https://github.com/asyncdotengineering/porulle/pull/161) [`488db7b`](https://github.com/asyncdotengineering/porulle/commit/488db7b089af397be850589fe9a60617280a93ff) Thanks [@octalpixel](https://github.com/octalpixel)! - **Breaking: package exports are rebuilt so every loader resolves them.** In 0.65.0 most packages exported their root entry under `import` only, so `require()` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`. drizzle-kit loads schema files through `require()`, so a schema importing a plugin failed while drizzle-kit still exited 0 and generated nothing. Every export entry is now `{ "@porulle/source": src, "types": dist .d.ts, "default": dist .js }`, and `./package.json` is exported.

  - `require()` and `import()` both load every entry. The packages are ESM. `require()` of ESM needs Node ≥ 20.19 or ≥ 22.12, so `engines.node` is now `>=20.19.0`.
  - Types come from the published `dist/*.d.ts`, not from `src/*.ts`.
  - The `bun` condition is gone. Bun loads `dist` like Node does. Inside this monorepo the source entry is the namespaced `@porulle/source` condition, enabled by `customConditions` in tsconfig.
  - The release now runs `scripts/check-package-exports.mjs` between build and publish. It resolves and loads every entry through `require()` and `import()`, and runs `publint --strict` and `attw`.

- Updated dependencies [[`488db7b`](https://github.com/asyncdotengineering/porulle/commit/488db7b089af397be850589fe9a60617280a93ff)]:
  - @porulle/core@0.65.1

## 0.65.0

### Minor Changes

- [#160](https://github.com/asyncdotengineering/porulle/pull/160) [`97dbe39`](https://github.com/asyncdotengineering/porulle/commit/97dbe39674692ea9dbf66df7645b58d727ab3da7) Thanks [@octalpixel](https://github.com/octalpixel)! - **BREAKING.** Removes dead and pass-through surface found by a deletion-test audit, and fixes the bugs that duplication was hiding. Full removal → replacement tables: `docs/migration-0.64-to-0.65.md`.

  Fixes:

  - Webhooks now deliver for `customers.*`, `pricing.*`, `promotions.*`, `inventory.update`, `fulfillment.create` and `cart.addItem`; those modules enqueued into a no-op job queue. `catalog.delete` and `pricing.update` are now emitted at all (their hooks were registered but never fired), so their webhooks and audit entries appear too.
  - `auth.twoFactor.requiredForRoles` is enforced: a member of a listed role (including a composite role such as `"owner,admin"`) without 2FA gets `403 TWO_FACTOR_REQUIRED`, and booting with required roles while two-factor is disabled throws.
  - `adapter-tax-manual` subtracts `orderDiscount` from the taxable base.
  - `import-shopify` / `import-woocommerce` import the whole catalogue (not the first 250 / 100 products) and no longer multiply zero-decimal currencies by 100.
  - Email adapters' default templates escape caller data.
  - `formatAmount`, invoices and receipts honour zero-decimal currencies.
  - Marketplace sub-order errors answer 422 / 404 instead of 500; PGlite transactions queue instead of interleaving, and a call joins only the transaction whose body it runs in.
  - The built-in drizzle jobs engine rejects unknown task slugs at enqueue, like the other engines.

  Removed:

  - `@porulle/db` (use `pgTable` from `@porulle/core/drizzle`), `@porulle/sdk/react` and `createSDK`, the CLI's `migrate`, `generate migration` and `deploy`.
  - From `@porulle/core`: `defineModule` and the module types, `createRepository`, `QueryRegistry` / `executeQuery`, the `access*` combinators, `toHttpError`, the `LocalAPI` class, `canAccessCart`, `BUILTIN_JOB_TASK_SLUGS`, `getTableNames`, `reuseOrCreateTxContext`, `ServiceRegistry`, `CommerceModuleTypes`, `HookRegistry#emit` / `#setLogger` / `#prependInTransaction`, `webhooks.enqueueDelivery`, `analytics.getDashboard` / `.meta()`, `tax.requireConfigured()`, `config.database.options`, `createHookContext`'s `kernel` argument, and `createSystemActor`'s default organization.
  - From `@porulle/core/testing`: `createRepositoryTestHarness`, `createTestPluginContext`, `beforeHook`, `afterHook`.
  - Plugin options nothing read (18 across marketplace, appointments and POS), marketplace contract pricing (its routes and the `marketplace_contract_prices` table), and POS's `createPOSPaymentAdapter`.

  Added: `createTestActor`, `renderEmail`, `escapeHtml`, `currencyExponent`, `toMinorUnits`, `formatAmount`, `prepareEnqueue`, `createPGliteTransaction`, `normalizeExecuteShape`, `CommerceTwoFactorRequiredError`.

### Patch Changes

- Updated dependencies [[`97dbe39`](https://github.com/asyncdotengineering/porulle/commit/97dbe39674692ea9dbf66df7645b58d727ab3da7)]:
  - @porulle/core@0.65.0

## 0.64.0

### Patch Changes

- Updated dependencies [[`dd9c0fb`](https://github.com/asyncdotengineering/porulle/commit/dd9c0fbfb3073307d81253bcf5177f7f2f372b80)]:
  - @porulle/core@0.64.0

## 0.63.0

### Minor Changes

- [#158](https://github.com/asyncdotengineering/porulle/pull/158) [`b79c0f7`](https://github.com/asyncdotengineering/porulle/commit/b79c0f7dae3da2bc6718345520cdea18fc4b4a2f) Thanks [@octalpixel](https://github.com/octalpixel)! - A Shopify `inventory_levels/update` webhook now sets the stock of the variant it concerns. The webhook names an inventory item, whose id differs from the variant id the channel map is keyed by, so every Shopify stock webhook used to find no mapping and be dropped. The Shopify adapter records each variant's `inventoryItemId` in its metadata on import, and the connector resolves the webhook's inventory item to that variant, falling back to the variant-id lookup for providers that send one.

  Note: adding `inventoryItemId` changes the content of every Shopify-imported variant, so the first reconcile after upgrading re-converges each Shopify product once.

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.63.0

## 0.62.0

### Patch Changes

- Updated dependencies [[`821ebd4`](https://github.com/asyncdotengineering/porulle/commit/821ebd490a87ee52b85bd8ac538f3c6993219782)]:
  - @porulle/core@0.62.0

## 0.61.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.61.0

## 0.60.0

### Patch Changes

- Updated dependencies [[`a227273`](https://github.com/asyncdotengineering/porulle/commit/a2272739c3e7f73fa0b98c9dca970f6700632381)]:
  - @porulle/core@0.60.0

## 0.59.0

### Patch Changes

- Updated dependencies [[`0ec04dc`](https://github.com/asyncdotengineering/porulle/commit/0ec04dc860d7afb9e2367425c7264de2e9c066a9)]:
  - @porulle/core@0.59.0

## 0.58.0

### Minor Changes

- [#153](https://github.com/asyncdotengineering/porulle/pull/153) [`a8c90a0`](https://github.com/asyncdotengineering/porulle/commit/a8c90a0ae793c7471a03c54e2abe41f30b307a4d) Thanks [@octalpixel](https://github.com/octalpixel)! - A store's inventory sync takes one catalogue page per step and writes it set-based.

  - **Core:** new `inventory.setAbsoluteMany(rows, actor, ctx?, { reason })`. It keeps `setAbsolute`'s invariants (permission, default warehouse, org, no-op on unchanged, a clamp at 0, the `version` bump, one movement per change) in a constant number of statements per call: 10 per page in the connector's sync, for 10 levels or 100. It announces each page ONCE through the new `inventory.afterAdjustMany` hook, with the changed levels grouped by product. It does not fire `inventory.afterAdjust` per level.
    - Core's audit (new `AuditService.recordMany`, one insert) and outbound webhooks (still one `inventory.update` event per changed level) both handle the bulk hook.
    - **Breaking for subscribers:** a plugin or `config.inventory.hooks` that subscribes to `inventory.afterAdjust` must also subscribe to `inventory.afterAdjustMany`, or the kernel refuses to boot, naming the subscriber. Otherwise that subscriber would silently miss every bulk sync.
  - **Connector:** new optional `ChannelConnector.fetchInventoryPage(store, cursor)`. With it, `syncInventory` makes one page fetch, one mapping read and one `setAbsoluteMany` per step, and stores the next cursor on the store. The old path re-read the store's whole inventory and every map row on every 20-level step, and on a 27k-variant store it hit a Workflow ceiling after 1,340 levels.
  - **Shopify adapter:** implements `fetchInventoryPage`, one `products.json` page per call. `fetchInventory` walks it.
  - **Known limit:** connectors without `fetchInventoryPage` (WooCommerce, manual) keep the old path.

### Patch Changes

- Updated dependencies [[`a8c90a0`](https://github.com/asyncdotengineering/porulle/commit/a8c90a0ae793c7471a03c54e2abe41f30b307a4d)]:
  - @porulle/core@0.58.0

## 0.57.1

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.57.1

## 0.57.0

### Minor Changes

- [#151](https://github.com/asyncdotengineering/porulle/pull/151) [`b60fc7a`](https://github.com/asyncdotengineering/porulle/commit/b60fc7affd26715c58681edfd7b3def5315eff75) Thanks [@octalpixel](https://github.com/octalpixel)! - `fetchInventory` now reports stock for EVERY variant, keyed by variant id.

  It asked `inventory_levels.json?limit=250` once and never followed `Link`, so a 3,000-product store was levelled for one 250-row page. Against real Shopify it was worse: that endpoint requires `inventory_item_ids` or `location_ids`, takes at most 50 ids, and keys levels by inventory item id (not the variant id the connector matches), so a real store levelled nothing.

  - **Full sync, or more than 25 ids:** one walk of `products.json?fields=id,variants`, every page (ceil(products / 250) requests), reading each variant's `inventory_quantity`.
  - **Up to 25 ids (the order-time stock check):** one `variants/{id}.json` each. A variant Shopify no longer has is omitted, so the caller refuses that line.
  - Negative stock reads as 0. `inventory_quantity` sums all of a shop's locations, so a store with a non-selling location overstates sellable stock.

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.57.0

## 0.56.0

### Patch Changes

- Updated dependencies [[`e3b8102`](https://github.com/asyncdotengineering/porulle/commit/e3b8102d85b528546ff37aca4ef8de6f8c8ef03e)]:
  - @porulle/core@0.56.0

## 0.55.0

### Patch Changes

- Updated dependencies [[`4c140bc`](https://github.com/asyncdotengineering/porulle/commit/4c140bcdd82e8e3cc3957f629941f878b2e3a6a4)]:
  - @porulle/core@0.55.0

## 0.54.0

### Patch Changes

- Updated dependencies [[`01484a9`](https://github.com/asyncdotengineering/porulle/commit/01484a92d8d8be6b99350198a7eda0a5c5a392fb)]:
  - @porulle/core@0.54.0

## 0.53.1

### Patch Changes

- Updated dependencies [[`98b8547`](https://github.com/asyncdotengineering/porulle/commit/98b8547673c3cfded32562ec1a313958562d961e)]:
  - @porulle/core@0.53.1

## 0.53.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.53.0

## 0.52.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.52.0

## 0.51.0

### Patch Changes

- Updated dependencies [[`579a00b`](https://github.com/asyncdotengineering/porulle/commit/579a00b46dc982aa6e0e5b3a5c9e4cce325e96e7)]:
  - @porulle/core@0.51.0

## 0.50.3

### Patch Changes

- Updated dependencies [[`54f215c`](https://github.com/asyncdotengineering/porulle/commit/54f215c3b833131c4378b54b8ab26c1b330ebef5)]:
  - @porulle/core@0.50.3

## 0.50.2

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.50.2

## 0.50.1

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.50.1

## 0.50.0

### Patch Changes

- Updated dependencies [[`269e445`](https://github.com/asyncdotengineering/porulle/commit/269e445300d6afe05039fd9d0d56eda7067f8816)]:
  - @porulle/core@0.50.0

## 0.49.0

### Patch Changes

- Updated dependencies [[`bd48f59`](https://github.com/asyncdotengineering/porulle/commit/bd48f595b827e64920bb7243c2310f31d1f2b97c)]:
  - @porulle/core@0.49.0

## 0.48.1

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.48.1

## 0.48.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.48.0

## 0.47.0

### Patch Changes

- Updated dependencies [[`71ace6a`](https://github.com/asyncdotengineering/porulle/commit/71ace6a67d7dcae1602f2bbf6d91c97435a06ec8)]:
  - @porulle/core@0.47.0

## 0.46.0

### Patch Changes

- Updated dependencies [[`63d0562`](https://github.com/asyncdotengineering/porulle/commit/63d0562af8c12314509545a6c4379946b9629e6f)]:
  - @porulle/core@0.46.0

## 0.45.0

### Patch Changes

- Updated dependencies [[`1e3ea65`](https://github.com/asyncdotengineering/porulle/commit/1e3ea6566ed1cd5dac9388af5511835d42e7f466)]:
  - @porulle/core@0.45.0

## 0.44.0

### Patch Changes

- Updated dependencies [[`adf43da`](https://github.com/asyncdotengineering/porulle/commit/adf43da78b7d48baf8a2074a65b759a1bee6df2f), [`74a4a60`](https://github.com/asyncdotengineering/porulle/commit/74a4a6040cef90e420e780a3deb189857db7a15a), [`05b4efc`](https://github.com/asyncdotengineering/porulle/commit/05b4efc72374f5787d91c85321c90a3f43fbc436)]:
  - @porulle/core@0.44.0

## 0.43.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.43.0

## 0.42.0

### Patch Changes

- Updated dependencies [[`e9f1de6`](https://github.com/asyncdotengineering/porulle/commit/e9f1de6d18a35e706153c2e596799d35c00ffbc2)]:
  - @porulle/core@0.42.0

## 0.41.0

### Patch Changes

- Updated dependencies [[`7f3dacc`](https://github.com/asyncdotengineering/porulle/commit/7f3daccf2c40ce2425ae34badff43086cec4df66)]:
  - @porulle/core@0.41.0

## 0.40.1

### Patch Changes

- Updated dependencies [[`bc1ca17`](https://github.com/asyncdotengineering/porulle/commit/bc1ca17f168ef3c6bbad5eec2144cf4e5853b912)]:
  - @porulle/core@0.40.1

## 0.40.0

### Minor Changes

- [#125](https://github.com/asyncdotengineering/porulle/pull/125) [`c16c3fa`](https://github.com/asyncdotengineering/porulle/commit/c16c3fa44a4bb662a75dd28362faea9f8697eecf) Thanks [@octalpixel](https://github.com/octalpixel)! - Breaking: the channel connector pushes an order to its merchant when payment lands, not when the order row is created

  **The default changed. If you use `@porulle/plugin-channel-connector` and your orders start in `pending_payment`, they are no longer pushed at creation** — they are pushed when they leave that state for anything but `cancelled`. This is a behaviour change, not only a new option: a consumer reading "added `pushOrderOn`" and nothing else would not learn that their push moved.

  Until now `buildHooks` registered an `orders.afterCreate` hook that enqueued `channel/push-order` the moment the order row existed, with no reference to payment. For any consumer with a payment step that pushed an unpaid order to a real merchant, who then picks, packs and ships it.

  `ChannelConnectorPluginOptions.pushOrderOn` selects the trigger:

  - `"payment"` (the new default) — an order created in `pending_payment` is not pushed; it is pushed on `orders.afterStatusChange` when it leaves `pending_payment` for anything but `cancelled`. An order created in `pending` is still pushed on creation, so a store with no payment step is unaffected.
  - `"create"` — the previous behaviour, for consumers who want it. Set this to keep today's timing.
  - `false` — no automatic push at all; enqueue `channel/push-order` yourself.

  The predicate is the _transition_ (`fromStatus === "pending_payment"`), not "the new status looks paid". Core commits a status with a compare-and-swap, so exactly one caller wins a given transition and the push fires exactly once by construction. Keying on the new status alone would re-push on every later move, because `exportOrder` short-circuits only on an already-`confirmed` export and pushes one still `exported` again.

  **`orders.afterStatusChange` hooks now receive the transition in `data`.** It was always `null`, because `runAfterHooks` was called with `null` as its original data while core had already built the `{ orderId, fromStatus, newStatus, reason? }` input for the _before_ hooks and then discarded it. A hook that needed to know which transition occurred could not find out; the order itself carries only the status it now has.

  `AfterHook` takes an optional second type parameter for this — `AfterHook<TResult, TData = TResult>` — so `data` and `result` may differ in shape where the committed entity is not the input. The default keeps every existing single-argument use identical, and `runAfterHooks` gained the matching parameter.

  **Known and deliberately unchanged:** core's own `sendOrderStatusEmail` reads `result.newStatus` and `result.previousStatus`, which the hydrated order does not carry, so it has never sent an email and still does not. Switching a dormant customer-facing email path on is a separate decision from moving the seam, and it is not made here.

  Also: `@porulle/adapter-shopify` now carries variant weight through `importCatalog`.

  Shopify's REST variant returns `grams`, plus `weight` with a `weight_unit`, on every variant. The adapter's internal response type declared none of them, so `importCatalog` discarded the weight and every imported product arrived weightless. Variants now map to `metadata.weightGrams`, the key `resolveWeightGrams` reads when it prices shipping.

  `grams` wins when present and positive; otherwise `weight` is converted from `g`, `kg`, `oz` or `lb`. An unrecognised `weight_unit` is refused rather than assumed to be grams — reading `"lbs"` as grams under-prices a parcel by a factor of 453. The key is **omitted** when no weight is known, never written as `0`, because `0` is indistinguishable from a genuinely weightless item. This half is additive: a consumer that ignores `variant.metadata` is unaffected.

### Patch Changes

- Updated dependencies [[`c16c3fa`](https://github.com/asyncdotengineering/porulle/commit/c16c3fa44a4bb662a75dd28362faea9f8697eecf)]:
  - @porulle/core@0.40.0

## 0.39.0

### Minor Changes

- [#124](https://github.com/asyncdotengineering/porulle/pull/124) [`d9aca5c`](https://github.com/asyncdotengineering/porulle/commit/d9aca5c1f7620b516afdb444b5e168ff7f884eb5) Thanks [@octalpixel](https://github.com/octalpixel)! - Let a caller point the Shopify adapter at a different origin, and read RFC 8288's bare `rel` token

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

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.39.0

## 0.38.0

### Patch Changes

- Updated dependencies [[`26b2da1`](https://github.com/asyncdotengineering/porulle/commit/26b2da16f4fe03a28566d91d6ca7aa4f46fea3c5)]:
  - @porulle/core@0.38.0

## 0.37.0

### Patch Changes

- Updated dependencies [[`f28bef1`](https://github.com/asyncdotengineering/porulle/commit/f28bef11a0ae73b1011aa29f7772d2c8fa6b05cd)]:
  - @porulle/core@0.37.0

## 0.36.0

### Patch Changes

- Updated dependencies [[`1603287`](https://github.com/asyncdotengineering/porulle/commit/1603287a8a47a0ad4f5d14cc3a6e6b339cdee31d), [`9527725`](https://github.com/asyncdotengineering/porulle/commit/952772518cc07e2fedc8792847c3a9d22072f0e9)]:
  - @porulle/core@0.36.0

## 0.35.1

### Patch Changes

- Updated dependencies [[`93715ed`](https://github.com/asyncdotengineering/porulle/commit/93715ededae7c8fb35f1d2c81637136e8a887501)]:
  - @porulle/core@0.35.1

## 0.35.0

### Patch Changes

- Updated dependencies [[`217f9a6`](https://github.com/asyncdotengineering/porulle/commit/217f9a6f80630d66f50fa06a00322656bda9f61b)]:
  - @porulle/core@0.35.0

## 0.34.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.34.0

## 0.33.0

### Patch Changes

- Updated dependencies [[`bc4328b`](https://github.com/asyncdotengineering/porulle/commit/bc4328badd48a76be1c31df349e881a2a66359be)]:
  - @porulle/core@0.33.0

## 0.32.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.32.0

## 0.31.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.31.0

## 0.30.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.30.0

## 0.29.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.29.0

## 0.28.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.28.0

## 0.27.0

### Patch Changes

- Updated dependencies [[`687c7df`](https://github.com/asyncdotengineering/porulle/commit/687c7dfb546b023a9686b4af3ed446719b16b2fc)]:
  - @porulle/core@0.27.0

## 0.26.0

### Patch Changes

- Updated dependencies [[`8fd3716`](https://github.com/asyncdotengineering/porulle/commit/8fd3716a5fb5974c4a2b55f2d9a6bfecd6855a4a)]:
  - @porulle/core@0.26.0

## 0.25.0

### Patch Changes

- Updated dependencies [[`45b8c18`](https://github.com/asyncdotengineering/porulle/commit/45b8c18fa6ab40664794c0e8c7cefb69d60ba69c)]:
  - @porulle/core@0.25.0

## 0.24.1

### Patch Changes

- Updated dependencies [[`37c51fe`](https://github.com/asyncdotengineering/porulle/commit/37c51feb3dfad82fd6cf8e63dc18b07ea1b5caf5)]:
  - @porulle/core@0.24.1

## 0.24.0

### Patch Changes

- Updated dependencies [[`6832853`](https://github.com/asyncdotengineering/porulle/commit/6832853d83b02b5ba83c8e4008e4ec36b5e210eb)]:
  - @porulle/core@0.24.0

## 0.23.0

### Patch Changes

- Updated dependencies [[`cf30ee4`](https://github.com/asyncdotengineering/porulle/commit/cf30ee485b8050f393452a1bed7adf3e2bacc558)]:
  - @porulle/core@0.23.0

## 0.22.0

### Patch Changes

- Updated dependencies [[`0a719cd`](https://github.com/asyncdotengineering/porulle/commit/0a719cd9cbf6836f513b642e566e82d16ea3e97c)]:
  - @porulle/core@0.22.0

## 0.21.0

### Patch Changes

- Updated dependencies [[`f6d69fb`](https://github.com/asyncdotengineering/porulle/commit/f6d69fbe64165b2e9a6bd892ba433f69273f8dee)]:
  - @porulle/core@0.21.0

## 0.20.3

### Patch Changes

- Updated dependencies [[`17f743c`](https://github.com/asyncdotengineering/porulle/commit/17f743c2c4a7c08f111561748d140f84c214a60d)]:
  - @porulle/core@0.20.3

## 0.20.2

### Patch Changes

- Updated dependencies [[`ad671d2`](https://github.com/asyncdotengineering/porulle/commit/ad671d223368be15e1517917527dc2aa9c0f105e)]:
  - @porulle/core@0.20.2

## 0.20.1

### Patch Changes

- Updated dependencies [[`8ba7ebf`](https://github.com/asyncdotengineering/porulle/commit/8ba7ebfe90286c9bbc07651458c596aaa004b070)]:
  - @porulle/core@0.20.1

## 0.20.0

### Patch Changes

- Updated dependencies [[`e99bf87`](https://github.com/asyncdotengineering/porulle/commit/e99bf873d09fcb00bae42845b04f23e126e1293c)]:
  - @porulle/core@0.20.0

## 0.19.0

### Patch Changes

- Updated dependencies [[`d98a0cf`](https://github.com/asyncdotengineering/porulle/commit/d98a0cf04578f4c89a758a3544a5a7bc99e9444c)]:
  - @porulle/core@0.19.0

## 0.18.0

### Patch Changes

- Updated dependencies [[`7ca0da4`](https://github.com/asyncdotengineering/porulle/commit/7ca0da4237e05f890d403397d839eccc27bb5900)]:
  - @porulle/core@0.18.0

## 0.17.0

### Minor Changes

- [#93](https://github.com/asyncdotengineering/porulle/pull/93) [`4bc5a61`](https://github.com/asyncdotengineering/porulle/commit/4bc5a6137a01a2f221c4d1ba0c8d22d7e80b7f56) Thanks [@octalpixel](https://github.com/octalpixel)! - Write product images on Shopify catalog push.

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

### Patch Changes

- Updated dependencies [[`4bc5a61`](https://github.com/asyncdotengineering/porulle/commit/4bc5a6137a01a2f221c4d1ba0c8d22d7e80b7f56)]:
  - @porulle/core@0.17.0

## 0.16.0

### Patch Changes

- Updated dependencies [[`983bc69`](https://github.com/asyncdotengineering/porulle/commit/983bc696af361445cf5d19b4d69b1a9f4a25fb83)]:
  - @porulle/core@0.16.0

## 0.15.0

### Patch Changes

- Updated dependencies [[`dd59c5c`](https://github.com/asyncdotengineering/porulle/commit/dd59c5cd0d456d90b0cfb0af6b744a2520dc8f57)]:
  - @porulle/core@0.15.0

## 0.14.0

### Patch Changes

- Updated dependencies [[`3f1de20`](https://github.com/asyncdotengineering/porulle/commit/3f1de204f0ebb07f634fe702ddc8a6f1d6fd7f22), [`0583eab`](https://github.com/asyncdotengineering/porulle/commit/0583eab02f80869f3aba3fdc2ae847712cbd6959), [`f476b2c`](https://github.com/asyncdotengineering/porulle/commit/f476b2c2687dc4bed24de65a1ab1abdf08853066), [`32136d4`](https://github.com/asyncdotengineering/porulle/commit/32136d49df43995e167e1198d1b768976e1eb85f)]:
  - @porulle/core@0.14.0

## 0.13.0

### Patch Changes

- Updated dependencies [[`6cfb51d`](https://github.com/asyncdotengineering/porulle/commit/6cfb51debf27bb2f9bac26320d95414bf3443905), [`98e75bb`](https://github.com/asyncdotengineering/porulle/commit/98e75bb0222d9079589d97dca74de0f0dda4e12c), [`8c2c116`](https://github.com/asyncdotengineering/porulle/commit/8c2c1160acf87b981b3be8606918cde057fed833), [`4f9e5b9`](https://github.com/asyncdotengineering/porulle/commit/4f9e5b939b72849b943de6fe2d2751dac8d6caba), [`5ee7ae3`](https://github.com/asyncdotengineering/porulle/commit/5ee7ae3628acb29ea56738423c8cfe5e10d26182), [`0948324`](https://github.com/asyncdotengineering/porulle/commit/0948324c22f1468dfeb73707f6f77d182bc58494), [`54bf6cf`](https://github.com/asyncdotengineering/porulle/commit/54bf6cfcb5f45b46cecdd9a1568a104ae647817c), [`f36de3a`](https://github.com/asyncdotengineering/porulle/commit/f36de3a4524c67eb79badeeb2a33f3502c75bf18), [`cf611f9`](https://github.com/asyncdotengineering/porulle/commit/cf611f9f6b21a4dd3eaee7e3cab8c9f7d2faf431), [`7688ce2`](https://github.com/asyncdotengineering/porulle/commit/7688ce2eb4e1eea74a9ec0bfab90cdb74078bcc6), [`bc5c825`](https://github.com/asyncdotengineering/porulle/commit/bc5c825919d3f0cbbf4849cdefb72b61c430fb0d), [`d6f27f6`](https://github.com/asyncdotengineering/porulle/commit/d6f27f6b24cb0de70b77529f81d0677d0b235a5f)]:
  - @porulle/core@0.13.0

## 0.12.0

### Minor Changes

- Complete the outbound catalog push path: Porulle can now write catalog data back to a connected store, not only read from it.

  **Both adapters implement `pushCatalog`.** Shopify writes native product fields and metafields in a Porulle-owned namespace, adds the `write_products` scope, and resolves push capability per store from the scopes that store actually granted — a store connected before the scope existed fails closed with a non-retriable error naming the re-authorisation route rather than 403ing forever. WooCommerce writes native fields, `meta_data` under a Porulle prefix, and global `pa_*` taxonomy attributes for fields marked filterable, since only those drive layered navigation. Both resolve placement from the payload's intent plus its remote key, and neither will guess a remote key it was not given.

  Three WooCommerce write semantics are handled explicitly because getting them wrong destroys merchant data: the product `attributes` array is replaced wholesale on update, so it is read-merge-written; underscore-prefixed meta keys are rerouted by WooCommerce to first-class property setters, so the Porulle prefix is enforced structurally; and the batch endpoint reports per-item failures inside an HTTP 200, so its body is parsed rather than its status trusted. Image pushes carry the imported attachment id and merge against the current gallery instead of rebuilding it.

  **Catalog writes are triggered, previewable, and reversible by a human.** A change to a platform-owned field enqueues a push for the stores that map the entity, skipping writes that originated from channel convergence so an import cannot bounce straight back out. `POST /api/channels/stores/:id/push-catalog/preview` returns the per-field diff a push would apply, assembled by the same builder the job uses, and distinguishes a remote value that is absent from one that was never read.

  **A shared field that changes on both sides now waits for a person.** Convergence holds the field, records both values, and surfaces the conflict for review at `GET /api/channels/conflicts`; resolving it applies the chosen value without reassigning ownership, so the field stays shared and can conflict again.

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.12.0

## 0.11.0

### Minor Changes

- Catalog data-quality primitives, lossless channel import, and the outbound catalog contract.

  **Catalog.** Custom-field values are now updatable and carry provenance: `source`, `status` (proposed/approved/rejected), `confidence`, `evidence`, `locale`, and approval stamps, with one approved value per (entity, field, locale). A review workflow ships whole: approve/reject endpoints that displace the live value atomically and preserve evidence, an org-scoped proposal queue, and `?include=customFields` on entity reads returning approved rows. `select` fields enforce their declared options exact-match. Runtime entity field definitions layer over code config with admin REST and archive-never-delete semantics. Every catalog mutation writes a full entity revision in the same transaction, with true restore, per-entity monotonic numbering, and org-scoped retention trim. Media assets carry an origin (merchant/generated/imported) with a derivation link, and entity-media uniqueness is enforced per level.

  **Search.** `SearchFilters.attributes` and `SearchDocument.attributes` add attribute filtering and facets (AND across names, OR within one), opt-in per field via `filterable`, indexing approved values only — implemented in the in-memory engine, `adapter-pg-search` (parameterized jsonb), and `adapter-meilisearch` (union-safe filterable settings). The REST search route accepts repeatable `attr.<name>` parameters with an allowlisted grammar.

  **Channels.** `ChannelCatalogItem` widens to the full catalog shape — per-locale attributes, images, option axes, tags, brand, categories, status, and variant prices with compare-at — while staying structurally unable to express checkout state. Both connectors import the full payloads their platforms return, with currency-gated minor-unit prices. Convergence writes real catalog tables idempotently and merges metadata per key. A resumable per-store backfill (REST, durable job, and `porulle channel:backfill`) upgrades catalogs imported before this release. Per-field catalog ownership (`platform`/`store`/`shared`) with deterministic precedence governs every inbound path, holding shared conflicts persistently; connecting a store never implies catalog write access, and per-store placement mappings resolve at read time over provider defaults. The `ChannelConnector` contract gains an optional `pushCatalog` capability with intent-based payloads, per-item outcomes with prior remote values, and a platform-owned-only assembly — the write paths land in a following release.

  Consumer migrations for the schema additions are documented per feature in the repository's `docs/migration-*.md` files. PostgreSQL 15+ is now required.

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.11.0

## 0.10.8

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.10.8

## 0.10.6

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.10.6

## 0.10.5

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.10.5

## 0.10.4

### Patch Changes

- Updated dependencies [[`26a5a72`](https://github.com/asyncdotengineering/porulle/commit/26a5a722ae2e2a94d284e71f8e824ab2c985cce0)]:
  - @porulle/core@0.10.4

## 0.10.3

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.10.3

## 0.10.2

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.10.2

## 0.10.1

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.10.1

## 0.10.0

### Minor Changes

- [#77](https://github.com/asyncdotengineering/porulle/pull/77) [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce) Thanks [@octalpixel](https://github.com/octalpixel)! - Add Shopify and WooCommerce catalog synchronization plus paid order injection with transparent customer shipping details, remote status confirmation, and tiered failed-export handling.

- [#77](https://github.com/asyncdotengineering/porulle/pull/77) [`8f8c564`](https://github.com/asyncdotengineering/porulle/commit/8f8c564deb399a86c50d27d8ca07e5334888bf30) Thanks [@octalpixel](https://github.com/octalpixel)! - Add generic one-click store onboarding: Shopify OAuth and WooCommerce `/wc-auth` endpoint flows via new engine-plugin routes (`/api/channels/oauth/{provider}/start` + `/callback`), signed single-use callback state, and connector `buildAuthUrl`/`completeAuth` methods — alongside the existing credential-paste path. Add Shopify mandatory GDPR compliance webhook ingress: `POST /api/channels/compliance/{provider}` unauthenticated route, app-secret HMAC verification (`verifyAppWebhook`), `shop_domain` store resolution, and idempotent dispatch to existing redaction methods (`customers/data_request`, `customers/redact`, `shop/redact`).

### Patch Changes

- [#77](https://github.com/asyncdotengineering/porulle/pull/77) [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce) Thanks [@octalpixel](https://github.com/octalpixel)! - Add verified channel webhooks, provider subscription registration, mirror convergence, guarded cross-boundary refund approval, and per-store catalog/inventory reconciliation with drift reporting.

- [#78](https://github.com/asyncdotengineering/porulle/pull/78) [`92284bb`](https://github.com/asyncdotengineering/porulle/commit/92284bb44b019ffb95e751a028e58d941ec26fb3) Thanks [@octalpixel](https://github.com/octalpixel)! - Fix Shopify webhook verification to use the app client secret. Shopify signs every webhook for an app with the app's client/API secret key, not a per-store secret — `verifyWebhook` now verifies against the configured `clientSecret` instead of `store.webhookSecret` (which never matched real Shopify deliveries), and requires `clientSecret` to be configured. WooCommerce keeps its per-webhook secret.

- Updated dependencies [[`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce), [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce), [`8f8c564`](https://github.com/asyncdotengineering/porulle/commit/8f8c564deb399a86c50d27d8ca07e5334888bf30), [`ff3d5e6`](https://github.com/asyncdotengineering/porulle/commit/ff3d5e6e876f090119fd025aa6b5499f0dccd9fb), [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce), [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce)]:
  - @porulle/core@0.10.0
