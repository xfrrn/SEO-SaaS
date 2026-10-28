# Remediation Plan & Continuous Security

Priorities: **P0** (fix now, high value, low risk) → **P1** (fix now, needs care) →
**P2** (fix this cycle) → **P3** (hardening, schedule). Every fix ships with a
regression test; payment/auth/webhook behavior must not regress (see `test-plan.md`).

## P0 — fix first

1. **H1 default-secret fail-open.** In `validateSecret`, change the gate from
   `isDefaultSecret && isProduction` to `isDefaultSecret && !isTest()` so a hard-coded
   secret is a hard error everywhere except the test runner (which already sets
   `NODE_ENV=test`). Test: init with `NODE_ENV` unset + default secret → expect throw.
2. **H2 `updateMemberRole` escalation.** Reuse `checkIfMemberHasPermission` to reject a
   `roleToSet` that contains permissions the caller does not hold (mirroring
   `createOrgRole`/`updateOrgRole`). Test: a `manager` role with `member:update` cannot
   promote itself/another member to `admin` (expect 403).
3. **H3 dependency floors.** Confirm the patched versions for `node-forge` and
   `@xmldom/xmldom` against OSV, then bump the `pnpm-workspace.yaml` overrides and
   re-lock (`pnpm install --lockfile-only`). Test: `osv-scanner` no longer flags the
   runtime SAML path; `pnpm install --frozen-lockfile` passes.

## P1 — fix this cycle

4. **M1 API-key session mock.** Reject `enableSessionForAPIKeys` for keys carrying
   `permissions`, and check `user.banned` before injecting the session. Test: a
   scoped key cannot call `/api-key/create`; a banned user's key is rejected.
5. **M2 media-engine admin protection.** Thread the admin plugin's `adminRoles` +
   `adminUserIds` into `applyMediaEngineAction` and protect those users. Test:
   `adminRoles: ["moderator"]` user → ban action returns
   `{ status: "failed", reason_code: "ACTION_ADMIN_REVIEW_REQUIRED" }`.
6. **M3 moderation fail-open callbacks.** Type `authorize`/`validateContent`/
   `validateConsent`/`erase` to return `void` and throw `APIError` to deny, and reject an
   explicit `false` result. Test: `authorize: async () => false` denies.
7. **M4 legal-hold cleanup race.** Re-check the current legal-hold/restricted state
   inside the final deletion transaction. Test: pause `erase`, insert `legal_hold`, then
   assert records survive.

## P2 — fix this cycle (lower risk but real)

8. **M5 verification-token revocability.** Bind email-verification tokens to a server-side
   single-use record (or embed `userId` + version). Test: token replay is rejected.
9. **M6 id_token nonce.** Require a server-issued, state-bound nonce on the direct
   `idToken` sign-in path. Test: replaying a captured id_token without nonce fails.
10. **M7/M8 rate-limit IP trust + shared bucket.** Do not trust a single `X-Forwarded-For`
    without `trustedProxies`; do not collapse unknown IPs into one global bucket.
11. **M9 zod bump.** Move `zod` past the fixed version; confirm against OSV.

## P3 — hardening (schedule; many are documented defaults)

L1 `sharp`, L2 `fast-uri`, L3 dev deps; L5 reset-timing constant-time floor; L9 token in
callback URL (POST + hash fragment); L11 dynamic-role cache invalidation; L12 SSO domain
ownership; L14 webhook body-size/rate limits + verify-before-call; L15 credits/subscription
authoritative session; L16 strip internal keys from `publicOrder`; L17 revoke API keys on
ban. L4/L6/L7/L8/L10/L13 are documented defaults — add docs/hardening config, not breaking
changes.

---

# Phase 6 — Continuous security mechanism (CI/CD increment)

Extend `.github/workflows/sdk.yml` (currently build + typecheck + tests + pack). Add a
`security` job that runs on every PR and `main`, and blocks merge on findings:

## 1. Pull-request incremental checks (fast, always on)

- **Semgrep** (`p/default`, JSON + SARIF) over `packages/`; fail on any `error`-severity
  rule in the diff; annotate PR via SARIF upload.
- **Gitleaks** `detect` (working tree + `--log-opts` for the PR range); fail on any new
  secret. Provide a `.gitleaks.toml` allow-list for the known test fixtures.
- **Diff-scoped review**: run the security checks only on changed files for PRs (cheap),
  and a full scan on `main` pushes.

## 2. Dependency risk

- **osv-scanner** on `pnpm-lock.yaml` each PR; fail when a *runtime* dependency of the
  shipped SDK crosses a threshold (Critical/High). Keep the `overrides` floor in sync with
  a monthly `osv-scanner` pass; gate on `--fail` severity.
- Keep `minimumReleaseAge`/`trustPolicy` and the curated `overrides`; treat them as
  security controls with a changelog.

## 3. Secrets & hygiene

- Gitleaks on every push (no secrets in history going forward); `git-secrets`-style
  pre-commit is optional.
- Reject committed `.next`/build artifacts and `.env*` (already ignored; add CI guard).

## 4. Core-module regression gates (blocking)

- A dedicated `test:security` suite (Vitest) covering the `test-plan.md` scenarios:
  payment idempotency/ownership/refund, webhook signature rejection, auth enumeration
  resistance, org role escalation, API-key scope, credits overdraw/reservation.
- Wire it into CI and treat failures as release-blockers.

## 5. Periodic full-repo audit

- Scheduled (cron/weekly) full `semgrep + gitleaks + osv-scanner` over the whole repo,
  plus a re-run of the manual checklist (this report) on a fixed cadence, with findings
  triaged into `findings.md`.

## Execution order for this change set

1. Apply P0 fixes + tests; run `pnpm test:sdk` and `pnpm typecheck`.
2. Apply P1 fixes + tests.
3. Apply the CI `security` job.
4. Commit and push (separate, conventional-commit messages), then P2/P3 as follow-ups.
