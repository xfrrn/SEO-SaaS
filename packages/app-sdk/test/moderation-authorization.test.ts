import { describe, expect, it } from "vitest";
import type { ConsentState } from "../src/moderation/consents";
import { createModerationEvents } from "../src/moderation/events";
import type { EnforcementAction, Operation } from "../src/moderation/types";
import {
	context,
	future,
	past,
	setup,
} from "./moderation-authorization-fixture";
import {
	authorization,
	evaluation,
	policyRule,
	setupModeration,
} from "./moderation-fixtures";

describe("moderation operation authorization", () => {
	it("keeps unsupported required shadow checks from denying enforced baseline permits", async () => {
		const permits: boolean[] = [];
		for (const shadow of [false, true]) {
			const test = await setupModeration(
				shadow
					? {
							tenant: {
								version: "shadow-1",
								abuse_rules: [],
								rules: [
									policyRule({
										id: "shadow-only",
										category: "sexual",
										mode: "shadow",
										detector_ids: ["missing"],
									}),
								],
							},
						}
					: {},
			);
			const first = await test.sdk.evaluate(evaluation());
			const input = await test.sdk.evaluate(
				evaluation("input", first.state_revision),
			);
			if (shadow)
				expect(input.decision.check_coverage).toContainEqual(
					expect.objectContaining({
						required: true,
						mode: "shadow",
						coverage: "unsupported",
					}),
				);
			permits.push((await test.sdk.authorizeOperation(authorization())).permit);
		}
		expect(permits).toEqual([true, true]);
	});
	it("rejects prompt-only generation and writes evidence before granting a complete workflow", async () => {
		const test = await setup();
		await test.seed(["prompt"]);
		const denied = await test.service.authorizeOperation(test.request());
		expect(denied).toMatchObject({
			permit: false,
			authorization_id: null,
			reason_code: "CHECKPOINT_MISSING",
		});
		expect(
			await test.storage.list("tenant", "event", { limit: 10 }),
		).toHaveLength(1);
		await test.seed(["prompt", "input"], { attempt_id: "complete" });
		const request = test.request({ attempt_id: "complete" });
		const granted = await test.service.authorizeOperation(request);
		expect(granted.permit).toBe(true);
		expect(granted.authorization_id).toBeTypeOf("string");
		expect(granted.decision_ids).toHaveLength(2);
		const evidence = await test.storage.get(
			"tenant",
			"event",
			`authorization:${granted.authorization_id}`,
		);
		expect(evidence?.data).toMatchObject({
			type: "authorization",
			permit: true,
			content_revision: "input",
			delivery_epoch: 0,
		});
		expect(await test.service.authorizeOperation(request)).toEqual(granted);
		await expect(
			test.service.authorizeOperation({
				...request,
				content_revision: "changed",
			}),
		).rejects.toMatchObject({ body: { code: "IDEMPOTENCY_CONFLICT" } });
	});

	it("requires provider success, output and presentation for generated delivery", async () => {
		const test = await setup();
		await test.seed(["prompt", "input", "output", "presentation"]);
		const request = test.request({
			operation: "deliver",
			content_revision: "presentation",
		});
		expect((await test.service.authorizeOperation(request)).reason_code).toBe(
			"PROVIDER_SUCCESS_REQUIRED",
		);
		await test.storage.transaction("tenant", async (tx) => {
			const stored = await test.runtime.attempt(tx, context, "attempt");
			await tx.replace(stored, {
				...stored.data,
				provider_status: "succeeded",
			});
		});
		expect(
			(
				await test.service.authorizeOperation({
					...request,
					idempotency_key: "new-delivery",
				})
			).permit,
		).toBe(true);
		expect(
			(await test.service.authorizeOperation(test.request())).reason_code,
		).toBe("NEW_GENERATION_ATTEMPT_REQUIRED");
	});

	it("supports publication and reuse without inventing a provider call", async () => {
		const test = await setup();
		await test.seed(["input", "presentation"], {
			kind: "publication",
			attempt_id: "publication",
		});
		await test.seed(["reuse", "presentation"], {
			kind: "reuse",
			attempt_id: "reuse",
		});
		for (const attempt_id of ["publication", "reuse"]) {
			expect(
				(
					await test.service.authorizeOperation(
						test.request({
							attempt_id,
							operation: "deliver",
							content_revision: "presentation",
						}),
					)
				).permit,
			).toBe(true);
		}
		expect(
			(
				await test.service.authorizeOperation(
					test.request({
						attempt_id: "reuse",
						operation: "reuse",
						content_revision: "reuse",
					}),
				)
			).permit,
		).toBe(true);
		expect(
			(
				await test.service.authorizeOperation(
					test.request({ attempt_id: "publication" }),
				)
			).reason_code,
		).toBe("INVALID_WORKFLOW");
	});

	it("rechecks controls, policy, subject and target versions instead of replaying old permits", async () => {
		const test = await setup();
		await test.seed();
		const request = test.request();
		expect((await test.service.authorizeOperation(request)).permit).toBe(true);
		test.controls.block_all = true;
		expect((await test.service.authorizeOperation(request)).reason_code).toBe(
			"BLOCK_ALL",
		);
		test.controls.block_all = false;
		test.controls.disabled_detectors = ["safety"];
		expect((await test.service.authorizeOperation(request)).reason_code).toBe(
			"CAPABILITY_REEVALUATION_REQUIRED",
		);
		test.controls.disabled_detectors = [];
		test.platform.version = "v2";
		expect((await test.service.authorizeOperation(request)).reason_code).toBe(
			"POLICY_REEVALUATION_REQUIRED",
		);
		test.platform.version = "v1";
		expect(
			(
				await test.service.authorizeOperation(
					test.request({ content_revision: "changed" }),
				)
			).reason_code,
		).toBe("TARGET_VERSION_MISMATCH");
		expect(
			(
				await test.service.authorizeOperation(
					test.request({ context: { ...context, subject_id: "other" } }),
				)
			).permit,
		).toBe(false);
		expect(
			(
				await test.service.authorizeOperation(
					test.request({ context: { ...context, tenant_id: "other" } }),
				)
			).permit,
		).toBe(false);
	});

	it("withdraws idempotent permits after a report without needing a worker", async () => {
		const test = await setup();
		await test.seed();
		const request = test.request();
		expect((await test.service.authorizeOperation(request)).permit).toBe(true);
		await createModerationEvents(test.runtime).recordFeedback({
			context,
			event_id: "report",
			decision_id: "attempt-input",
			type: "report",
			reason_code: "REPORTED",
			evidence_ref: null,
		});
		expect((await test.service.authorizeOperation(request)).reason_code).toBe(
			"ATTEMPT_REVOKED",
		);
	});

	it("refuses stale decision deadlines and never extends an expired grant", async () => {
		const test = await setup();
		await test.seed(
			["prompt", "input"],
			{ attempt_id: "expired" },
			{ expires_at: past() },
		);
		expect(
			(
				await test.service.authorizeOperation(
					test.request({ attempt_id: "expired" }),
				)
			).reason_code,
		).toBe("DECISION_EXPIRED");
		await test.seed();
		const request = test.request({ idempotency_key: "grant" });
		const grant = await test.service.authorizeOperation(request);
		await test.storage.transaction("tenant", async (tx) => {
			const command = await tx.get<{
				fingerprint: string;
				result: typeof grant;
				delivery_epoch: number;
			}>("command", "authorize:grant");
			if (!command) throw new Error("Missing grant command");
			await tx.replace(command, {
				...command.data,
				result: { ...grant, expires_at: past() },
			});
		});
		expect(await test.service.authorizeOperation(request)).toMatchObject({
			permit: false,
			authorization_id: null,
			reason_code: "NEW_AUTHORIZATION_REQUIRED",
		});
	});

	it("requires verified, in-scope consent and completed unexpired actions", async () => {
		const test = await setup();
		await test.seed(
			["prompt", "input"],
			{ consent_ids: ["consent"] },
			{ action_ids: ["action"] },
		);
		const action: EnforcementAction = {
			action_id: "action",
			subject_id: "subject",
			attempt_id: "attempt",
			decision_id: "attempt-input",
			rule_id: "rule",
			type: "challenge",
			parameters: {},
			status: "pending",
			attempts: 0,
			lease_token: null,
			lease_until: null,
			next_attempt_at: new Date().toISOString(),
			expires_at: future(),
			reason_code: "PENDING",
		};
		const consent: ConsentState = {
			consent_id: "consent",
			subject_id: "subject",
			actor_id: "actor",
			asset_digest: "asset",
			declaration_version: "v1",
			purposes: ["generate", "publish"],
			expires_at: future(),
			evidence_ref: "evidence",
			status: "declared",
			revision: 1,
			created_at: new Date().toISOString(),
			verified_purposes: null,
			verified_expires_at: null,
			verification_method: null,
			verification_evidence_ref: null,
		};
		await test.storage.transaction("tenant", async (tx) => {
			await tx.insert({
				kind: "action",
				key: "action",
				subject_id: "subject",
				attempt_id: "attempt",
				data: action,
			});
			await tx.insert({
				kind: "consent",
				key: "consent",
				subject_id: "subject",
				attempt_id: null,
				data: consent,
			});
		});
		expect(
			(await test.service.authorizeOperation(test.request())).reason_code,
		).toBe("ACTION_INCOMPLETE");
		await test.storage.transaction("tenant", async (tx) => {
			const record = await tx.get<EnforcementAction>("action", "action");
			if (!record) throw new Error("Missing action");
			await tx.replace(record, { ...record.data, status: "succeeded" });
		});
		expect(
			(await test.service.authorizeOperation(test.request())).reason_code,
		).toBe("CONSENT_INVALID");
		await test.storage.transaction("tenant", async (tx) => {
			const record = await tx.get<ConsentState>("consent", "consent");
			if (!record) throw new Error("Missing consent");
			await tx.replace(record, {
				...record.data,
				status: "verified",
				verified_purposes: ["generate"],
				verified_expires_at: future(),
			});
		});
		expect((await test.service.authorizeOperation(test.request())).permit).toBe(
			true,
		);
		test.options.validateConsent = undefined;
		expect(
			(await test.service.authorizeOperation(test.request())).reason_code,
		).toBe("CONSENT_VALIDATOR_REQUIRED");
		test.options.validateConsent = async () => {
			throw new Error("Wrong asset");
		};
		expect(
			(await test.service.authorizeOperation(test.request())).reason_code,
		).toBe("CONSENT_SCOPE_INVALID");
		test.options.validateConsent = async () => {
			await test.storage.transaction("tenant", async (tx) => {
				const record = await tx.get<ConsentState>("consent", "consent");
				if (!record) throw new Error("Missing consent");
				await tx.replace(record, {
					...record.data,
					revision: record.data.revision + 1,
				});
			});
		};
		expect(
			(await test.service.authorizeOperation(test.request())).reason_code,
		).toBe("CONSENT_RECHECK_REQUIRED");
	});

	it("checks consent against input and output media even when presentation has only text", async () => {
		const test = await setup();
		const asset = (asset_ref: string) => ({
			item_id: asset_ref,
			revision: "r1",
			asset_ref,
		});
		await test.seed(["prompt", "input", "output", "presentation"], {
			provider_status: "succeeded",
			consent_ids: ["consent"],
			stage_assets: {
				input: [asset("input-asset"), { ...asset("a:b"), revision: "c" }],
				output: [asset("output-asset"), { ...asset("a"), revision: "b:c" }],
				presentation: [],
			},
		});
		const verified_expires_at = new Date(Date.now() + 10_000).toISOString();
		const consent: ConsentState = {
			consent_id: "consent",
			subject_id: "subject",
			actor_id: "actor",
			asset_digest: "asset",
			declaration_version: "v1",
			purposes: ["publish"],
			expires_at: future(),
			evidence_ref: "proof",
			status: "verified",
			revision: 1,
			created_at: new Date().toISOString(),
			verified_purposes: ["publish"],
			verified_expires_at,
			verification_method: "manual",
			verification_evidence_ref: "proof",
		};
		await test.storage.transaction("tenant", (tx) =>
			tx.insert({
				kind: "consent",
				key: "consent",
				subject_id: "subject",
				attempt_id: null,
				data: consent,
			}),
		);
		let observed: string[] = [];
		let observedOperation: Operation | null = null;
		test.options.validateConsent = async (
			_context,
			_consent,
			assets,
			operation,
		) => {
			observed = assets.map((entry) => entry.asset_ref);
			observedOperation = operation;
		};
		const grant = await test.service.authorizeOperation(
			test.request({ operation: "deliver", content_revision: "presentation" }),
		);
		expect(grant.permit).toBe(true);
		expect(observed).toEqual(["input-asset", "a:b", "output-asset", "a"]);
		expect(observedOperation).toBe("deliver");
		expect(Date.parse(grant.expires_at!)).toBeLessThanOrEqual(
			Date.parse(verified_expires_at),
		);
	});

	it("fails closed for permission and persistence failures", async () => {
		const test = await setup();
		await test.seed();
		test.options.authorize = async () => {
			throw new Error("Forbidden");
		};
		expect((await test.service.authorizeOperation(test.request())).permit).toBe(
			false,
		);
		test.options.storage = {
			...test.storage,
			transaction: async () => {
				throw new Error("Database unavailable");
			},
		};
		await expect(
			test.service.authorizeOperation(test.request()),
		).rejects.toThrow("Database unavailable");
	});
});
