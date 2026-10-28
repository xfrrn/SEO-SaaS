# Central media service (SDK 0.4.0)

Use the server-only `@app/auth-sdk/media-engine` entry for new websites. It transports verified user/admin context, validates responses, preserves stable request keys and verifies raw-byte webhooks. It has no supplier executor or media downloader. Legacy generation/moderation exports remain until consumer migration is verified.

```ts
import { createMediaEngineClient } from '@app/auth-sdk/media-engine';
import { withCreditsTransaction } from '@app/auth-sdk/credits';

const engine = createMediaEngineClient({
  base_url: process.env.MEDIA_ENGINE_URL!,
  api_key: process.env.MEDIA_ENGINE_API_KEY!,
});
// Discover application identity with application(); require user_scoped=true.
// userId is from a verified session. Price and snapshots come from the server.
await withCreditsTransaction(adapter, async (tx, credits) => {
  await credits.reserve({ referenceId: userId, amount: fixedPrice, idempotencyKey: requestId });
  await tx.create({ model: 'hostMediaRequest', data: frozenRequest });
  await tx.create({ model: 'hostMediaDispatch', data: durableCommand });
});
```

The host registers business models in the native SQL adapter. Unique indexes and real transactions are required; unsupported adapters are refused. PostgreSQL unique conflicts abort transactions: retry the entire host unit with the same keys. Standalone service calls cannot make independently committed business writes atomic.

`reserve` uses its idempotency key as reservation ID. `settle`/`release` take `referenceId`, `reservationId`, a stable finalization key and optional reason. Only permanent batches can be reserved; expiring credits remain normally spendable. Consume, expiry and grant recovery respect frozen allocations. `account()` returns total/reserved/available; `balance()` returns available. Allocations live in the same append-only ledger snapshot, with no second balance. Reserve/release append zero-amount facts; settle appends one negative consumption. Late events cannot reopen released reservations.

Dispatch the frozen version, inputs and business ID. Unknown responses retain reservations and recover by business ID or identical request replay. A timeout never creates a new key. Settle verified `deliverable` once; release verified `confirmed_no_delivery` once. Pending/reconciling work retains reservations, bounded retries and alerts. Compensation is separate and audited.

`verifyMediaEngineEvent` accepts original `Uint8Array`, `Headers`, the per-application secret and discovered application ID. It checks size, timestamp, HMAC bytes, event/version and identity bindings. Persist inbox before 2xx; query current Engine state, then project, finalize credits and finish inbox in one host transaction. Revision prevents stale updates. Do not store private links in inbox or permanent outputs.

Browser uploads go directly to the returned storage URL. Persist IDs/metadata; fetch approved read links on demand. Management requires verified actor identity and explicit Engine application permission. Sensitive previews require `purpose: 'review'` plus a reason and central audit. Browser values cannot establish trusted roles, users or prices.

Webhook verification accepts a 32+ character secret or `{current, previous: [{secret, expires_at}]}` validated with `mediaWebhookSecretSchema` (at most two old keys, explicit ISO UTC deadlines). The host may encode this object in its existing `MEDIA_ENGINE_WEBHOOK_SECRET` field, keeping the normal three-field setup. Stage receivers with both keys first, switch Engine's root WEBHOOK_SECRET, then remove expired old keys. Queued outbox bodies and event IDs do not change; each delivery signs with the current derived application key. Rotation does not renew timestamp tolerance or revive expired keys. Use a short planned overlap and verify every dependent website before changing the Engine root secret.

For `moderation.action`, use `verifyMediaEngineNotification` and branch on `event`. Discover and persist the application identity server-side; signed events still need a durable inbox. Query `enforcementAction()` with a verified `purpose: 'enforce'` context, compare its current immutable binding, then call `applyMediaEngineAction(tx, event)` inside the inbox transaction. Register `mediaEngineActionReceiptSchema` with the native adapter and its unique actionId index. After commit, send the saved receipt using `acknowledgeAction()`, then mark inbox done. A lost ACK response retries the receipt; it must not repeat the account mutation. Ban/revoke_session are supported; limit/challenge and administrator accounts return explicit failed receipts for manual handling. Grant `moderation.enforce` explicitly in Engine; media.manage/review do not imply it.

SDK 0.4.0 bundles native credits 0.2.0. Before enabling holds, add `creditEntry.holdState` and `reservationId` through the host's additive schema synchronization and verify both account/sequence and account/idempotency unique indexes. Old entries remain unchanged and restore as permanent batches. `balance()` now means available balance; use `account()` for total/reserved/available. `reservation(referenceId, reservationId)` returns the original hold/finalization facts.

Engine reuses the 0.4.0 moderation core through its own fixed package, including the counter-window action-receipt fix. New website code uses this remote client; do not register the legacy generation/moderation executors alongside it. Existing legacy exports and non-migrated capabilities remain supported until consumers and in-flight work are accounted for. Historical 0.3.0 archives remain identifiable and are not overwritten.

0.4.0 adds transport/ledger/action and packaging tests; the Engine/aimeme isolated real-process chain is also verified. Real KIE, SeeAPI, R2, public callback delivery and production deployment still require separate acceptance.

## Optional provider-independent moderation and outcome compatibility

Engine now chooses its detector explicitly and configures moderation per website. The SDK client holds no detector credentials and has no SeeAPI dependency. Existing SDK 0.4.0 can carry `moderation_status=skipped` (explicitly disabled independent moderation), review/block states and reason codes without changing its runtime package.

Always interpret `status`, `delivery_status` and `resolution` together. `succeeded + available + deliverable` with a matching output-role asset permits one settlement. `failed/cancelled + blocked/unavailable + confirmed_no_delivery` permits one release. Pending moderation, technical moderation errors, human review and unknown provider acceptance keep the original reservation. A generation provider success response alone does not settle customer credits. Query the current authoritative task after a signed event and reject contradictory combinations; transport schema validation does not implement host business settlement.

Engine identifies moderation pending, review, error and blocking with separate `input_moderation_*` / `output_moderation_*` reasons. An asset marked skipped can be available when the host administrator has disabled independent moderation; it never means that detection passed. Always obtain a fresh authorized read link rather than deriving permission from that label.

The 2026-10-28 compatibility regression covers skipped media and these task outcomes. Runtime exports and fixed 0.4.0 archives are unchanged; no consumer package refresh is required. Engine and aimeme own the policy switches, customer-state projection and cross-process tests. The complete state matrix is maintained in Engine's `docs/generation-outcomes.md`.

Verification: `pnpm exec vitest run packages/app-sdk/test/media-engine.test.ts packages/app-sdk/test/moderation.test.ts packages/credits/test` passed 54 tests in 5 files; `pnpm exec tsc --project packages/app-sdk/tsconfig.test.json --noEmit` and the changed-file Biome check passed. No live moderation call or package release was performed.
