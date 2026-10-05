# Better Auth Development Guide

This is the Better Auth repository - a comprehensive authentication framework for TypeScript, designed to be runtime and framework-agnostic.

## Project Structure

- `packages/better-auth` - Main authentication library
- `packages/core` - Shared core types and utilities
- `packages/app-sdk` - Application SDK entry points and PayPal client
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
- Use `getTestInstance()` from `better-auth/test`. It returns `{ client, auth, sessionSetter, ... }`
- Pass client plugins via `clientOptions.plugins`
- NEVER create separate clients with `createAuthClient()` in tests
- Default test DB is SQLite in-memory; use `testWith` for other databases
- External database tests can use `docker compose --project-directory . -f test/docker-compose.yml up -d`.
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
