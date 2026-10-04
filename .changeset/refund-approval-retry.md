---
"@porulle/plugin-channel-connector": patch
---

A channel refund whose execution fails no longer sticks as `approved`. An operator approval that fails returns the request to `requested` so it can be approved again, and an automatic refund that fails waits for an operator instead; both write a refund event naming the failure.
