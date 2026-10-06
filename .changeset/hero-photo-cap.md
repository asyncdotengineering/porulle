---
"@porulle/plugin-channel-connector": patch
---

Raise `HERO_IMAGE_BYTE_CAP` from 1 MiB to 4 MiB. At 1 MiB the import refused ordinary product photographs — 16 of 100 heroes in one live Shopify catalogue and 11 of 100 in another, all between 1 and 2 MiB — and a product imported without a photo is left out of every agent feed and of vision enrichment. The cap still refuses a stray 30 MB TIFF.
