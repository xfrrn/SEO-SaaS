# Architecture & Trust Boundaries

Audit target: `@app/auth-sdk` workspace (`D:\codes\SEO\SEO-Backend-SDK`), a fork of the
[Better Auth](https://github.com/better-auth/better-auth) TypeScript authentication
framework, extended with payments, credits, subscriptions, media generation/moderation,
tickets, and business analytics. Audit date: 2026-10-28. Review scope: `packages/**`,
excluding `node_modules`, `dist`, and test fixtures except where noted.

## 1. Runtime model

- Language: TypeScript (ESM), targetting Node.js, Bun, Deno, and Cloudflare Workers.
  Runtime-specific APIs are avoided; `Uint8Array` replaces `Buffer` in production code.
- Package manager: pnpm (workspace). The consumer-facing artifact is `@app/auth-sdk`
  (`packages/app-sdk`), which re-exports the `@app/*` plugin packages.
- Data access: `better-auth` adapter abstraction over Kysely (PostgreSQL/MySQL/SQLite)
  and other adapters. Payment/credits code *requires* a SQL adapter with real
  transactions and unique indexes (`assertBusinessDatabase`).

## 2. Components

| Component | Path | Role |
|---|---|---|
| Auth core | `packages/better-auth` | Registration, sign-in, password reset, email verification, sessions, OAuth/OIDC client, 2FA, admin/audit, organization RBAC |
| Core utils | `packages/core` | Shared types, URL utils, error codes, OAuth2 primitives |
| App SDK | `packages/app-sdk` | Public entry points; server-only media-engine, moderation, generation, tickets, stripe/credits/subscription/business clients |
| Business | `packages/business` | Order ledger, checkout, purchase policies/quotes, payment reconciliation, admin credit/membership adjustment, analytics, monitor |
| Credits | `packages/credits` | Append-only balance ledger with grants/consumes/reservations (holds), expiry |
| Subscription | `packages/subscription` | Product catalog, subscription sync service |
| Stripe | `packages/stripe` | Stripe checkout/subscriptions/webhooks (server) |
| PayPal | `packages/paypal` | PayPal orders/captures/webhooks (server) |
| Waffo | `packages/waffo` | Waffo Pancake one-time payments/webhooks (server) |
| Generation | `packages/generation` | Image/video jobs, OpenAI/Google/fal adapters, private assets, SQL worker |
| OAuth provider | `packages/oauth-provider` | OAuth/OIDC authorization server |
| SSO / SCIM | `packages/sso`, `packages/scim` | SAML/OIDC SSO and SCIM provisioning |
| API key | `packages/api-key` | Programmatic API keys |
| MCP | `packages/mcp` | MCP OAuth authorization |
| Redis storage | `packages/redis-storage` | Secondary session/storage backend |
| i18n | `packages/i18n` | Auth API error translations |

## 3. Trust boundaries

```
Browser / native client
   │  (HTTPS; session cookie; CSRF via Fetch-Metadata + origin check)
   ▼
Auth SDK server (better-auth + plugins)  ── trusted server code ──►  SQL DB (adapter)
   │  ▲                                                    ▲
   │  │ signed webhooks (Stripe/PayPal/Waffo)              │
   ▼  │                                                    │
Payment providers (Stripe, PayPal, Waffo)          AI Media Engine (signed notifications)
```

1. **Client ↔ server** — authenticated by session cookie (Better Auth sessions).
   State-changing endpoints validate origin (CSRF) and redirect targets against
   `trustedOrigins`. User-facing business endpoints bind `referenceId` to the
   authenticated `session.user.id`, never to client-supplied IDs.
2. **Server ↔ payment providers** — outbound: API keys held server-side. Inbound
   webhooks are authenticated by provider signatures (`Stripe-Signature`,
   `x-waffo-signature`, PayPal verification) against the raw request body before any
   local write.
3. **Server ↔ DB** — the adapter/Kysely layer is parameterized; no string-built SQL.
   Payment/credits code relies on real transactions + unique indexes for
   idempotency and concurrency control.
4. **Server ↔ AI Media Engine** — cross-repository boundary; signed notifications and
   action receipts (SDK 0.4.0). The SDK retains auth/payments/credits and a thin
   service client; generation/moderation execution is centralized in AI Media Engine.
5. **Server ↔ third-party LLM/image providers** (OpenAI/Google/fal, SeeAPI, Kie.ai) —
   outbound only, tenant-bound opaque request keys; no live-provider acceptance in
   this repo.

## 4. Key security mechanisms observed

- **Sessions**: cookie-based with `HttpOnly`/`Secure`/`SameSite` handling in
  `packages/better-auth/src/cookies/`; session tokens via cryptographic RNG.
- **CSRF / open redirect**: `originCheckMiddleware` + Fetch-Metadata based
  `formCsrfMiddleware` (`packages/better-auth/src/api/middlewares/origin-check.ts`);
  redirect targets validated against `trustedOrigins`; dangerous schemes
  (`javascript:`, `data:`, `vbscript:`) blocked in `appendQueryParams`/`isSafeUrlScheme`.
- **Webhooks**: Stripe `constructEvent*` with raw body; Waffo signature verify with
  environment/store binding; PayPal capture verification.
- **Order ledger** (`packages/business/src/service.ts`): durable idempotency keys
  (`businessPaymentEvent`), ownership checks, provider-side amount/currency/status
  verification, quote-version binding, transaction-serialized per-customer writes.
- **Credits ledger** (`packages/credits/src/service.ts`): append-only, sequence +
  balance + batch integrity checks, reservations that cannot be double-settled.
- **Admin**: `authorize()` middleware requires session + role/adminUserIds + no
  impersonation; mutations record an audit event.

## 5. Explicit assumptions / deferred items

- Live paid calls, production deployment, and the AI Media Engine implementation are
  separately authorized and are **not** exercised by this audit.
- Dynamic testing is limited to local, in-memory/SQLite fixtures; no real payment
  providers, real user accounts, or production systems are contacted.
