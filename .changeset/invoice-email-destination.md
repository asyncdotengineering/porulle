---
"@porulle/core": patch
---

Send an order's invoice to the address on the order, not to one the caller names.

A cart secret authorizes reading an order, and `emailInvoice` passed the caller's `to` straight to the email adapter. That turned a read into delivery: a leaked secret mailed items, totals and shipping address to any address, leaving nothing in the shopper's inbox.

The destination is now the order's own address — its customer profile's email. A caller-supplied `to` is honoured only for an actor holding org-wide `orders:read`; a self-service or cart-secret caller may pass it only when it matches the order's address, and is refused otherwise. An order with no address of its own cannot be emailed at all; rendering it, which the secret already grants, is unchanged.

**Breaking:** a non-staff caller naming a different recipient now receives 403 instead of a send. The other document routes carry no caller-supplied destination and are unaffected.
