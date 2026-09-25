---
"@porulle/plugin-channel-connector": minor
---

`buildOrderSlice` sends the store the address on the ORDER (typed at checkout, or the saved address the shopper picked, or the guest's), and uses the customer's saved default shipping address only as a fallback when the order carries none. It used to prefer the saved default, so an order was shipped to the default even when the shopper chose another address.

The mock connector's `pushOrder` derives its remote order id from the order (`mock-order-<orderId>`) instead of counting pushes in memory, which restarted at 1 in every Worker isolate and gave different orders the same remote id.
