import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttemptState } from "../src/moderation/types";
import {
	authorization,
	context,
	evaluation,
	platformPolicy,
	policyRule,
	setupModeration,
} from "./moderation-fixtures";

afterEach(() => vi.useRealTimers());

describe("moderation controlled review", () => {
	it("does not reuse a previous policy's enforcement receipt", async () => {
		const { sdk, platform } = await setupModeration({
			platform: platformPolicy({
				rules: [policyRule({ action: "ban", block_level: "hard" })],
			}),
		});
		const request = evaluation();
		request.items = request.items.map((item) =>
			item.modality === "text" ? { ...item, text: "block:violence" } : item,
		);
		const first = await sdk.evaluate(request);
		platform.version = "platform-2";
		const next = await sdk.resolveReview({
			context,
			event_id: "new-policy",
			expected_decision_id: first.decision.decision_id,
			reason_code: "POLICY_CHANGED",
			evaluation: { ...request, expected_state_revision: first.state_revision },
		});
		expect(first.decision.action_ids).toHaveLength(1);
		expect(next.decision.action_ids).toHaveLength(1);
		expect(next.decision.action_ids).not.toEqual(first.decision.action_ids);
	});
	it("rejects partially bound diagnostic identities and reports readiness by workflow", async () => {
		const { sdk, check } = await setupModeration({
			platform: platformPolicy({ rules: [policyRule({ stages: ["prompt"] })] }),
		});
		await expect(
			sdk.check({
				context,
				job_id: "job-only",
				attempt_id: null,
				stage: "prompt",
				layers: ["safety"],
				categories: ["violence"],
				items: evaluation().items,
				content_revision: "content-1",
				context_digest: "a".repeat(64),
				idempotency_key: "invalid-binding",
			}),
		).rejects.toThrow();
		expect(check).not.toHaveBeenCalled();
		expect(
			(await sdk.getCapabilities({ context, attempt_kind: "publication" }))
				.ready,
		).toBe(false);
		expect(
			(
				await sdk.getCapabilities({
					context,
					attempt_kind: "generation",
					stage: "prompt",
					modality: "text",
				})
			).ready,
		).toBe(true);
	});
	it("cannot replace a hard block with a fresh ordinary evaluation", async () => {
		const { sdk, check, storage } = await setupModeration({
			platform: platformPolicy({
				rules: [policyRule({ block_level: "hard", action: "ban" })],
			}),
		});
		check.mockImplementation(async ({ requested_checks }) =>
			requested_checks.map(({ requested_check_id }) => ({
				requested_check_id,
				coverage: "checked",
				flagged: true,
				score: 0.99,
				reason_code: "HIT",
			})),
		);
		const first = await sdk.evaluate(evaluation());
		expect(first.decision).toMatchObject({
			decision: "block",
			block_level: "hard",
		});
		check.mockClear();
		await expect(
			sdk.evaluate(
				evaluation("prompt", first.state_revision, {
					idempotency_key: "ordinary-retry",
				}),
			),
		).rejects.toMatchObject({ body: { code: "DECISION_BLOCKED" } });
		expect(check).not.toHaveBeenCalled();
		expect(
			(await storage.get<AttemptState>(
				context.tenant_id,
				"attempt",
				"attempt-one",
			))!.data.stages.prompt!.decision_id,
		).toBe(first.decision.decision_id);
		expect((await sdk.authorizeOperation(authorization())).permit).toBe(false);
	});

	it("preserves the first pending deadline and rejects recovery after expiry without a worker", async () => {
		const { sdk, check } = await setupModeration();
		check.mockRejectedValue(new Error("offline"));
		const first = await sdk.evaluate(evaluation());
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.parse(first.decision.created_at) + 100);
		const retry = await sdk.evaluate(
			evaluation("prompt", first.state_revision, {
				idempotency_key: "review-retry",
			}),
		);
		expect(retry.decision.expires_at).toBe(first.decision.expires_at);
		vi.setSystemTime(Date.parse(first.decision.expires_at!) + 1);
		check.mockClear();
		await expect(
			sdk.evaluate(
				evaluation("prompt", retry.state_revision, {
					idempotency_key: "late-retry",
				}),
			),
		).rejects.toMatchObject({ body: { code: "REVIEW_EXPIRED" } });
		expect(check).not.toHaveBeenCalled();
	});

	it("checks the pending deadline again when detector work finishes", async () => {
		const { sdk, check } = await setupModeration();
		check.mockRejectedValueOnce(new Error("offline"));
		const first = await sdk.evaluate(evaluation());
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.parse(first.decision.expires_at!) - 10);
		check.mockImplementation(async ({ requested_checks }) => {
			vi.setSystemTime(Date.parse(first.decision.expires_at!) + 1);
			return requested_checks.map(({ requested_check_id }) => ({
				requested_check_id,
				coverage: "checked",
				flagged: false,
				score: 0.01,
				reason_code: "CLEAR",
			}));
		});
		await expect(
			sdk.evaluate(
				evaluation("prompt", first.state_revision, {
					idempotency_key: "cross-deadline",
				}),
			),
		).rejects.toMatchObject({ body: { code: "REVIEW_EXPIRED" } });
	});

	it("replays a completed authorized review before checking its old state revision", async () => {
		const { sdk, check } = await setupModeration();
		check.mockRejectedValueOnce(new Error("offline"));
		const first = await sdk.evaluate(evaluation());
		const command = {
			context,
			event_id: "review-once",
			expected_decision_id: first.decision.decision_id,
			reason_code: "PROVIDER_RECOVERED",
			evaluation: evaluation("prompt", first.state_revision, {
				idempotency_key: "review-source",
			}),
		};
		const next = await sdk.resolveReview(command);
		expect(next.decision.decision).toBe("allow");
		const count = check.mock.calls.length;
		expect(await sdk.resolveReview(command)).toEqual(next);
		expect(check).toHaveBeenCalledTimes(count);
	});

	it("only clears the reported decision and keeps unrelated revocations", async () => {
		const { sdk, storage } = await setupModeration();
		const prompt = await sdk.evaluate(evaluation());
		const input = await sdk.evaluate(
			evaluation("input", prompt.state_revision),
		);
		await sdk.recordFeedback({
			context,
			event_id: "input-report",
			decision_id: input.decision.decision_id,
			type: "report",
			reason_code: "REPORTED",
			evidence_ref: null,
		});
		const reported = await storage.get<AttemptState>(
			context.tenant_id,
			"attempt",
			"attempt-one",
		);
		const unrelated = await sdk.resolveReview({
			context,
			event_id: "review-prompt",
			expected_decision_id: prompt.decision.decision_id,
			reason_code: "CLEAR",
			evaluation: evaluation("prompt", reported!.revision),
		});
		expect((await sdk.authorizeOperation(authorization())).permit).toBe(false);
		expect(
			(await storage.get<AttemptState>(
				context.tenant_id,
				"attempt",
				"attempt-one",
			))!.data.revoked,
		).toBe(true);
		const corrected = await sdk.resolveReview({
			context,
			event_id: "review-input",
			expected_decision_id: input.decision.decision_id,
			reason_code: "CLEAR",
			evaluation: evaluation("input", unrelated.state_revision),
		});
		expect(corrected.decision.decision).toBe("allow");
		expect(
			(
				await sdk.authorizeOperation(
					authorization("generate", { idempotency_key: "corrected-grant" }),
				)
			).permit,
		).toBe(true);
		await storage.transaction(context.tenant_id, async (tx) => {
			const attempt = (await tx.get<AttemptState>("attempt", "attempt-one"))!;
			await tx.replace(attempt, {
				...attempt.data,
				revoked: true,
				revocation_reasons: ["provider_conflict"],
			});
		});
		const state = (await storage.get<AttemptState>(
			context.tenant_id,
			"attempt",
			"attempt-one",
		))!;
		await sdk.resolveReview({
			context,
			event_id: "unrelated-conflict-review",
			expected_decision_id: corrected.decision.decision_id,
			reason_code: "CLEAR",
			evaluation: evaluation("input", state.revision),
		});
		expect(
			(
				await sdk.authorizeOperation(
					authorization("generate", { idempotency_key: "still-revoked" }),
				)
			).permit,
		).toBe(false);
	});
});
