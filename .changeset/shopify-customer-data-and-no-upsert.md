---
"@porulle/adapter-shopify": minor
---

Match live Shopify behaviour for `orderCreate`, protected customer data refusals, and unknown shops.

- `pushOrder` no longer sends `customer.toUpsert` (which Shopify refuses with `ACCESS_DENIED` requiring `write_customers` whenever the email already exists as a customer); `email` and `shippingAddress` alone create orders for new, existing, and repeat shoppers.
- Protected customer data refusals — both `webhookSubscriptionCreate` userErrors on order topics and `Order`-object `ACCESS_DENIED` GraphQL errors — map to one non-retriable code `SHOPIFY_CUSTOMER_DATA_NOT_ALLOWED`.
- HTTP 404 from the token endpoint maps to non-retriable `SHOPIFY_SHOP_NOT_FOUND`.
