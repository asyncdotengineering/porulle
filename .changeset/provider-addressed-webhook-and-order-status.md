---
"@porulle/core": major
---

Address payment webhooks by provider, and let an order be created in a declared initial status.

**Breaking: `POST /api/payments/webhook` is now `POST /api/payments/webhook/:provider`.**

The old route resolved `config.payments[0]` — whichever payment adapter happened to be registered
first — verified the incoming body with it, and recorded the result in `processed_webhook_events`
under the hardcoded literal `provider: "stripe"`. An application whose only adapter is not Stripe
therefore had its notifications verified by its own adapter, filed under a gateway it does not use,
and answered `200`.

The inert `200` was not the problem. The row had been written, and `event_id` is unique, so a
delivery to that path consumed the id the application's own webhook route was going to deduplicate
on: a later, genuine delivery read as a duplicate and was silently skipped.

*To migrate:* repoint each gateway's webhook URL from `/api/payments/webhook` to
`/api/payments/webhook/<providerId>` — `/api/payments/webhook/stripe` for the bundled Stripe
adapter. The segment must match the adapter's `providerId`; an unregistered provider returns `404`
and records nothing. There is deliberately no alias for the old path: an alias would preserve
exactly the ambiguity this change removes.

`processed_webhook_events.provider` is now taken from the resolved adapter rather than a literal.
Rows written before this release carry `"stripe"` whatever the adapter actually was, so that
column's historical values are not a reliable fact about which gateway delivered the event.

The `payment_intent.succeeded` handling is now explicitly Stripe's, reached only through
`/api/payments/webhook/stripe`. Another gateway's events are verified and recorded but do not
transition an order; core does not interpret a vocabulary it does not own.

**Breaking (types): `StateDefinition` gains a required `initialStates`.**

Only code that constructs a `StateDefinition` by hand is affected — in practice, an application
passing a custom `stateMachine` to `OrderService`. Add `initialStates` listing the states an entity
may be *created* in. Applications using `orders.customTransitions`, or the default machine, need no
change.

**Added: `CreateOrderInput.status`.**

`orders.create` always started an order at the state machine's initial status, because the status
was a literal in the service. An application that needs an order to exist before it is paid — any
hosted-redirect gateway produces one — could only create it in the normal initial status and
transition immediately, leaving a window in which an unpaid order is indistinguishable from a
healthy one.

`status` is optional and validated against `initialStates` — the states an order may *start* in,
which is deliberately not `states`: validating against `states` would let a caller create an order
directly in `fulfilled`, past its whole lifecycle, with no transition recorded and no status-change
hook fired. Omitting `status` is unchanged behaviour. A status the machine does not declare, and a
status it declares but not as a starting point, are refused with distinct messages — never silently
downgraded to the initial status.

The order's first status-history row now records the status it was actually created in, rather than
always claiming `pending`.

**Added: `pending_payment` is a core order state**, with `pending_payment -> confirmed` and
`pending_payment -> cancelled`, and it is a legal initial state. There is no `expired`: an expiry is
a cancellation carrying a reason, and `changeStatus` already carries one.

**Added: `CreatePaymentIntentParams` is exported**, so an adapter author outside core can name the
argument its own `createPaymentIntent` receives.
