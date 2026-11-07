---
"@porulle/plugin-channel-connector": patch
---

An order cancelled while it is being sent to a store no longer stays at the store. The push used to check that the order was open only when the job started, and a shopper's cancel that landed while the push was in flight found no store order to cancel, so the store kept, and could ship, an order the shopper had been refunded for. Now the claim on the export and the write that records the store's order both carry the "order not cancelled or refunded" check in the same statement; the cancel marks an export still being sent as `failed` before it cancels at the store; and a push that finds the order closed when it comes back cancels the store order it just made (export `abandoned`). A store whose connector cannot cancel, or refuses, leaves the export `failed` (definitive) with the store order named, on the failed-exports list for an operator. An operator retry of a closed order's export is refused.
