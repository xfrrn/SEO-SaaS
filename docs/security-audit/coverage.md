# Audit Coverage & Unreviewed Areas

This records what was reviewed in this round, by whom, and what remains unexamined.
It is a coverage ledger, not a claim of correctness for the reviewed code.

## 1. Coverage map

| Area | Path | Reviewed by | Depth |
|---|---|---|---|
| Payment core (Stripe/PayPal/Waffo adapters, webhook signature verify) | `packages/stripe`, `paypal`, `waffo` | author (direct read) | Full — routes, business adapters, middleware |
| Order ledger / purchase policy / quotes / reconciliation / admin mutations | `packages/business` | author | Full — service, purchase-policy, validation, index routes+authz |
| Credits ledger + reservations | `packages/credits` | author | Full — service, reservations, index routes |
| Subscription catalog/sync | `packages/subscription` | author (partial) + agent 3 | service/type surface |
| Auth core (sign-up/in, reset, verify, sessions, OAuth, 2FA, cookies, CSRF, rate limit) | `packages/better-auth/src` | agent 1 | Full, 12 findings |
| Admin / organization RBAC / API key / MCP / OAuth provider / SSO / SCIM / redis / memory | `packages/better-auth/src/plugins/*`, `packages/{oauth-provider,sso,scim,api-key,mcp,redis-storage,memory-adapter}` | agent 2 | Full, 5 findings |
| Media-engine / moderation / generation / tickets / provider webhook routes | `packages/app-sdk/src/*`, `packages/generation` | agent 3 | in progress |
| Cross-cutting (injection, SSRF, secrets, weak RNG, dangerous defaults, redirect/CSRF primitives) | all `packages/*` | author (grep + read) | broad sweep |
| Dependency vulnerabilities | `pnpm-lock.yaml`, all `package.json` | author (osv-scanner) + tooling | Full triage |
| Secrets in source/history | git history | author (gitleaks) | 103 leads triaged → no production secret |
| Static analysis (Semgrep) | `packages/*` | tooling | running/pending |

## 2. Tool results

- **gitleaks** (9776 commits): 103 leads — all test fixtures, docs/examples, empty
  `.env.example` placeholders, UUID/hash false positives, or files removed from HEAD.
  No committed production secret.
- **osv-scanner**: 116 unique advisories (9 critical / 56 high / 45 moderate / 17 low)
  across the dependency tree. Triaged in `findings.md` — runtime-relevant subset
  (node-forge, @xmldom/xmldom via samlify, zod, sharp, fast-uri) flagged; the rest are
  dev/build/example dependencies.
- **semgrep** (`p/default` + `p/security-audit`): did not complete within ~30 min on the
  full ruleset (killed). The surface it would cover (injection/XSS/SSRF patterns) was
  instead covered by manual grep + three independent agent passes; no Semgrep-only leads
  were used. A narrower per-package Semgrep run is recommended in CI (see
  `remediation-plan.md`).

## 3. Not reviewed / out of scope (explicit)

1. **AI Media Engine repository** (`<../AI Media Engine>`) — cross-repo. The SDK side of
   the media boundary (signed notifications/action receipts) is reviewed; the Engine's
   own implementation is not.
2. **Dynamic runtime verification** — findings were verified by code trace and existing
   unit tests only. No live fuzzing, no new runtime harnesses were built against the
   target, and no real provider/user/production system was exercised (per execution
   boundary).
3. **Live paid calls & production deployment** — separately authorized; not performed.
4. **`apps/dashboard`, `examples`, `demo`, `e2e`** — not part of the shipped SDK; only
   the dashboard's `.env.example` and dependency surface were inspected.
5. **Third-party provider SDK internals** (`stripe`, `samlify`, `node-forge`, `@xmldom/xmldom`
   source) — treated as dependencies; advisories noted, but their code was not audited.

## 4. Residual risk after this round

- Dependency advisories whose exact reachability in `samlify`'s internals was not
  confirmed (node-forge sig-verify vs key-parse; xmldom parse-before-signature order).
- Findings marked **Needs Validation** require a runtime reproduction to promote to
  **Confirmed** (see `test-plan.md`).
- Concurrency/race paths were reasoned about from the transaction+unique-index design
  rather than load-tested.
