---
"@porulle/plugin-channel-connector": minor
"@porulle/core": minor
---

Import a product's images concurrently, within the Worker's connection budget, and stop loading the whole organization's media for every product.

`applyMedia` downloaded and re-uploaded a product's images one at a time inside a loop that was itself serial — two external round trips per image, carrying the whole payload. Measured on a deployed Worker, an import cost ~9.24 s per product and the image phase was about three quarters of it, across 448 images in a 100-product catalog.

The images of a product are independent of each other, so they now resolve with a bounded concurrency of three. The bound is not a preference: a Cloudflare Worker may hold at most six simultaneous outbound connections per invocation and one image costs two of them, so a fourth would queue behind the platform limit rather than go faster. Two images of the same product that resolve to the same asset share one upload — and, deliberately, not its tally, so `mediaImported` still counts one stored object once.

The per-product `media_assets` lookup loaded every asset the organization owned, which is O(n²) in catalog size and grows exactly where the thousand- and five-thousand-product cases live. It is now one query narrowed to that product's own channel image identifiers, with matching expression indexes on `media_assets` for `(organization_id, metadata->>'channelImageUrlHash')` and `(organization_id, metadata->>'channelImageExternalId')`.
