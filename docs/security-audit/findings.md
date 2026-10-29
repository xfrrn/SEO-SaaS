# Security Findings

Audit date: 2026-10-28. Scope: `packages/**` (SDK + plugins), excluding `node_modules`,
`dist`, and test fixtures except where noted. Method: manual source review, three
independent deep-audit passes (auth core; authorization/identity; media+payment
integrations), and local scanners (Semgrep, Gitleaks, OSV-Scanner). Every finding was
verified against the source by a reviewer who did not originate it (Phase 4).

Severity scale: **Critical** (unauthenticated, no special config, direct compromise),
**High** (compromise or privilege escalation under a realistic condition),
**Medium** (bounded impact or opt-in/config-dependent), **Low** (hardening/default).

Verdict scale: **Confirmed** (code path + impact established), **Needs Validation**
(code path established; exploitability or exact impact still open), **False Positive**
(rejected).

> Honest summary: no **Critical** was confirmed. The codebase is unusually well
> hardened — the payment/credits/order core (transactions, idempotency, ownership,
> provider re-verification) and the CSRF/redirect/origin machinery held up to close
> review. The real issues cluster in **defaults that fail open**, **one authorization
> invariant missing from a single endpoint**, and **stale dependency security floors**.

## Fix status (2026-10-28 → 2026-10-29, two remediation rounds)

Applied and covered by regression tests:

- **H1** fixed — `validateSecret` now rejects `DEFAULT_SECRET` in every non-test
  environment, not only when `NODE_ENV=production`.
- **H2** fixed — `updateMemberRole` now refuses to assign a role whose permissions the
  caller does not itself hold (mirrors `createOrgRole`/`updateOrgRole`).
- **H3** fixed (dependency floors) — `node-forge` → `>=1.4.1`, `@xmldom/xmldom` →
  `>=0.8.15`, `zod` → `^4.6.6` (also closes **M9**) in `pnpm-workspace.yaml`.
- **M1** fixed — `enableSessionForAPIKeys` rejects permission-scoped keys and banned
  users instead of minting a full session.
- **M2** fixed — `applyMediaEngineAction` now accepts the Admin plugin's
  `adminRoles`/`adminUserIds` and protects those administrators.
- **M3** fixed — moderation `authorize`/`validateContent`/`validateConsent`/`erase`
  callbacks now return `Promise<void | false>` and a `false` return is rejected at every
  call site instead of being treated as success.
- **M4** fixed — cleanup re-checks the legal-hold/restricted state inside the final
  deletion transaction, so a record that becomes `legal_hold` during the erase window
  survives.
- **M6** fixed — the direct `id_token` sign-in path is rejected when the provider sets
  `requiresIdTokenNonce` (no server-issued nonce can bind it on that path).
- **M5** fixed — `verifyEmail` atomically claims each token via
  `reserveVerificationValue`, so a leaked verification link cannot be replayed to
  re-verify or re-mint a session.

Assessed as intentional/documented design trade-offs (not code-changed — see note in the
relevant finding): **M7** (`X-Forwarded-For` trust default), **M8** (fail-closed shared
rate-limit bucket).

### L-series hardening (2026-10-29)

Applied:

- **L1/L2/L3** dependency floors raised — `sharp` → `>=0.35.5`, `fast-uri` → `>=3.1.9`,
  `seroval` → `>=1.6.3`, `shell-quote` → `>=1.11.0` in `pnpm-workspace.yaml`.
- **L5** — `requestPasswordReset` now enforces a 500ms constant-time floor so
  "email not found" and "email found" paths are not distinguishable by response time.
- **L10** — 2FA trust-device MAC now compares via `constantTimeEqual`.
- **L11** — the organization dynamic-role cache is invalidated on create/update/delete
  role, so authorization decisions no longer read a stale snapshot.
- **L15** — credits balance/ledger and subscription list reads use the authoritative
  session (not the cookie cache) and reject banned/impersonated sessions.
- **L14** — PayPal webhook verification rejects oversized bodies before any outbound
  call, and the dashboard payment webhook route enforces a `Content-Length` cap.

Not code-changed (documented as recommendations): **L4**, **L6**, **L7**, **L8**
(documented defaults), and **L9**, **L12**, **L13**, **L16**, **L17** (larger
design changes or type-ripple risk) — see `remediation-plan.md`.

Remaining L1–L17 are hardening items tracked in `remediation-plan.md`.

---

## HIGH

