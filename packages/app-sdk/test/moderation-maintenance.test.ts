import { describe, expect, it, vi } from "vitest";
import type {
	AttemptState,
	EnforcementAction,
	ModerationDecision,
} from "../src/moderation/types";
import { context, setupLifecycle } from "./moderation-lifecycle-fixtures";

describe("moderation maintenance and evidence", () => {
	it("lists current reviews and expires them into immutable replacement decisions", async () => {
		const { service, storage, seedAttempt, seedDecision } =
			await setupLifecycle();
		await seedAttempt();
		const old = await seedDecision({
			decision: "review",
			enforcement: "quarantine",
			expires_at: new Date(Date.now() - 1000).toISOString(),
		});
		expect(
			(await service.listReviews({ context })).reviews.map(
				(entry) => entry.decision.decision_id,
			),
		).toEqual([old.decision_id]);
		expect(
			await service.expireReviews({ context, idempotency_key: "expire" }),
		).toMatchObject({ expired: 1 });
		expect((await service.listReviews({ context })).reviews).toEqual([]);
		expect(
			(
				await storage.get<ModerationDecision>(
					context.tenant_id,
					"decision",
					old.decision_id,
				)
			)?.data.decision,
		).toBe("review");
		const attempt = await storage.get<AttemptState>(
			context.tenant_id,
			"attempt",
			"attempt",
		);
		const replacement = await storage.get<ModerationDecision>(
			context.tenant_id,
			"decision",
			attempt!.data.stages.output!.decision_id,
		);
		expect(replacement?.data).toMatchObject({
			decision: "block",
			block_level: "soft",
			supersedes_decision_id: old.decision_id,
		});
	});

	it("executes leased actions outside the SQL transaction, and does not mark pending challenges complete", async () => {
		const { service, storage, options, seedAttempt, seedDecision } =
			await setupLifecycle();
		await seedAttempt();
		const decision = await seedDecision({
			action_ids: ["challenge"],
			mode: "shadow",
		});
		const action: EnforcementAction = {
			action_id: "challenge",
			subject_id: context.subject_id,
			attempt_id: "attempt",
			decision_id: decision.decision_id,
			rule_id: "violence",
			type: "challenge",
			parameters: {},
			status: "pending",
			attempts: 0,
			lease_token: null,
			lease_until: null,
			next_attempt_at: new Date(Date.now() - 1000).toISOString(),
			expires_at: new Date(Date.now() + 60_000).toISOString(),
			reason_code: "CHALLENGE_REQUIRED",
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
		options.executeAction = vi.fn(async () => {
			await storage.transaction(context.tenant_id, (tx) =>
				tx.insert({
					kind: "event",
					key: "adapter-wrote",
					subject_id: context.subject_id,
					attempt_id: "attempt",
					data: { type: "adapter_observed" },
				}),
			);
			return { status: "pending" as const, reason_code: "AWAITING_USER" };
		});
		expect(
			(await service.runPendingActions({ context, idempotency_key: "run" }))
				.receipts,
		).toEqual([
			{
				action_id: "challenge",
				status: "pending",
				reason_code: "AWAITING_USER",
			},
		]);
		await service.runPendingActions({ context, idempotency_key: "run" });
		expect(options.executeAction).toHaveBeenCalledTimes(1);
		expect(
			(
				await storage.get<EnforcementAction>(
					context.tenant_id,
					"action",
					"challenge",
				)
			)?.data,
		).toMatchObject({ status: "pending", attempts: 1, lease_token: null });
		await storage.transaction(context.tenant_id, async (tx) => {
			const current = await tx.get<EnforcementAction>("action", "challenge");
			await tx.replace(current!, {
				...current!.data,
				expires_at: new Date(Date.now() - 1000).toISOString(),
			});
		});
		expect(
			(await service.runPendingActions({ context, idempotency_key: "expired" }))
				.receipts,
		).toEqual([
			{
				action_id: "challenge",
				status: "failed",
				reason_code: "ACTION_EXPIRED",
			},
		]);
		expect(options.executeAction).toHaveBeenCalledTimes(1);
	});

	it("keeps failed erasures available to the next cleanup batch and returns the original receipt on retry", async () => {
		const { service, storage, options } = await setupLifecycle();
		const consent = await service.recordConsent({
			context,
			event_id: "declare",
			asset_digest: "b".repeat(64),
			declaration_version: "1",
			purposes: ["generate"],
			expires_at: new Date(Date.now() + 60_000).toISOString(),
			evidence_ref: "private:proof",
		});
		options.erase = vi.fn(async () => {
			throw new Error("unavailable");
		});
		const request = {
			context,
			cleanup_id: "cleanup",
			idempotency_key: "batch1",
			subject_id: context.subject_id,
		};
		const receipt = await service.cleanupData(request);
		expect(receipt).toMatchObject({
			status: "failed",
			failed: 3,
			next_cursor: null,
		});
		expect(await service.cleanupData(request)).toEqual(receipt);
		expect(
			await storage.get(context.tenant_id, "consent", consent.consent_id),
		).not.toBeNull();
		options.erase = vi.fn(async () => {});
		const next = await service.cleanupData({
			...request,
			idempotency_key: "batch2",
		});
		expect(next.failed).toBe(0);
		expect(
			await storage.get(context.tenant_id, "consent", consent.consent_id),
		).toBeNull();
		expect(
			JSON.stringify(
				await storage.list(context.tenant_id, "cleanup", { limit: 100 }),
			),
		).not.toContain("private:proof");
	});

	it("does not execute a shadow rule action even when its aggregate decision says enforce", async () => {
		const { service, storage, options, policy, seedAttempt, seedDecision } =
			await setupLifecycle();
		options.resolvePolicy = async () => ({
			platform: policy,
			tenant: {
				version: "tenant",
				abuse_rules: [],
				rules: [
					{
						...policy.rules[0]!,
						id: "shadow-rule",
						mode: "shadow",
						required: false,
					},
				],
			},
		});
		await seedAttempt();
		const decision = await seedDecision({
			action_ids: ["shadow-action"],
			mode: "enforce",
		});
		const action: EnforcementAction = {
			action_id: "shadow-action",
			subject_id: context.subject_id,
			attempt_id: "attempt",
			decision_id: decision.decision_id,
			rule_id: "shadow-rule",
			type: "ban",
			parameters: {},
			status: "pending",
			attempts: 0,
			lease_token: null,
			lease_until: null,
			next_attempt_at: new Date(Date.now() - 1000).toISOString(),
			expires_at: new Date(Date.now() + 60_000).toISOString(),
			reason_code: "SHADOW",
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
		options.executeAction = vi.fn(async () => ({
			status: "succeeded" as const,
			reason_code: "DONE",
		}));
		expect(
			(
				await service.runPendingActions({
					context,
					idempotency_key: "shadow-run",
				})
			).receipts,
		).toEqual([]);
		expect(options.executeAction).not.toHaveBeenCalled();
		expect(
			(
				await storage.get<EnforcementAction>(
					context.tenant_id,
					"action",
					action.action_id,
				)
			)?.data.attempts,
		).toBe(0);
	});

	it("rejects invented cleanup cursors instead of reporting an incomplete scope as deleted", async () => {
		const { service, seedAttempt, storage } = await setupLifecycle();
		await seedAttempt();
		await expect(
			service.cleanupData({
				context,
				cleanup_id: "cleanup",
				idempotency_key: "batch",
				subject_id: context.subject_id,
				cursor: btoa(JSON.stringify([7, "zzz"])).replaceAll("=", ""),
			}),
		).rejects.toMatchObject({ body: { code: "STATE_CONFLICT" } });
		expect(
			await storage.get(context.tenant_id, "attempt", "attempt"),
		).not.toBeNull();
	});

	it("does not erase or export restricted cases", async () => {
		const { service, storage, options, seedAttempt, seedDecision } =
			await setupLifecycle();
		await seedAttempt();
		const decision = await seedDecision({
			decision: "legal_hold",
			enforcement: "deny",
		});
		options.erase = vi.fn(async () => {});
		const receipt = await service.cleanupData({
			context,
			cleanup_id: "cleanup",
			idempotency_key: "batch",
			subject_id: context.subject_id,
		});
		expect(receipt.restricted_exceptions).toBeGreaterThan(0);
		expect(options.erase).not.toHaveBeenCalled();
		expect(
			await storage.get(context.tenant_id, "decision", decision.decision_id),
		).not.toBeNull();
		const exported = await service.exportEvidence({
			context,
			from: new Date(Date.now() - 60_000).toISOString(),
			to: new Date(Date.now() + 1).toISOString(),
		});
		expect(exported.jsonl).not.toContain("legal_hold");
		expect(exported.jsonl).not.toContain(decision.decision_id);
	});

	it("exports separate original outcomes and current decisions without text, identities, or private references", async () => {
		const { service, storage, runtime, seedAttempt, seedDecision } =
			await setupLifecycle();
		await seedAttempt({
			outcome: "output_blocked",
			provider_status: "succeeded",
		});
		await seedDecision({
			decision: "block",
			block_level: "soft",
			enforcement: "deny",
		});
		await seedDecision({
			decision: "allow",
			findings: [
				{
					finding_id: "finding",
					requested_check_id: "check",
					item_id: "item",
					modality: "text",
					category: "violence",
					inspection_scope: "text.semantic",
					coverage: "checked",
					mode: "enforce",
					decision: "allow",
					block_level: null,
					detector_id: "detector",
					detector_version: "1",
					provider_model: "model",
					provider_request_id: null,
					native_category: "violence",
					native_flagged: false,
					score: 0.1,
					threshold: 0.8,
					rule_id: "violence",
					reason_code: "CHECKED",
				},
			],
			check_coverage: [
				{
					requested_check_id: "check",
					item_id: "item",
					category: "violence",
					modality: "text",
					minimum_scope: "text.semantic",
					required: true,
					mode: "enforce",
					coverage: "checked",
					finding_ids: ["finding"],
					reason_code: "CHECKED",
				},
			],
		});
		await storage.transaction(context.tenant_id, (tx) =>
			runtime.event(
				tx,
				context,
				"delivery:1",
				"delivery",
				{
					status: "released",
					observed_at: new Date().toISOString(),
					secret: "private-payload",
					evidence_ref: "private:evidence",
					authorization_id: "private-auth",
				},
				"attempt",
			),
		);
		const input = {
			context,
			from: new Date(Date.now() - 60_000).toISOString(),
			to: new Date().toISOString(),
		};
		const first = await service.exportEvidence(input);
		const second = await service.exportEvidence(input);
		expect(first.audit_id).not.toBe(second.audit_id);
		expect(first.summary).toMatchObject({
			generation_attempts: 1,
			original_outcomes: { output_blocked: 1 },
			current_denied_attempts: 0,
			actual_delivery: { released: 1 },
			false_positive_rate: null,
		});
		expect(first.jsonl).toContain('"original_outcome":"output_blocked"');
		expect(first.jsonl).toContain('"current":true');
		expect(first.jsonl).toContain('"native_flagged":false');
		expect(first.jsonl).toContain('"required":true,"mode":"enforce"');
		for (const secret of [
			"private-payload",
			"private:evidence",
			"private-auth",
			"subject_id",
			"actor_id",
			"evidence_ref",
			"authorization_id",
		])
			expect(first.jsonl).not.toContain(secret);
		expect(await service.getPublicPolicy({ context })).toMatchObject({
			categories: [
				{ category: "violence", descriptions: ["Violence is prohibited"] },
			],
		});
	});
});
