---
"@porulle/core": patch
"@porulle/plugin-channel-connector": patch
"@porulle/adapter-woocommerce": patch
---

A store is probed at OAuth start, and refused there with the connector's reason. `ChannelConnector.probeStore` (optional) checks what the merchant typed before they are sent anywhere; the WooCommerce adapter answers "must be https", "not a public website", "a firewall is blocking us", "turn on pretty permalinks" or "not WooCommerce" instead of sending the merchant to a broken page on their own site. The WooCommerce adapter takes an http callback only for a store on this machine (`allowPrivateHosts`), as WooCommerce itself refuses one.
