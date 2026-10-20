import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	AbuseRule,
	AttemptState,
	EnforcementAction,
	ModerationDecision,
} from "../src/moderation/types";
import {
	authorization,
	context,
	contextDigest,
	evaluation,
	fixtureText,
	platformPolicy,
	policyRule,
	setupModeration,
} from "./moderation-fixtures";

afterEach(() => vi.useRealTimers());

describe("moderation workflow", () => {
	it.each([
		false,
		true,
	])("requires every matching abuse action receipt and its valid expiry, reversed=%s", async (reverse) => {
		const abuse_rules: AbuseRule[] = ["challenge", "limit"].map((effect) => ({
			id: `abuse-${effect}`,
			metric: "requests",
			window_ms: 60000,
			threshold: 1,
			edge_score: null,
			effect: effect as "challenge" | "limit",
			mode: "enforce",
			identity: "account",
			parameters: {},
		}));
		const base = platformPolicy();
		const { sdk, storage } = await setupModeration({
			platform: platformPolicy({
				abuse_rules: reverse ? abuse_rules.toReversed() : abuse_rules,
				limits: { ...base.limits, review_ttl_ms: 60000 },
			}),
		});
		let result = await sdk.evaluate(evaluation());
		expect(result.decision.decision).toBe("review");
		async function updateAction(
			type: "challenge" | "limit",
			status: EnforcementAction["status"],
			expires_at: string,
		) {
			await storage.transaction(context.tenant_id, async (tx) => {
				const action = (
					await tx.list<EnforcementAction>("action", {
						attempt_id: "attempt-one",
						limit: 10,
					})
				).find((entry) => entry.data.type === type)!;
				await tx.replace(action, { ...action.data, status, expires_at });
			});
		}
		const future = new Date(Date.now() + 60000).toISOString();
		await updateAction("limit", "succeeded", future);
		result = await sdk.evaluate(
			evaluation("prompt", result.state_revision, {
				idempotency_key: "pending-challenge",
			}),
		);
		expect(result.decision.decision).toBe("review");
		await updateAction(
			"challenge",
			"succeeded",
			new Date(Date.now() - 1).toISOString(),
		);
		result = await sdk.evaluate(
			evaluation("prompt", result.state_revision, {
				idempotency_key: "expired-challenge",
			}),
		);
		expect(result.decision.decision).toBe("review");
		await updateAction("challenge", "succeeded", future);
		result = await sdk.evaluate(
			evaluation("prompt", result.state_revision, {
				idempotency_key: "completed-actions",
			}),
		);
		expect(result.decision.decision).toBe("allow");
		expect(result.decision.action_ids).toHaveLength(2);
	});
	it("does not authorize generation from prompt-only or independent checks", async () => {
		const { sdk } = await setupModeration();
		const report = await sdk.check({
			context,
			job_id: null,
			attempt_id: null,
			stage: "prompt",
			layers: ["safety"],
			categories: ["violence"],
			items: [fixtureText],
			content_revision: "content-1",
			context_digest: contextDigest,
			idempotency_key: "independent-check",
		});
		expect(report.decision).toBe("allow");
		expect((await sdk.authorizeOperation(authorization())).permit).toBe(false);
		const prompt = await sdk.evaluate(evaluation());
		expect(prompt.decision.decision).toBe("allow");
		expect(prompt.state_revision).toBeGreaterThan(0);
		const grant = await sdk.authorizeOperation(
			authorization("generate", { idempotency_key: "after-prompt" }),
		);
		expect(grant).toMatchObject({ permit: false, authorization_id: null });
	});

	it("requires prompt and input for generation, then provider success, output and presentation for delivery", async () => {
		const { sdk, storage } = await setupModeration();
		const prompt = await sdk.evaluate(evaluation());
		const input = await sdk.evaluate(
			evaluation("input", prompt.state_revision),
		);
		expect(input.state_revision).toBe(prompt.state_revision + 1);
		const generation = await sdk.authorizeOperation(authorization());
		expect(generation).toMatchObject({
			permit: true,
			operation: "generate",
			reason_code: "AUTHORIZED",
		});
		expect(generation.authorization_id).toEqual(expect.any(String));
		expect(
			(await sdk.authorizeOperation(authorization("deliver"))).permit,
		).toBe(false);
		await sdk.recordProviderResult({
			context,
			event_id: "provider-success",
			attempt_id: "attempt-one",
			status: "succeeded",
			provider: "fixture-provider",
			provider_model: "fixture-model",
			provider_request_id: "request-one",
			error_code: null,
		});
		const stored = await storage.get<AttemptState>(
			context.tenant_id,
			"attempt",
			"attempt-one",
		);
		const output = await sdk.evaluate(evaluation("output", stored!.revision));
		expect(
			(
				await sdk.authorizeOperation(
					authorization("deliver", { idempotency_key: "after-output" }),
				)
			).permit,
		).toBe(false);
		const presentation = await sdk.evaluate(
			evaluation("presentation", output.state_revision),
		);
		expect(presentation.decision.decision).toBe("allow");
		const delivery = await sdk.authorizeOperation(
			authorization("deliver", { idempotency_key: "after-presentation" }),
		);
		expect(delivery).toMatchObject({ permit: true, operation: "deliver" });
		expect(delivery.decision_ids).toHaveLength(4);
		expect(delivery.decision_ids).toContain(presentation.decision.decision_id);
	});

	it("short circuits later stages after a preceding block", async () => {
		const { sdk, check } = await setupModeration();
		const prompt = await sdk.evaluate(
			evaluation("prompt", 0, {
				items: [{ ...fixtureText, text: "block:violence" }],
			}),
		);
		expect(prompt.decision.decision).toBe("block");
		check.mockClear();
		const input = await sdk.evaluate(
			evaluation("input", prompt.state_revision),
		);
		expect(input.decision.decision).toBe("block");
		expect(check).not.toHaveBeenCalled();
		expect((await sdk.authorizeOperation(authorization())).permit).toBe(false);
	});

	it("replays identical commands and rejects key reuse with changed bodies", async () => {
		const { sdk, check } = await setupModeration();
		const request = evaluation();
		const first = await sdk.evaluate(request);
		expect(await sdk.evaluate(request)).toEqual(first);
		expect(check).toHaveBeenCalledTimes(1);
		await expect(
			sdk.evaluate({
				...request,
				items: [{ ...fixtureText, text: "changed fixture text" }],
			}),
		).rejects.toMatchObject({ body: { code: "IDEMPOTENCY_CONFLICT" } });
	});

	it("keeps subject boundaries even within a shared tenant", async () => {
		const { sdk } = await setupModeration();
		const prompt = await sdk.evaluate(evaluation());
		const other = {
			...context,
			subject_id: "subject-two",
			actor_id: "actor-two",
		};
		await expect(
			sdk.evaluate(
				evaluation("input", prompt.state_revision, {
					context: other,
					idempotency_key: "other-input",
				}),
			),
		).rejects.toMatchObject({ body: { code: "NOT_FOUND" } });
		expect(
			(
				await sdk.authorizeOperation(
					authorization("generate", {
						context: other,
						idempotency_key: "other-grant",
					}),
				)
			).permit,
		).toBe(false);
	});

	it("does not turn unsupported image minors capability into a pass", async () => {
		const platform = platformPolicy({
			rules: [
				policyRule({
					id: "image-child-safety",
					category: "sexual/minors",
					modalities: ["image"],
					minimum_scope: "image.original",
					block_level: "hard",
					action: "ban",
				}),
			],
		});
		const { sdk, check } = await setupModeration({ platform });
		const result = await sdk.evaluate(
			evaluation("prompt", 0, {
				items: [
					{
						item_id: "image",
						field: "media",
						revision: "1",
						modality: "image",
						asset_ref: "private-image",
					},
				],
			}),
		);
		expect(result.decision).toMatchObject({
			decision: "review",
			enforcement: "deny",
		});
		expect(result.decision.check_coverage).toMatchObject([
			{ category: "sexual/minors", coverage: "unsupported" },
		]);
		expect(check).not.toHaveBeenCalled();
	});

	it("records shadow hits without issuing punishments", async () => {
		const executeAction = vi.fn(async () => ({
			status: "succeeded" as const,
			reason_code: "DONE",
		}));
		const { sdk, storage } = await setupModeration({
			tenant: {
				version: "tenant-1",
				abuse_rules: [],
				rules: [
					policyRule({
						id: "shadow-sexual",
						category: "sexual",
						mode: "shadow",
						block_level: "hard",
						action: "ban",
					}),
				],
			},
			options: { executeAction },
		});
		const result = await sdk.evaluate(
			evaluation("prompt", 0, {
				items: [{ ...fixtureText, text: "block:sexual" }],
			}),
		);
		expect(result.decision).toMatchObject({
			decision: "allow",
			would_decision: "block",
			would_block_level: "hard",
			action_ids: [],
		});
		expect(
			await storage.list(context.tenant_id, "action", { limit: 10 }),
		).toEqual([]);
		expect(executeAction).not.toHaveBeenCalled();
	});

	it("hands restricted signals off before any general detector and retains no prompt copy", async () => {
		const handoffRestricted = vi.fn(async () => ({ case_ref: "case-one" }));
		const { sdk, storage, check } = await setupModeration({
			options: {
				resolveRestrictedSignal: async () => ({
					status: "suspected",
					source: "restricted-fixture",
					evidence_ref: "restricted-evidence",
				}),
				handoffRestricted,
			},
		});
		const result = await sdk.evaluate(
			evaluation("prompt", 0, {
				items: [{ ...fixtureText, text: "restricted fixture material" }],
			}),
		);
		expect(result.decision).toMatchObject({
			decision: "legal_hold",
			enforcement: "quarantine",
		});
		expect(handoffRestricted).toHaveBeenCalledTimes(1);
		expect(check).not.toHaveBeenCalled();
		const decisions = await storage.list(context.tenant_id, "decision", {
			limit: 10,
		});
		expect(JSON.stringify(decisions)).not.toContain(
			"restricted fixture material",
		);
		expect(JSON.stringify(decisions)).not.toContain("restricted-evidence");
	});

	it("denies detector failures immediately and turns expired reviews into immutable successor blocks", async () => {
		const { sdk, options, storage } = await setupModeration();
		options.detectors[0]!.check = async () => {
			throw new Error("provider down");
		};
		const result = await sdk.evaluate(evaluation());
		expect(result.decision).toMatchObject({
			decision: "review",
			enforcement: "deny",
		});
		expect(result.decision.expires_at).toEqual(expect.any(String));
		expect((await sdk.authorizeOperation(authorization())).permit).toBe(false);
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.parse(result.decision.expires_at!) + 1);
		expect(
			(await sdk.expireReviews({ context, idempotency_key: "expire-one" }))
				.expired,
		).toBe(1);
		const attempt = await storage.get<AttemptState>(
			context.tenant_id,
			"attempt",
			"attempt-one",
		);
		const next = await storage.get<ModerationDecision>(
			context.tenant_id,
			"decision",
			attempt!.data.stages.prompt!.decision_id,
		);
		expect(next!.data).toMatchObject({
			decision: "block",
			block_level: "soft",
			enforcement: "deny",
			supersedes_decision_id: result.decision.decision_id,
		});
		const original = await storage.get<ModerationDecision>(
			context.tenant_id,
			"decision",
			result.decision.decision_id,
		);
		expect(original!.data.decision).toBe("review");
	});

	it("returns state revisions and accepts only one concurrent transition from the same revision", async () => {
		const { sdk } = await setupModeration();
		const prompt = await sdk.evaluate(evaluation());
		const transitions = await Promise.allSettled([
			sdk.evaluate(
				evaluation("input", prompt.state_revision, {
					idempotency_key: "input-a",
				}),
			),
			sdk.evaluate(
				evaluation("input", prompt.state_revision, {
					idempotency_key: "input-b",
				}),
			),
		]);
		expect(
			transitions.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		const failed = transitions.find((result) => result.status === "rejected");
		expect(failed?.status === "rejected" ? failed.reason : null).toMatchObject({
			body: { code: "STATE_CONFLICT" },
		});
		await expect(
			sdk.evaluate(evaluation("input", 0, { idempotency_key: "stale-input" })),
		).rejects.toMatchObject({ body: { code: "STATE_CONFLICT" } });
	});

	it("rejects forged state and decision fields before detector execution", async () => {
		const { sdk, check } = await setupModeration();
		const forged = {
			...evaluation(),
			provider_status: "succeeded",
			stages: { input: { decision: "allow" } },
			state: { revision: 100 },
			decision: "allow",
		};
		await expect(sdk.evaluate(forged)).rejects.toThrow();
		expect(check).not.toHaveBeenCalled();
	});
});
