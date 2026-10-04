---
"@porulle/core": minor
"@porulle/plugin-channel-connector": minor
"@porulle/adapter-shopify": minor
"@porulle/adapter-woocommerce": minor
---

A refund is priced from what was actually paid back, in its parts.

- `orders.refundLines` takes `shippingAmount` (delivery paid back, at most the delivery not yet refunded) and `adjustmentAmount` (money with no line behind it), alongside or instead of lines; the total is bounded by what is left of the order. `order_refunds` records both, so delivery and goodwill are never refunded twice. **Schema:** `order_refunds` gains `shipping_amount` and `adjustment_amount` (integer, not null, default 0); `channel_refund_requests` gains both, and `channel_returns` gains `shipping_amount`.
- `refund.created` carries `shippingAmount`. The connector prices a store refund as its lines (never above what the shopper paid for them, now including each line's share of an order discount), plus delivery, plus goodwill only when the refund names no lines; a refund worth 0 creates nothing. It approves on its own only an exact match of whole lines and delivery.
- Shopify: `amount` is the sum of the refund's successful transactions and `shippingAmount` comes from `refund_shipping_lines`, so a partial refund is paid as partial. WooCommerce: `shippingAmount` from the refund's shipping lines, and `recordRefund` books delivery on the order's shipping line.
- A platform-held return can be approved with `{ refundShipping: true }`; `listReturns` answers the order number, the items by title, and the delivery still refundable. `listRefundRequests` answers the order number.
- An order slice pushed to a store carries each line's discount, so the store's own refund of a line matches what the shopper paid.
