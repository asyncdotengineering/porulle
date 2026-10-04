---
"@porulle/core": minor
"@porulle/adapter-shopify": minor
"@porulle/plugin-channel-connector": minor
---

Send a discounted order's discount to the store. `ChannelOrderSlice.discount` carries the code the shopper used (`DISCOUNT` when none was typed) and the amount, when the slice is the whole order, and the slice total has it taken off. Shopify receives it as `discountCode.itemFixedDiscountCode`, so the store's total equals what the shopper paid.
