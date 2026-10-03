---
"@porulle/adapter-shopify": patch
"@porulle/core": patch
---

Call `fetch` unbound on Cloudflare Workers. The Shopify adapter called its fetch as `target.fetchImpl(...)` and core's webhook delivery as `this.fetchImpl(...)`; workerd's global `fetch` throws "Illegal invocation" for any `this` but the global scope, so every Admin API call (store profile, import, orders) failed on a Worker while every Node test passed. The adapter now carries a workerd test that runs it with the runtime's own `fetch`.
