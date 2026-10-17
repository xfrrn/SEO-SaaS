<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Dashboard conventions

- Keep the supplied template's neutral palette, card layout, horizontal tabs, and chart/dialog animations. Reuse `components/ui` and `components/shared.tsx` when extending the panel.
- Use the existing Admin and Business SDK clients. Keep payment verification on the server and enforce permissions in SDK endpoints.
- Google login uses native `signIn.social` / `linkSocial` and the server-only `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` pair. Pass only the enabled flag to the browser; preserve local email verification, same-email linking, account ownership and administrator role checks. Configuration and website integration are documented in `README.md`.
- Keep business logic in the SDK plugins; the panel validates input and presents real responses. Do not substitute demo records for failed requests.
- Run `pnpm dashboard:test`, `pnpm dashboard:build`, and `pnpm typecheck` from the workspace root. Browser tests use a separate local database.