### H1 — Default secret is accepted silently on runtimes without `NODE_ENV=production`, enabling forged verification JWTs → account takeover
- **Verdict:** Confirmed (code path) / deployment-dependent exploitability
- **Files:** `packages/better-auth/src/utils/constants.ts:1`; `context/create-context.ts:61-96,173-190`; `core/src/env/env-impl.ts:52`; `api/routes/email-verification.ts:302-325,371-478`
- **Data flow:** `DEFAULT_SECRET = "better-auth-secret-12345678901234567890"` (public). `validateSecret()` throws for it **only when `isProduction`**, and `isProduction` is `nodeENV === "production"`. On runtimes that don't set `NODE_ENV` (plain `node`/Docker, many Workers/Deno deployments), the 41-char default passes both the length (≥32) and entropy (~177 bits) checks **silently**. `ctx.context.secret` then signs HS256 email-verification JWTs. An attacker who knows the constant mints `{ email: victim, requestType: "email-verification" }` (or `"change-email-verification"`) and calls `/verify-email`; the handler verifies only the signature, then `createSession()` for the victim and (in the change-email branch) rewrites `email` + `emailVerified: true`.
- **Impact:** unauthenticated account takeover (session minting + email rewrite). In stateless/`cookieCache:JWE` mode the same secret also encrypts the session cache, allowing direct session forgery.
- **Fix:** fail closed regardless of `NODE_ENV` — treat `secret === DEFAULT_SECRET` as a hard error whenever not explicitly in a test, or require an explicit `secret`. See `remediation-plan.md`.

### H2 — Organization `updateMemberRole` lets a role holder grant permissions it does not hold (privilege escalation)
- **Verdict:** Confirmed (config-dependent: custom roles / dynamic ACL)
- **Files:** `packages/better-auth/src/plugins/organization/routes/crud-members.ts:618-680,682-716,775-778`; contrast `routes/crud-access-control.ts:239-247,1034-1042` (`checkIfMemberHasPermission`)
- **Data flow:** The handler checks only `hasPermission({ permissions: { member: ["update"] } })`, validates that the requested role *name exists*, and writes it. It never checks that the requested role's permission set is a subset of the caller's. The sibling `createOrgRole`/`updateOrgRole` endpoints *do* enforce "you may not grant permissions you don't hold", establishing the intended invariant.
- **Impact:** any custom role granted `member:update` (e.g. "manager") can promote itself or any member to `admin` or a role carrying `ac:*`, `organization:delete`, etc. Default roles are not affected (only `admin`/`owner` hold `member:update`).
- **Fix:** run the same `checkIfMemberHasPermission` subset test for `roleToSet` before writing.

