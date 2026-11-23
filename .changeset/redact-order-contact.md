---
"@porulle/plugin-channel-connector": minor
---

Erase every copy of a shopper's contact on redacted orders, match compliance payloads in SQL, defer open-order redaction until delivery completes, and surface `customers/data_request` through a host hook.

- `ChannelConnectorService.redactOrdersContact(orgId, orderIds, { storeId, reason })` is the single entry point used by `customers/redact`, `shop/redact`, and host-initiated account erasure. It clears `channel_order_exports.customer_data`, `channel_returns.note`, and the contact fields `orders.metadata` carries (`customer`, `shippingAddress`, `guestCustomer`, `guestShippingAddress`), stamps `contactRedactedAt` (no PII), keeps the order, lines, money, status and non-contact metadata intact, and invokes `options.onOrdersRedacted` on the same `db`/transaction handle so the host clears platform-owned copies.
- `customers/redact` and `customers/data_request` match the store's exports in SQL on both Shopify order ids (`orders_to_redact` / `orders_requested` = `channel_order_exports.remote_order_id`) and customer email without reading the store's other exports into memory.
- On `customers/redact`, orders already in a final state (`fulfilled`, `delivered`, `cancelled`, `refunded`) are redacted immediately; open orders still needed for delivery are stamped with `orders.metadata.redactAfterDelivery` and erased by an `orders.afterStatusChange` hook when they reach a final state (no cron).
- `shop/redact` redacts all of the store's orders immediately, disconnects the store with domain and credentials cleared, and invokes `options.onShopRedacted` with the original `storeDomain` so the host can remove store-scoped credentials.
- `customers/data_request` invokes `options.onCustomerDataRequest` with reference-only metadata (`storeId`, `shopDomain`, `requestId`, `remoteCustomerId`, `orderIds`, `remoteOrderIds`, `requestedAt`, and 30-day `dueAt`) without copying shopper contact or writing PII into job output or logs.
