---
"@porulle/plugin-channel-connector": patch
---

An order export is confirmed when the store's status read after the push answers `fulfilled`, not only `confirmed`. WooCommerce completes virtual and downloadable orders on arrival, so their exports stayed `exported` forever although the store had received the order.
