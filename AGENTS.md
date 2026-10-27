# Better Auth Development Guide

This is the Better Auth repository - a comprehensive authentication framework for TypeScript, designed to be runtime and framework-agnostic.

## Approved media platform migration target

The user approved implementing the [cross-repository media migration plan](<../AI Media Engine/docs/media-platform-migration-plan.md>) on 2026-10-27: centralize generation and moderation execution in AI Media Engine and retain authentication, payments, credits, and a thin service client here. Follow its actual handoff status and verification evidence. Inventory consumers and preserve current generation/moderation exports until the migration and retirement checks pass; do not start a second executor in aimeme or remove capabilities merely because aimeme has not enabled them. Live paid calls and production deployment remain separately authorized actions.

## Project Structure

- `packages/better-auth` - Main authentication library
- `packages/core` - Shared core types and utilities
- `packages/app-sdk` - Application SDK entry points, re-exporting authentication, subscription, credits, and payment packages
- SDK 0.4.0 adds server-only `@app/auth-sdk/media-engine`, signed notifications/action receipts, expiring signing-key overlap and native credits 0.2.0 reservations/host SQL transactions. New website consumers use the remote client; Engine reuses the fixed 0.4.0 moderation core, including the counter-window action-obligation fix. See `docs/media-engine-usage.md` and `docs/sdk-0.4.0.md`.
- `packages/i18n` - Authentication API error translations; bundled with the SDK through `@app/auth-sdk/i18n`, `/i18n/client`, and `/i18n/locales`; opt-in registration, no page or email translation
- `packages/api-key`, `packages/redis-storage`, `packages/mcp` - Native programmatic authentication, Redis secondary storage, and MCP authorization; SDK 0.2.0 bundles them with the MCP OAuth Provider dependency. Host opt-in, database migrations and route authorization remain required; ioredis is an optional SDK peer
- `packages/business/src/analytics` - Verified local payment totals, UTC day/month trends, registration cohort conversion and per-user lifetime spending; currencies stay separate
- `packages/app-sdk/src/tickets.ts` and `src/tickets/` - Independent feedback ticket plugin, schema, customer ownership, administrator processing and immutable conversation history
- `packages/app-sdk/src/moderation.ts` and `src/moderation/` - Server-only moderation workflow, detectors, SQL evidence, authorization and lifecycle; host contracts and production validation boundaries in `docs/moderation-usage.md`
- SDK 0.3.0 adds optional SeeAPI text/image/video NSFW detection and Kie.ai Market image/video generation. Exact scopes, opaque tenant-bound request keys, additive provider evidence and host bridge contracts are in `docs/seeapi-kie-usage.md`; no live-provider acceptance or website deployment is implied
- `packages/subscription` - Provider-neutral subscription plugin (`@app/subscription`), shared schema, types, and tests
- `packages/credits` - Provider-neutral credits balance and append-only ledger plugin (`@app/credits`) and tests
- `packages/generation` - Provider-neutral image/video jobs, OpenAI/Google/fal adapters, private assets and host-driven SQL worker (`@app/generation`); host contracts and recovery boundaries in `packages/generation/README.md`
- `packages/paypal` - Standalone PayPal client (`@app/paypal`) and tests
- `packages/waffo` - Official Waffo Pancake SDK exports and one-time Business payment adapter (`@app/waffo`), Node.js 20+ only
- `packages/*` - Database adapters, plugins, integrations
- `test/` - Shared test workspace
- `scripts/` - SDK packaging and packaging tests
- `README.md` and `packages/app-sdk/README.md` - SDK usage documentation

## Commands

- ALWAYS use `pnpm` (never npm, yarn, or bun)
- NEVER run `pnpm test`. Use `pnpm test:sdk` or `pnpm exec vitest run path/to/test -t <pattern>`
- Build the main SDK: `pnpm build:sdk`; build all packages: `pnpm build`
- Package for consumers: `pnpm pack:sdk` (creates `dist/auth-sdk.tgz` with local workspace runtime dependencies bundled)
- Verify packaging: `pnpm test:packaging`
- Type check: `pnpm typecheck`
- After changing a dependency version in `package.json` or `pnpm-workspace.yaml`, run `pnpm install --lockfile-only` from the workspace root to avoid unrelated lockfile updates. Verify with `pnpm install --frozen-lockfile`.
- Format with `pnpm format`; check code with `pnpm lint`. No automatic commit hooks are installed.

## Writing Code

