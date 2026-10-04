---
"@porulle/core": minor
"@porulle/plugin-channel-connector": minor
"@porulle/adapter-woocommerce": minor
---

Returns for stores with none of their own. A connector may implement `recordRefund` (book at the store a refund the marketplace already paid, moving no money there). For a store whose connector has `recordRefund` and no `requestReturn`, a shopper's return is held on the platform (`remote_return_id` prefixed `platform:`), listed at `GET /channels/returns`, and approved or declined by its merchant (`POST /channels/returns/{id}/approve|decline`, `channels:connect`, confined to the merchant's stores). Approving pays the shopper back for the returned lines, books the refund at the store with the stock put back, and keeps it as an executed refund request under the store's own refund id, so the store's webhook for it pays nobody twice. WooCommerce implements `recordRefund`.
