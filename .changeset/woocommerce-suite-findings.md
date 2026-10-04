---
"@porulle/core": patch
"@porulle/plugin-channel-connector": patch
"@porulle/adapter-woocommerce": patch
---

Fixes found by driving a WooCommerce store end to end.

- **core:** the CSRF guard no longer refuses a request that carries no cookie (outside `/api/auth/*`). A forged request needs an ambient credential to ride; a store webhook has none, and WooCommerce's subscription ping (a cookieless, Origin-less form POST) was refused 403 — so WooCommerce never created a subscription and no store could connect. Login CSRF on the auth routes is still refused.
- **plugin:** "retry export" ran nothing: it moved the export to `exported` and never called the store. It now queues the push again (the connector finds an order it already created before creating one). Stock for a product whose only variant shares its id (a WooCommerce simple product) lands on the variant, in webhook updates and in reconcile's levelling, as it already did in the paged sync. A store marked `error` by a refused credential now carries the reason the merchant reads.
- **adapter-woocommerce:** a firewall page while creating an order is retriable, never a definitive refusal that would cancel the shopper's order; an http store address is refused with "must be https" in every mode.