### H3 — Stale pnpm security floors pin vulnerable transitive SAML dependencies (`node-forge`, `@xmldom/xmldom`)
- **Verdict:** Confirmed (vulnerable versions present) / reachability Needs Validation
- **Files:** `pnpm-workspace.yaml` overrides (`node-forge: '>=1.4.0 <2'`, `'@xmldom/xmldom@<0.8.13': '>=0.8.13 <0.9'`); resolved `node-forge@1.4.0`, `@xmldom/xmldom@0.8.13` (via `packages/sso` → `samlify@2.13.1`)
- **Advisories:** `node-forge@1.4.0` → GHSA-86w9-cpqp-85rv / CVE-2026-33894, CVE-2026-85393 (RSA PKCS#1 v1.5 signature verification accepts extra nested `DigestAlgorithm` elements — signature-verification weakness). `@xmldom/xmldom@0.8.13` → CVE-2026-83605…83619 (element/attribute/doctype name injection bypassing `requireWellFormed`, quadratic-time parsing, memory exhaustion).
- **Impact:** SSO/SAML is a security boundary; its signature verification and XML parsing run through `samlify` on these versions. A malicious IdP (or, in SP-initiated flows, a crafted response) could exploit signature-verification weakness or XML-ReDoS.
- **Fix:** bump the override floors to patched versions (verify the fixed ranges for both advisories) and add a lockfile/CI gate. The exact fixed versions must be confirmed against OSV before applying.

---

## MEDIUM

### M1 — `apiKey({ enableSessionForAPIKeys: true })` turns a permission-scoped key into a full session and ignores ban state
- **Verdict:** Confirmed (opt-in)
- **Files:** `packages/api-key/src/index.ts:150-157,204-211,241-262`; `routes/verify-api-key.ts:116-131`; `plugins/admin/routes.ts:1166-1167`
- **Data flow:** the `before` hook calls `validateApiKey` **without** `permissions`, then injects a full user session. The key's `permissions` JSON is never consulted, and neither path checks `user.banned`. A read-only-scoped key can therefore call `/api-key/create` (mint a new key + receive the secret), `/api-key/list`, password/email changes, etc.; a banned user's pre-existing key keeps working.
- **Fix:** reject session-mocking for keys that carry `permissions` (or evaluate them against endpoint requirements), and check `user.banned` on the mocked-session path.

### M2 — Media-engine action helper ignores configured `adminRoles` / `adminUserIds`, so administrators can be banned
- **Verdict:** Confirmed
- **Files:** `packages/app-sdk/src/media-engine-actions.ts:51-61` (line 60); `docs/media-engine-usage.md:34`
- **Data flow:** `applyMediaEngineAction` protects only `user.role?.split(",").includes("admin")`. The Admin plugin's `adminRoles` and `adminUserIds` are not consulted. A verified `ban`/`revoke_session` action for an administrator configured via `adminRoles: ["moderator"]` (or `adminUserIds`) falls through to `banned: true` + full session deletion, contradicting the documented "administrator actions return a failed receipt for manual handling" contract.
- **Fix:** pass the admin plugin options into the helper and treat `adminUserIds.includes(id)` or `role ∈ adminRoles` as protected.

### M3 — Moderation host callbacks fail open when implemented as boolean predicates
- **Verdict:** Needs Validation (SDK integration / fail-open default)
- **Files:** `packages/app-sdk/src/moderation/runtime.ts:58-65`, `analysis.ts:116-126`, `execution.ts:54-97`, `cleanup.ts:198-208`, `host-types.ts:34,72-78`
- **Data flow:** `authorize`, `validateContent`, `validateConsent`, and `erase` return values are discarded; only a thrown error denies. A host that returns `Promise<boolean>` (e.g. `authorize: async () => isAllowed`) compiles but returning `false` is treated as success.
- **Fix:** type the callbacks to return `void` and require throwing `APIError` to deny (or check a truthy result and reject on `false`), and add a fixture test that returns `false` and asserts denial.

### M4 — Legal-hold evidence can be deleted by a cleanup race (TOCTOU)
- **Verdict:** Needs Validation
- **Files:** `packages/app-sdk/src/moderation/cleanup.ts:190-270,277-395` (planning-time hold check at 322-347; final delete by `(tenant,kind,key)` at 215-226)
- **Data flow:** `legal_hold` is checked only during planning; `erase()` runs outside the transaction, then a second transaction deletes every planned candidate without re-reading the current decision. A review resolving to `legal_hold` during the `erase` window is ignored and its evidence is destroyed.
- **Fix:** re-assert the legal-hold/restricted state inside the final deletion transaction, or delete with a predicate that excludes currently-held records.

### M5 — Email-verification tokens are non-revocable bearer JWTs that mint sessions
- **Verdict:** Confirmed (design) / exposure Needs Validation — **Fixed 2026-10-29**
- **Files:** `packages/better-auth/src/api/routes/email-verification.ts`
- **Data flow:** `verifyEmail` trusted a self-contained JWT and never checked a server-side row; the link was replayable until expiry, created sessions even when `autoSignInAfterVerification` was false, and was not invalidated when the email changed.
- **Fix:** `verifyEmail` now atomically claims each token via `internalAdapter.reserveVerificationValue` (first-writer-wins replay tombstone keyed by `email-verification-replay:<sha256(token)>`, expiring with the JWT). A replayed link is rejected; secondary-storage-only verification falls back to a best-effort find-then-create.

### M6 — Direct `id_token` sign-in accepts a client-supplied nonce (replayable assertion)
- **Verdict:** Needs Validation
- **Files:** `packages/better-auth/src/api/routes/sign-in.ts:275-311`, `account.ts:268-295`; `core/src/oauth2/verify-id-token.ts:101-106`
- **Data flow:** the nonce check runs only `if (nonce && ...)`, and the expected value is supplied by the same client (or omitted). There is no server-issued challenge. A captured provider ID token is replayable within its lifetime.
- **Fix:** require a server-issued, state-bound nonce on the direct-id-token path (or reject when absent), consistent with the redirect-callback path.

### M7 — Rate limiting keyed on spoofable `X-Forwarded-For` by default
- **Verdict:** Needs Validation (deployment-dependent)
- **Files:** `packages/core/src/utils/ip.ts:345-385`, `better-auth/src/api/rate-limiter/index.ts:337-410`
- **Data flow:** without `trustedProxies`, a single `X-Forwarded-For` is trusted; rotating it gives a fresh bucket for `/sign-in/email`, `/request-password-reset`, `/two-factor/*`.
- **Fix:** default `trustedProxies` to `[]` + require the socket address when forwarded headers are untrusted (or document + enforce a safe default). See also M8.

### M8 — Fail-closed shared rate-limit bucket enables global sign-in/reset lockout
- **Verdict:** Confirmed behavior / impact Needs Validation
- **Files:** `packages/better-auth/src/api/rate-limiter/index.ts:335-360,439-467`; `core/src/utils/ip.ts:333-336`
- **Data flow:** when IP resolution returns `null`, every request keys to `no-trusted-ip|<path>`, so 3 requests/10s globally deny sign-in/reset to everyone.
- **Fix:** don't collapse unknown IPs into one shared bucket; either skip rate limiting (logged) or key on a bounded per-request value only after a documented decision.

### M9 — `zod@4.5.4` memory-exhaustion DoS (CVE-2023-54404) on runtime validation
- **Verdict:** Confirmed (version present) / reachability Needs Validation
- **Files:** `pnpm-lock.yaml`; `zod` used as runtime validation across `@app/*` and `better-auth`
- **Impact:** oversized constrained collections (`array().max()`, `string().max()`, …) can exhaust memory during validation. Mitigated only by host HTTP body limits.
- **Fix:** bump zod past the fixed version (confirm against OSV) and/or enforce request body size limits in the SDK's HTTP adapters.

---

## LOW (hardening / defaults)

- **L1** `sharp@0.35.3` (libheif/librsvg) — `packages/generation` image handling; needs untrusted-image input. Bump + verify. (CVE-2026-114111/114112)
- **L2** `fast-uri@3.1.5` SSRF-family advisories — transitive via `ajv`; not reachable through SDK URL handling today. Bump anyway.
- **L3** Dev/example-only advisories (`seroval` CVE-2026-104846 CRITICAL, `shell-quote` CVE-2026-102422 CRITICAL, `@modelcontextprotocol/*`, `next`, `electron`, `vite`, …) — not in the shipped SDK; bump for dev hygiene.
- **L4** 2FA not enforced on alternate sign-in flows (OAuth/magic-link/OTP/passkey) — documented revert; a 2FA account is only as strong as its weakest enabled method.
- **L5** Timing-based account enumeration on password reset (`password.ts:105-147`) — no constant-time floor unlike email-verification.
- **L6** Sign-up reveals existing accounts by default (`sign-up.ts:225-321`) — documented opt-in generic response.
- **L7** Password reset does not revoke existing sessions by default (`password.ts:326-328`).
- **L8** Cookie-cache sessions delay revocation up to `maxAge` (`session.ts:114-285`) — documented; sensitive ops already use authoritative session.
- **L9** Reset token reflected into callback URL query (`password.ts:130-137,211-230`).
- **L10** 2FA trust-device MAC compared non-constant-time (`two-factor/index.ts:463-520`) — not independently forgeable.
- **L11** Organization dynamic-role cache never invalidated and is process-global (`has-permission.ts:26-77`) — stale authorization snapshot + unbounded memory.
- **L12** SSO provider registration accepts arbitrary domain claims → domain squatting/routing to attacker IdP (`sso/routes/sso.ts:407-527,1039-1092`).
- **L13** Admin impersonation has no re-authentication step-up (`admin/routes.ts:1194-1328`) — hardening.
- **L14** Public payment webhook route has no body-size/rate limit; PayPal verification makes outbound calls before signature check (`apps/dashboard/app/api/payments/webhook/route.ts`, `packages/paypal/src/index.ts:412-451`) — DoS/quota amplification.
- **L15** Credits/subscription read routes use cached sessions and skip `banned`/`impersonatedBy` checks (`packages/credits/src/index.ts:94-118`, `packages/subscription/src/index.ts:147-165`) — inconsistent with business endpoints.
- **L16** `publicOrder` exposes `checkoutKey`/`providerKey` (`packages/business/src/service.ts:39-42`) — SHA-256 digests, no client-accepting endpoint; strip anyway.
- **L17** `applyMediaEngineAction` deletes sessions but not API keys; `verifyApiKey` doesn't consult `user.banned` — hosts should revoke keys independently.

## Rejected (investigated, no finding)

- Webhook signature/raw-body verification (Stripe `constructEvent*`, Waffo RSA+env/store binding, PayPal forwarded verification) — no bypass found.
- SSRF in generation adapters (redirects re-validated against configured HTTPS hosts; input refs resolved by host callbacks).
- Moderation bypass, ticket IDOR, subscription price tampering, private-asset path traversal — all defended.
- SQL injection, `eval`/`child_process`, hardcoded production secrets, weak token RNG, missing cookie flags — none found (see `coverage.md`).
