---
"@porulle/adapter-woocommerce": patch
---

A variable product whose variations use a global attribute by its term slug ("blue" where the product lists "Blue"), or one the product does not list at all, imports. Measured on WooCommerce's own sample catalogue on a real store, where both variable products failed to converge because a variant's option value was not among its product's options. Option axes are now the product's declared variation attributes plus any its variations use, with each value spelled as the product spells it.
