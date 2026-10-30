# SDK 0.5.5: Waffo consumed-session reconciliation

The Waffo Business adapter now implements inspectCheckout in the existing native order reconciliation flow. It queries scoped merchant orders and validates merchant store, product, environment and external order ID. Completed orders proceed through existing payment verification; active, conflicting and uncertain states retain eligibility.

Only a valid hosted cashier bootstrap that explicitly returns a null session, together with no active merchant order, permits confirmed closure. The probe is restricted to the provider-owned HTTPS pancake.waffo.ai host and exact store/session path. Errors, partial GraphQL results, multiple orders and schema changes do not release eligibility. This currently uses the hosted cashier read-only bootstrap observed on 2026-10-29; it fails closed if that format changes.

Options.fetch is an optional HTTP boundary for the hosted probe. Existing payment verification, late callbacks, immutable order/product snapshots, fulfillment idempotency and ledgers remain unchanged. Website callers must reconcile a saved attempt before resuming, clear only a confirmed-closed reference and request a new quote before a new order. Frontend return URLs or browser error text are never proof of unpaid closure.

No live payment was submitted during implementation. Tests use explicit provider boundaries.

Explicit `orders.reconcileCheckout({orderId,closeIfUnpaid:true})` may close a consumed one-time order only when scoped merchant evidence lists exclusively failed/canceled payments. Passive polling never cancels. The adapter derives buyer identity from that server-verified order, uses the official customer cancelOnetimeOrder API with a stable key, and re-queries canceled state before releasing native eligibility. Pending, unknown or succeeded payments do not take this branch.
