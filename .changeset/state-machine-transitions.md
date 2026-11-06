---
"@porulle/core": minor
"@porulle/plugin-channel-connector": minor
---

Order and channel state machines hold their invariants under retries and concurrency.

- A partly refunded order can be fulfilled. `orders.changeStatus` refuses `fulfilled` only when every line is fully refunded.
- `approveReturn` claims a held return before paying, so two approvals pay once and a decline cannot land on a return being paid. A retry finds the refund by its reason, so a crash after the claim still pays the shopper.
- `channel/push-order` retries a transient failure, up to five attempts with exponential backoff. `exportOrder` still returns the failure as a value.
