# Security Regression Test Plan

This defines the security regression tests to add alongside each fix and to run
continuously. It mirrors the attack categories in `attack-surface.md`. All tests are
local (Vitest, in-memory/SQLite/Postgres fixtures); none call real providers or
production systems.

## 1. Payment & order ledger (`packages/business`, `packages/credits`, provider packages)

- **Idempotency**: re-delivering the same verified payment event (same `paymentId`,
  same payload) must not double-grant credits or double-fulfill. Re-delivering the same
  event with *different* payload must fail (`recordEvent` conflict).
- **Ownership**: `completeCheckout`/`checkout`/`reconcileCheckout`/`confirm*` on an order
  owned by another `referenceId` must return 403 and never write.
- **Amount/currency binding**: a provider verification that returns a different amount,
  currency, or `providerOrderId` than the saved order must be rejected.
- **Quote version**: changing the product price between quote and checkout must be
  rejected (`PURCHASE_QUOTE_CHANGED`).
- **Purchase limits**: two concurrent orders for a `maxPerUser`-limited product must not
  both be fulfillable; `purchaseConflict` must flag the second.
- **Refund**: refunding more than the order amount, or refunding before payment is
  reconciled, must fail; full refund of an already-fulfilled order must revoke credits
  and cancel the membership, and flag `reviewRequired` when credits were already spent.
- **Credit ledger**: concurrent `consume` operations must not overdraw; reservations
  cannot be double-settled; sequence/balance integrity checks must hold.
- **Webhook auth**: a Stripe/PayPal/Waffo webhook with a missing/invalid signature must
  be rejected (401/400) before any write.

## 2. Authentication (`packages/better-auth`)

- **Account enumeration**: sign-up/sign-in/reset-password must return indistinguishable
  responses for existing vs non-existing identifiers (where documented).
- **Password reset**: expired, reused, or tampered reset tokens must be rejected; tokens
  must be single-use.
- **Email verification**: unverified email must be blocked where
  `requireEmailVerification` is set; the verification token must be bound to the user.
- **Sessions**: revoked sessions must not be usable; cookie `Secure`/`HttpOnly`/`SameSite`
  must be set on the auth cookies.
- **CSRF / origin**: state-changing endpoints must reject cross-origin requests
  (missing/null/foreign `Origin` with a session cookie); redirect/callback URLs outside
  `trustedOrigins` must be rejected.
- **OAuth**: a redirect with a mismatched/foreign `redirect_uri` or missing PKCE must
  fail; code replay must be rejected.

## 3. Authorization & data isolation (`admin`, `organization`, `api-key`, `mcp`, `sso`, `scim`, `business/admin`)

- **IDOR**: a user must not read or mutate another user's or organization's resources by
  supplying a foreign ID (subscriptions, credits, orders, tickets, org members).
- **Role escalation**: a user must not be able to self-assign an admin/owner role; admin
  endpoints must reject non-admin sessions.
- **Impersonation**: admin impersonation must not be usable to perform admin mutations
  (business `authorize` blocks `impersonatedBy`), and must require the documented
  authorization.
- **API key scope**: a key created with a restricted scope must not be accepted for an
  out-of-scope action.
- **SCIM/SSO tenant isolation**: a SCIM/SAML request bound to one provider/tenant must not
  affect another.

## 4. Webhook & signed-notification replay (`stripe`, `paypal`, `waffo`, `media-engine`)

- **Replay**: the same signed webhook event delivered twice must be applied once
  (event dedup / idempotency key).
- **Ordering**: out-of-order events (e.g., `subscription.deleted` before `created`) must
  not corrupt state.
- **Signature**: tampering with the body after signing must fail verification (raw-body
  verification).

## 5. General / integration

- **SSRF**: generation/moderation adapters must reject or constrain internal/loopback
  targets when fetching user-influenced URLs.
- **Injection**: no `eval`/`new Function`/string-built SQL; Kysely parameterization.
- **Secrets**: gitleaks in CI must fail on new secret-pattern commits; `.env*` must stay
  ignored.
- **Dependencies**: `osv-scanner` (or `pnpm audit`) must fail CI when a runtime
  dependency crosses a severity threshold (see `remediation-plan.md`).

## 6. How tests are written

- Use `getTestInstance()` from `better-auth/test` (never `createAuthClient()`).
- Regression tests carry a `@see` link to the issue/advisory.
- Bug fixes: write the failing test first, then fix.
- Run with `pnpm exec vitest run <path> -t <pattern>`; never `pnpm test`.
