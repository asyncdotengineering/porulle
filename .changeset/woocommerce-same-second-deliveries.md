---
"@porulle/adapter-woocommerce": patch
---

Two WooCommerce deliveries inside one second are both applied. A delivery is identified by its topic and whole signed body, not by `date_modified_gmt`, which is to the second — two stock changes in one second were read as one delivery and the second was dropped.
