---
"@porulle/core": minor
"@porulle/adapter-shopify": minor
"@porulle/plugin-channel-connector": minor
---

Returns. Connectors gain an optional `requestReturn` (Shopify: the order's fulfilment lines are matched by variant and `returnRequest` asks the store to take them back, with the shopper's reason as the customer note). The channel connector's `requestReturn(orgId, orderId, { lines, reason, note })` names each line by the store's own variant id, refuses a line the store has no record of before asking anything, and records the return in `channel_returns`; `returns/approve|decline|close|cancel|reopen` move it. The refund arrives on `refunds/create` as before.
