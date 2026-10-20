import { describe, expect, it, vi } from "vitest";
import type {
	AttemptState,
	EnforcementAction,
	ModerationDecision,
} from "../src/moderation/types";
import { context, setupLifecycle } from "./moderation-lifecycle-fixtures";

function pendingAction(
	action_id: string,
	decision_id: string,
	rule_id = "violence",
): EnforcementAction {
	return {
		action_id,
		subject_id: context.subject_id,
		attempt_id: "attempt",
		decision_id,
		rule_id,
		type: "ban",
		parameters: {},
		status: "pending",
		attempts: 0,
		lease_token: null,
		lease_until: null,
		next_attempt_at: new Date(Date.now() - 1000).toISOString(),
		expires_at: new Date(Date.now() + 60_000).toISOString(),
		reason_code: "ACTION_REQUIRED",
	};
}

describe("moderation worker current-state guards", () => {
	it("excludes all current reviews and expiry work when another stage enters legal hold", async () => {
		const { service, storage, seedAttempt, seedDecision } =
			await setupLifecycle();
		await seedAttempt();
		const review = await seedDecision({
			stage: "input",
			decision: "review",
			expires_at: new Date(Date.now() - 1000).toISOString(),
		});
		await seedDecision({
			stage: "prompt",
			decision: "legal_hold",
			enforcement: "quarantine",
		});
		expect((await service.listReviews({ context })).reviews).toEqual([]);
		expect(
			await service.expireReviews({ context, idempotency_key: "expire" }),
		).toMatchObject({ expired: 0 });
		expect(
			(await storage.get<AttemptState>(context.tenant_id, "attempt", "attempt"))
				?.data.stages.input?.decision_id,
		).toBe(review.decision_id);
		expect(
			(
				await storage.get<ModerationDecision>(
					context.tenant_id,
					"decision",
					review.decision_id,
				)
			)?.data.decision,
		).toBe("review");
	});

	it("does not claim a historical content punishment after its stage was corrected", async () => {
		const { service, storage, options, seedAttempt, seedDecision } =
			await setupLifecycle();
		await seedAttempt();
		const blocked = await seedDecision({
			decision: "block",
			action_ids: ["ban"],
		});
		const action = pendingAction("ban", blocked.decision_id);
		await storage.transaction(context.tenant_id, (tx) =>
			tx.insert({
				kind: "action",
				key: action.action_id,
				subject_id: context.subject_id,
				attempt_id: "attempt",
				data: action,
			}),
		);
		await seedDecision({
			supersedes_decision_id: blocked.decision_id,
			decision: "allow",
			action_ids: [],
		});
		options.executeAction = vi.fn(async () => ({
			status: "succeeded" as const,
			reason_code: "APPLIED",
		}));
		expect(
			(await service.runPendingActions({ context, idempotency_key: "run" }))
				.receipts,
		).toEqual([]);
		expect(options.executeAction).not.toHaveBeenCalled();
		expect(
			(await storage.get<EnforcementAction>(context.tenant_id, "action", "ban"))
				?.data,
		).toMatchObject({ status: "pending", attempts: 0 });
	});

	it("checks the current stage again before executing the next claimed punishment", async () => {
		const { service, storage, options, policy, seedAttempt, seedDecision } =
			await setupLifecycle();
		policy.rules.push({ ...policy.rules[0]!, id: "second-rule" });
		await seedAttempt();
		const blocked = await seedDecision({
			decision: "block",
			action_ids: ["a-first", "z-stale"],
		});
		await storage.transaction(context.tenant_id, async (tx) => {
			for (const action of [
				pendingAction("a-first", blocked.decision_id),
				pendingAction("z-stale", blocked.decision_id, "second-rule"),
			]) {
				await tx.insert({
					kind: "action",
					key: action.action_id,
					subject_id: context.subject_id,
					attempt_id: "attempt",
					data: action,
				});
			}
		});
		options.executeAction = vi.fn(async (action: EnforcementAction) => {
			if (action.action_id === "a-first")
				await seedDecision({
					supersedes_decision_id: blocked.decision_id,
					decision: "allow",
					action_ids: [],
				});
			return { status: "succeeded" as const, reason_code: "APPLIED" };
		});
		const result = await service.runPendingActions({
			context,
			idempotency_key: "run",
		});
		expect(options.executeAction).toHaveBeenCalledTimes(1);
		expect(result.receipts).toEqual([
			{ action_id: "a-first", status: "succeeded", reason_code: "APPLIED" },
		]);
		expect(
			(
				await storage.get<EnforcementAction>(
					context.tenant_id,
					"action",
					"a-first",
				)
			)?.data.status,
		).toBe("succeeded");
		expect(
			(
				await storage.get<EnforcementAction>(
					context.tenant_id,
					"action",
					"z-stale",
				)
			)?.data.status,
		).toBe("pending");
	});

	it("keeps an abuse action reused by a current downstream stage after its original stage changes", async () => {
		const { service, storage, options, policy, seedAttempt, seedDecision } =
			await setupLifecycle();
		policy.abuse_rules.push({
			id: "abuse",
			metric: "requests",
			window_ms: 60_000,
			threshold: 2,
			edge_score: null,
			effect: "challenge",
			mode: "enforce",
			identity: "account",
			parameters: {},
		});
		await seedAttempt();
		const origin = await seedDecision({
			stage: "prompt",
			decision: "review",
			action_ids: ["challenge"],
		});
		const action = {
			...pendingAction("challenge", origin.decision_id, "abuse"),
			type: "challenge" as const,
		};
		await storage.transaction(context.tenant_id, (tx) =>
			tx.insert({
				kind: "action",
				key: action.action_id,
				subject_id: context.subject_id,
				attempt_id: "attempt",
				data: action,
			}),
		);
		await seedDecision({
			stage: "prompt",
			supersedes_decision_id: origin.decision_id,
			decision: "allow",
			action_ids: [],
		});
		await seedDecision({
			stage: "input",
			decision: "review",
			action_ids: ["challenge"],
			prerequisite_decision_ids: [origin.decision_id],
		});
		options.executeAction = vi.fn(async () => ({
			status: "pending" as const,
			reason_code: "AWAITING_PROOF",
		}));
		expect(
			(await service.runPendingActions({ context, idempotency_key: "run" }))
				.receipts,
		).toEqual([
			{
				action_id: "challenge",
				status: "pending",
				reason_code: "AWAITING_PROOF",
			},
		]);
		expect(options.executeAction).toHaveBeenCalledTimes(1);
	});
});
