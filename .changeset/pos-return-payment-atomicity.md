---
"@porulle/plugin-pos": major
---

**Breaking:** `POST /api/pos/returns` now requires a `payment` object in the request body. The refund ledger move and the first payout are recorded atomically in one transaction — abandoning between ledger and cash drawer is no longer possible. Split tender remains supported via `POST /api/pos/returns/{id}/payments`.
