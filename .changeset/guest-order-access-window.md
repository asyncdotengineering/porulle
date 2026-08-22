---
"@porulle/core": minor
---

Bound a guest's order read to a window after placement.

A cart secret is a bearer credential that had no lifetime of its own. `OrderService.authorizeOrderRead` re-authorized a guest order read by calling back into `cart.getById`, so a secret matching the cart row read the placed order forever: the cart's `expires_at` was never consulted on that path, the secret never rotated at checkout, and nothing revoked it.

Entropy was never the exposure — a 122-bit UUID is not guessed. A secret that escaped through a referrer header, a shared confirmation link, a log line, or a browser history on a shared device was, and it kept working indefinitely.

Guest access is now bounded by `config.orders.guestAccessStrategy`, defaulting to `windowedGuestOrderAccess("7d")`. The window is anchored on the order's `placed_at`, never on the cart, so a shopper who checks out on the sixth day of a seven-day cart still gets a full seven days of receipt access. A stale window fails with the same error as a wrong secret, so it cannot be used as an oracle to confirm a secret is valid. `windowedGuestOrderAccess`, `defaultGuestOrderAccess`, `parseAccessWindow` and the `GuestOrderAccessStrategy` type are exported for adopters who want a different policy.

Modelled on Vendure's `OrderByCodeAccessStrategy`, deliberately not on its two-hour default — that figure is calibrated for a guessable order code, not a random UUID.

**Breaking:** a guest bearer reading an order more than seven days after placement now receives 403 where it previously received 200. This covers `GET /api/orders/:id` and the document routes that authorize through it — invoice HTML, invoice PDF, receipt, and invoice email. Authenticated customers are unaffected: account ownership grants permanent access and the window never applies to it. Storefronts that let a guest revisit an order past a week should widen the window, for example `orders: { guestAccessStrategy: windowedGuestOrderAccess("30d") }`.