- Must work across Node.js, Bun, Deno, and Cloudflare Workers. Avoid runtime-specific APIs.
- Biome (tabs for code, 2 spaces for JSON)
- NEVER use `any`. NEVER use classes.
- Use `Uint8Array` instead of `Buffer` (except in tests)
- Import zod as `import * as z from "zod"`
- Use `import type` for type-only imports
- Use `node:` protocol for Node.js built-ins (e.g. `node:crypto`)
- JSDoc comments for public APIs
- The Better Auth CLI package was renamed from `@better-auth/cli` to `auth`. Use `npx auth@latest` in docs and user-facing messages, while preserving historical references in changelogs and explanations of the rename.
- Plugins should be as independent as possible. When working on a plugin, prefer modifying the plugin over changing core.

### URL Composition

- When appending query parameters to callback or redirect URLs, use `appendQueryParams` from `@better-auth/core/utils/url`. Keep origin and trust validation separate.

```ts
const params = new URLSearchParams({ error });
const redirectURL = appendQueryParams(errorURL, params);

throw ctx.redirect(redirectURL);
```

### Placeholder Emails

`User.email` is currently required and unique, which is a limitation of the current architecture.

When a flow must synthesize an email, use `createPlaceholderEmail` with a stable identifier and namespace. Keep placeholder emails unverified, and preserve flows that delegate generation to user code.

## Issue Triage and Architecture

- A reproducible error is not automatically a bug. First prove the behavior violates Better Auth's documented contract, TypeScript contract, or established runtime semantics.
- Before changing public API behavior, check existing docs, generated/inferred types, endpoint metadata, release history, and git history for the relevant code path. Treat long-standing metadata such as `requireHeaders`, `requireRequest`, endpoint method, schema, and middleware as part of the API contract.
- For regression claims, compare the exact reported versions or tags. If the behavior existed before the claimed version, classify it as expected behavior, documentation gap, or integration misuse unless another contract proves otherwise.
- Distinguish invalid usage from valid empty state. Example: a server session check without request headers is invalid usage; a server session check with headers but no session cookie is a valid request that returns `null`.
- Do not weaken TypeScript guidance to make runtime behavior more permissive unless that is the explicit architectural decision. Optional input types can hide integration bugs from users and agents.
- Prefer docs or clearer error messages over API-contract changes when the current behavior is intentional but confusing.
- When reviewing or patching external issue PRs, validate both the issue and the proposed fix against the surrounding contract before improving the PR. If the PR changes a long-standing contract, call that out before pushing changes.

## Testing

- SDK and native package tests use Vitest; packaging tests use `node:test`
- `pnpm test:sdk` runs generation, the app SDK, i18n, API Key, Redis Storage, MCP, PayPal, Waffo, Stripe business adapter, subscription, credits, business, and admin audit tests
- Use `getTestInstance()` from `better-auth/test`. It returns `{ client, auth, sessionSetter, ... }`
- Pass client plugins via `clientOptions.plugins`
- NEVER create separate clients with `createAuthClient()` in tests
- Default test DB is SQLite in-memory; use `testWith` for other databases
- External database tests can use `docker compose --project-directory . -f test/docker-compose.yml up -d`.
- API Key regression includes PostgreSQL serial-ID coverage. Set `BETTER_AUTH_TEST_POSTGRES_URL` to an isolated test database (legacy local default remains `postgres://user:password@localhost:5432/better_auth`); fixtures create and remove their own random schemas. SDK CI supplies PostgreSQL 17
- Regression tests: use `@see` for relevant issues or authoritative sources. Do not reference the current pull request or its review comments:
  ```typescript
  /**
   * @see https://github.com/better-auth/better-auth/issues/{issue_number}
   */
  it("should handle the previously broken behavior", async () => {
    // ...
  });
  ```
- Put a shared `@see` above a focused `describe()` when multiple regression tests share the same reference. For a standalone regression test, put it above `it()`.

## Important Development Notes

- Bug fixes and new features MUST include tests
  - For bug fixes: after confirming the reproducible behavior violates the intended contract, write a failing test first, then implement the fix
- Update SDK usage documentation (`README.md` and `packages/app-sdk/README.md`) when changing public API
- Ensure `pnpm typecheck` passes before finishing
- DO NOT COMMIT unless the user explicitly asks
- Conventional Commits: `feat(scope):`, `fix(scope):`, `docs:`, `chore:`. Use `!` for breaking changes (e.g. `feat(auth)!:`)
- PRs target `main`
