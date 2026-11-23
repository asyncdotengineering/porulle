---
"@porulle/plugin-channel-connector": minor
---

`ChannelConnectorService.refreshLineStock(orgId, lines, { timeoutMs })` brings a bag's stock up to what its stores say now, for a host that prices a checkout against its own mirror.

- Lines are grouped by the store their product was imported from; lines of a hand-made product are ignored. Only those lines' mappings are read, never the store's whole map.
- One `fetchInventory` per store, all stores at once, each under `timeoutMs`. A level that differs from the stored quantity is written through the inventory service the way an `inventory_levels/update` webhook writes it (system actor, negative clamped to 0), so the same after-hooks and search outbox run.
- A store that is not connected, has no connector, errors, times out, or leaves a variant out of its answer writes nothing for what it did not confirm and is returned in `unconfirmed`. The method never throws for a store's failure and never refuses a sale: the caller's own stock check does that, on the numbers written.
- `validateLineStock` shares the line grouping and mapping lookup, and now reads only the bag's mappings instead of the whole store's.
