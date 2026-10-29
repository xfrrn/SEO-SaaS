# Attack Surface Inventory

This lists every externally reachable input surface, the trust assumption behind it, and
whether it was reviewed in this round. "Reviewed" means the source was traced; it does
not by itself certify the code is free of defects.

## 1. External HTTP request entry points (auth server)

All Better Auth endpoints are created via `createAuthEndpoint` / `createAuthEndpoint.serverOnly`.
Server-only endpoints are **not** reachable over HTTP — they are callable only from
trusted server code (used by webhooks and business/credits plumbing).

### 1.1 Authentication (core) — `packages/better-auth/src/api/`
| Surface | Auth | Notes | Reviewed |
|---|---|---|---|
| sign-up/email, sign-up/username | none (public) | password hashing, email/username uniqueness, enumeration surface | by agent 1 |
| sign-in/email, sign-in/username | none (public) | rate limiting, enumeration | by agent 1 |
| forget-password / reset-password | public | token generation, expiry, enumeration | by agent 1 |
| verify-email | token | token scope/expiry | by agent 1 |
| sign-out, get-session, list-sessions, revoke-session | session | session ownership | by agent 1 |
| sign-in/social, sign-in/oauth2, callback/*, oauth2/callback/* | public + state | OAuth state, PKCE, redirect_uri validation | by agent 1 |
| two-factor endpoints | session/token | TOTP, backup codes | by agent 1 |

### 1.2 Business / credits / subscription (app SDK) — `packages/business/src/index.ts`, `packages/credits/src/index.ts`
| Surface | Auth | Ownership binding | Reviewed |
|---|---|---|---|
| `/business/products`, `/business/orders/quote`, `/business/orders/create`, `/business/orders/checkout`, `/business/orders/complete`, `/business/orders`, `/business/orders/reconcile-checkout`, `/business/spending`, `/business/providers` | session | `referenceId = session.user.id`; order ownership re-checked | ✅ (author) |
| `/credits/balance`, `/credits/ledger` | session | `referenceId` defaults to user id; cross-user reads require `authorizeReference` | ✅ (author) |
| `/business/admin/**` (payment-stats, spending, products save/publish, orders, retry, credits/adjust, membership/adjust, customer, subscriptions, credits/ledger, overview, audit, monitor/**) | `authorize()` (role/adminUserIds) | admin-only; mutations audit-logged | ✅ (author) |
| `grantCredits`, `consumeCredits`, `revokeCreditsGrant` | `serverOnly` | trusted server code only | ✅ (author) |
| `confirmBusinessPayment/Renewal/Refund`, `runMonitorDelivery` | `serverOnly` | provider verification precedes writes | ✅ (author) |

### 1.3 Stripe — `packages/stripe/src/routes.ts`
| Surface | Auth | Notes | Reviewed |
|---|---|---|---|
| `/subscription/upgrade`, `/subscription/cancel`, `/subscription/restore`, `/subscription/list`, `/subscription/billing-portal` | session | `referenceMiddleware` resolves reference from session + `authorizeReference` for org/cross-user | ✅ (author) |
| `/subscription/success` | session (optional) | reads checkout session metadata (server-set) | ✅ (author) |
| `/stripe/webhook` | `Stripe-Signature` | raw body; `constructEvent*` | ✅ (author) |

### 1.4 PayPal / Waffo webhooks
| Surface | Auth | Notes | Reviewed |
|---|---|---|---|
| PayPal webhook route | PayPal verification | amount/currency/status capture check | by agent 3 |
| Waffo webhook route | `x-waffo-signature` | env/store binding; event dedup | by agent 3 |

### 1.5 Generation / moderation / tickets / media-engine
| Surface | Auth | Notes | Reviewed |
|---|---|---|---|
| generation jobs/adapters, private assets, SQL worker | session/host | SSRF, asset ACL, path traversal | by agent 3 |
| moderation workflow endpoints | session/host | moderation bypass, evidence integrity | by agent 3 |
| tickets endpoints | session | customer ownership, admin processing | by agent 3 |
| media-engine client + signed notifications/action receipts | signature | replay, key management | by agent 3 |

### 1.6 API key / MCP / OAuth provider / SSO / SCIM
| Surface | Auth | Notes | Reviewed |
|---|---|---|---|
| API key creation/verification | session/server | scope enforcement | by agent 2 |
| MCP authorization / OAuth provider endpoints | client credentials | scope, redirect_uri, PKCE | by agent 2 |
| SSO (SAML/OIDC) + SCIM | session/server | tenant isolation, IDOR | by agent 2 |

## 2. Third-party callbacks (trusted inbound)

- Stripe webhook (`checkout.session.completed`, `customer.subscription.*`)
- PayPal order/capture verification (pull-based)
- Waffo webhook (`order.completed`) + payment query
- AI Media Engine signed notifications/action receipts (cross-repo)

## 3. Admin & special privilege surfaces

- Better Auth `admin` plugin (impersonation, admin actions) — agent 2
- Organization RBAC (roles, permissions, member management) — agent 2
- Business admin endpoints (credits/membership adjustment, product catalog) — author ✅
- Admin audit log (append-only record of mutations) — author ✅

## 4. SDK public API / integration surface (Phase 3F)

- `@app/auth-sdk` exports: media-engine, api-key, mcp, i18n, redis-storage,
  generation/providers/kie, moderation, tickets, credits/subscription/business clients.
- Dangerous defaults to check: whether any server-only or admin capability is exported
  to client bundles, and whether any validation can be bypassed via a public method.

## 5. Third-party dependencies & external services

- Stripe, PayPal, Waffo Pancake (payments); OpenAI/Google/fal (generation); SeeAPI/Kie.ai
  (moderation/generation); Kysely (DB); Zod (validation); `@better-auth/*` internals.
- Dependency risk: audited via `osv-scanner` (lockfiles) and the pnpm `overrides`
  (known-vuln floor bumps) — see `tooling/`.

## 6. Data flows crossing trust boundaries

1. Client → server: sign-up/sign-in/password-reset payloads → user table (hash store).
2. Client → server: business order create/checkout → provider checkout URL (server holds
   amount/currency); browser completes at provider; webhook/verify → order reconcile →
   credits grant or subscription sync.
3. Provider → server: signed webhook → verified event → durable `businessPaymentEvent`
   dedup → fulfillment (credit grant / membership) within a transaction.
4. Admin → server: `adjustCredits`/`adjustMembership` → audit record + ledger/subscription
   mutation, idempotency-guarded.
5. Server → AI Media Engine: signed request + notification/action receipt verification.

## 7. Areas not yet reviewed (coverage gaps)

Tracked in `coverage.md`. Summary: dynamic runtime verification (beyond unit tests) was
not performed; the AI Media Engine repository itself is out of scope; live-provider and
production behavior are excluded.
