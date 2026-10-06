---
"@porulle/plugin-channel-connector": minor
---

Import a bounded gallery. `selectImportImages` now returns `gallery` beside `hero` and `perVariant`: the store's further photos in its order, as entity-level `gallery` images, up to six images per product in all. The page fast path defers them with the variant photos in `deferredMedia` (the host lands them) and the editor path links the same set, so both paths still converge on one image set. Agent feeds publish these as additional images and enrichment can read them; only the hero is embedded, so a gallery photo costs an upload and no model call.

Hosts that land `deferredMedia` must link an image with no `variantExternalIds` at entity level rather than skip it.
