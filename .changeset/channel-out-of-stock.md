---
"@porulle/core": minor
"@porulle/adapter-shopify": minor
"@porulle/plugin-channel-connector": minor
---

A store refusing an order for stock now cancels the platform order. Connectors answer `CHANNEL_OUT_OF_STOCK` for that refusal (Shopify: `orderCreate`'s `INVENTORY_CLAIM_FAILED`); the channel connector fails the export for good and cancels the order, so the host's cancel path refunds the shopper. Any other refusal still waits for an operator.
