---
"@porulle/core": patch
---

`describeError` no longer copies message text into `frames`. It took every stack line starting `at `, and a stack's header is
`name: message`, which can span lines (a provider's response body) and contain such a line, so a body could reach a log as a
"frame". The whole header is now cut off before frames are read, and a stack that does not begin with its header (a rewritten
message, another engine's format) gives no frames rather than a guess.
