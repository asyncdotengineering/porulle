---
"@porulle/plugin-channel-connector": minor
---

Record a store's shipments as tracking. `orders/fulfilled` and the newly handled `orders/partially_fulfilled` turn each store fulfilment in the order body into one core fulfilment record (carrier, tracking number and link, the lines it shipped), keyed on the store's fulfilment id so a replay records nothing twice, and before the order moves so what the move announces can read it. A partial shipment leaves the order `partially_fulfilled`; a cancelled store fulfilment is not a parcel.
