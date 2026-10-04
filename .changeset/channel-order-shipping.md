---
"@porulle/core": patch
"@porulle/plugin-channel-connector": patch
"@porulle/adapter-shopify": patch
---

Send the order's delivery charge to the merchant's store. `ChannelOrderSlice` gains an optional `shipping`, filled when the slice is the whole order and the charge is above zero, and `grandTotal` now includes it. The Shopify adapter sends it as a `shippingLines` entry, so the order total matches the payment. Found on a real store: the shopper paid Rs 24,900 + Rs 350 delivery, and the merchant's order read Rs 24,900 with no shipping line. An order split across stores still carries no shipping, because one charge cannot be divided honestly.
