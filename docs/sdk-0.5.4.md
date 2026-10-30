# SDK 0.5.4: product-level Waffo bindings

The native product catalog stores each product's optional Waffo mapping in its existing JSON limits:

```ts
limits: {
  // Other limits, storefront content and purchase policies stay intact.
  payments: { waffo: { productId: "PROD_yourProductId" } },
}
```

Saving creates a new immutable product version. Native Business orders already snapshot the entire product, so both checkout creation and payment reconciliation use the original mapping even after an administrator changes or clears the current product. No schema migration, parallel order table or new credit ledger is required.

`createWaffoBusinessProvider({ productId })` remains compatible, but `productId` is now optional. Only product snapshots with no `waffo` entry use that legacy global value. An explicit `{ productId: null }` clears the mapping and disables fallback. A malformed mapping never falls back. Missing or invalid IDs are rejected before any Waffo request; the provider still verifies an active one-time product, store, environment, amount and unique completed payment.

Product saves validate the reserved payment-binding shape while preserving unrelated limits and other provider JSON. The Waffo adapter additionally requires a `PROD_` ID with alphanumeric suffix, at most 128 characters. Host administration should apply the same provider format check and explain missing mappings before reserving purchase eligibility.

Tests use synthetic Waffo responses and the existing test catalog; they do not create real products, take money or deploy. The generic Dashboard remains a separate source application and can edit limits; aimeme supplies its own explicit Waffo field.
