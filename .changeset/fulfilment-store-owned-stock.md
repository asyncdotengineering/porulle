---
"@porulle/core": patch
---

Fulfilment no longer deducts stock imported from a connected store. That stock mirrors the store's available count, which the store lowers when it accepts the order and does not lower again when it ships; deducting on fulfilment took a second unit off the mirror for every sale (found on a real Shopify store: 7 in stock, one sold, the mirror read 5). Platform-owned stock still deducts, and the reservation is still released.
