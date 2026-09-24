---
"@porulle/plugin-channel-connector": minor
---

`reconcile()` no longer archives a store's whole catalogue on an empty or truncated fetch.

- New: `planAbsentArchives(mappedExternalIds, presentExternalIds)` returns `{ archive }` or `{ refused }`, alongside `ABSENT_ARCHIVE_FLOOR` (5) and `ABSENT_ARCHIVE_FRACTION` (0.2). It is the one deletion policy for mapped products a fetch no longer lists, and the app's import finalize barrier can import the same rule. It refuses an empty fetch over mapped products, and more absent products than `max(5, floor(20% of mapped))`.
- `reconcile()` plans before it archives anything. On a refusal it archives nothing, sets `driftAlert`, and reports the reason in the new `ReconcileReport.refused`. Before this change, an empty fetch over 12 mapped products archived all 12 with `driftAlert: false`.
