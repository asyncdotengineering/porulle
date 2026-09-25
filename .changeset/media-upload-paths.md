---
"@porulle/core": minor
---

`config.media.uploadPaths` names further routes (matched by exact path) that take photos and so get `media.maxUploadSize` instead of the global 1MB body limit, e.g. a shopper's photo evidence of a damaged item. `/api/media/upload` is always included; an unlisted route, or one merely sharing a prefix, still answers 413 above 1MB.
