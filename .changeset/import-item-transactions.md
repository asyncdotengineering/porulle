---
"@porulle/core": minor
---

`catalog.importProducts` writes each item in its own transaction under the default `reject-failed-rows` policy (when no caller transaction is supplied), instead of as savepoints of one page-wide transaction. An item's rows no longer stay uncommitted until the page's last item commits, so another store's page naming the same product slug resolves it at once instead of waiting for the rest of the page. `reject-everything`, and a caller-supplied transaction, keep one page transaction. Items of one page share a request id on their revision rows.
