---
"@porulle/core": patch
---

Logs never carry a caught error's message, the error object or its stack text. Every core log of a failed call (the kernel's
service timing, hook and compensation executors, the job runner and reaper, the REST checkout/catalog/search routes, the auth
middleware, shutdown and stale-order cleanup) now logs `describeError(error)`: name, code (SQLSTATE, errno, provider code), HTTP
status and the `at …` call frames, for the error and each cause. Before, a failed order insert logged the whole `DrizzleQueryError`,
whose `params` hold the customer's name, phone and address.
