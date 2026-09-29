---
"@porulle/core": minor
---

`auth.ipAddressHeaders`: the request headers Better Auth's rate limiter reads the client IP from (`advanced.ipAddress.ipAddressHeaders`). Unset keeps Better Auth's default (`x-forwarded-for`, one value), so nothing changes for existing hosts.

On Cloudflare Workers set `["cf-connecting-ip"]`. An internet request to a Worker carries no `x-forwarded-for`, so under the default every caller has no IP and shares one per-path bucket: one client flooding sign-in (3 per 10 s) throttles everyone's sign-in. Cloudflare sets `cf-connecting-ip` and refuses a client-set one. Over a service binding only the calling Worker can set it, so that Worker must forward a verified client IP or nothing.
