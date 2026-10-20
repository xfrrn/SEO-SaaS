import { describe, expect, it } from "vitest";
import type { ConsentState } from "../src/moderation/consents";
import type { AttemptState } from "../src/moderation/types";
import { context, future, setup } from "./moderation-authorization-fixture";
import {
	authorization,
	evaluation,
	setupModeration,
} from "./moderation-fixtures";

describe("moderation authorization decision links", () => {
	it("does not invoke the ordinary consent adapter for a restricted attempt", async () => {
		const test = await setup();
		await test.seed(
			["prompt", "input"],
			{ consent_ids: ["restricted-consent"] },
			{ decision: "legal_hold", enforcement: "quarantine" },
		);
		const consent: ConsentState = {
			consent_id: "restricted-consent",
			subject_id: "subject",
			actor_id: "actor",
			asset_digest: "asset",
			declaration_version: "v1",
			purposes: ["generate"],
			expires_at: future(),
			evidence_ref: "proof",
			status: "verified",
			revision: 1,
			created_at: new Date().toISOString(),
			verified_purposes: ["generate"],
			verified_expires_at: future(),
			verification_method: "manual",
			verification_evidence_ref: "proof",
		};
		await test.storage.transaction("tenant", (tx) =>
			tx.insert({
				kind: "consent",
				key: consent.consent_id,
				subject_id: "subject",
				attempt_id: null,
				data: consent,
			}),
		);
		let calls = 0;
		test.options.validateConsent = async () => {
			calls++;
		};
		expect((await test.service.authorizeOperation(test.request())).permit).toBe(
			false,
		);
		expect(calls).toBe(0);
	});
	it("revalidates source consent for the new subject, media and purpose before reuse", async () => {
		const test = await setup();
		const asset = (asset_ref: string) => ({
			item_id: asset_ref,
			revision: "r1",
			asset_ref,
		});
		await test.seed(["input", "presentation"], {
			attempt_id: "source",
			kind: "publication",
			subject_id: "creator",
			consent_ids: ["source-consent"],
			stage_assets: { input: [asset("original")] },
		});
		await test.seed(["reuse"], {
			kind: "reuse",
			source_decision_ids: ["source-presentation"],
			stage_assets: { reuse: [asset("derived")] },
		});
		const consent: ConsentState = {
			consent_id: "source-consent",
			subject_id: "creator",
			actor_id: "creator",
			asset_digest: "asset",
			declaration_version: "v1",
			purposes: ["publish"],
			expires_at: future(),
			evidence_ref: "proof",
			status: "verified",
			revision: 1,
			created_at: new Date().toISOString(),
			verified_purposes: ["publish"],
			verified_expires_at: future(),
			verification_method: "manual",
			verification_evidence_ref: "proof",
		};
		await test.storage.transaction("tenant", (tx) =>
			tx.insert({
				kind: "consent",
				key: consent.consent_id,
				subject_id: "creator",
				attempt_id: null,
				data: consent,
			}),
		);
		const request = () =>
			test.request({ operation: "reuse", content_revision: "reuse" });
		expect((await test.service.authorizeOperation(request())).reason_code).toBe(
			"CONSENT_INVALID",
		);
		await test.storage.transaction("tenant", async (tx) => {
			const record = await tx.get<ConsentState>("consent", consent.consent_id);
			if (!record) throw new Error("Missing source consent");
			await tx.replace(record, {
				...record.data,
				purposes: ["publish", "reuse"],
				verified_purposes: ["publish", "reuse"],
			});
		});
		let observedSubject: string | null = null;
		let observedAssets: string[] = [];
		test.options.validateConsent = async (
			subject,
			declaration,
			assets,
			operation,
		) => {
			observedSubject = subject.subject_id;
			observedAssets = assets.map((entry) => entry.asset_ref);
			expect(declaration.subject_id).toBe("creator");
			expect(operation).toBe("reuse");
		};
		expect((await test.service.authorizeOperation(request())).permit).toBe(
			true,
		);
		expect(observedSubject).toBe(context.subject_id);
		expect(observedAssets).toEqual(["derived", "original"]);
		test.options.validateConsent = undefined;
		expect((await test.service.authorizeOperation(request())).reason_code).toBe(
			"CONSENT_VALIDATOR_REQUIRED",
		);
		test.options.validateConsent = async () => {
			throw new Error("Not licensed for this actor");
		};
		expect((await test.service.authorizeOperation(request())).reason_code).toBe(
			"CONSENT_SCOPE_INVALID",
		);
		test.options.validateConsent = async () => {
			await test.storage.transaction("tenant", async (tx) => {
				const record = await tx.get<ConsentState>(
					"consent",
					consent.consent_id,
				);
				if (!record) throw new Error("Missing source consent");
				await tx.replace(record, { ...record.data, status: "revoked" });
			});
		};
		expect((await test.service.authorizeOperation(request())).permit).toBe(
			false,
		);
	});
	it("requires downstream reevaluation when a previously allowed prerequisite changes", async () => {
		const test = await setupModeration();
		const prompt = await test.sdk.evaluate(evaluation());
		const input = await test.sdk.evaluate(
			evaluation("input", prompt.state_revision),
		);
		expect((await test.sdk.authorizeOperation(authorization())).permit).toBe(
			true,
		);
		await test.sdk.evaluate(
			evaluation("prompt", input.state_revision, {
				idempotency_key: "new-prompt-evaluation",
			}),
		);
		expect(await test.sdk.authorizeOperation(authorization())).toMatchObject({
			permit: false,
			reason_code: "PREREQUISITE_CHANGED",
		});
	});
	it("validates cross-subject sources and follows transitive revocation", async () => {
		const test = await setup();
		await test.seed(["input", "presentation"], {
			attempt_id: "source",
			kind: "publication",
			subject_id: "creator",
		});
		await test.seed(["reuse"], {
			attempt_id: "middle",
			subject_id: "middle-creator",
			kind: "reuse",
			source_decision_ids: ["source-presentation"],
		});
		await test.seed(["reuse"], {
			kind: "reuse",
			source_decision_ids: ["middle-reuse"],
		});
		const request = test.request({
			operation: "reuse",
			content_revision: "reuse",
		});
		expect((await test.service.authorizeOperation(request)).permit).toBe(true);
		await test.storage.transaction("tenant", async (tx) => {
			const source = await tx.get<AttemptState>("attempt", "source");
			if (!source) throw new Error("Missing source attempt");
			await tx.replace(source, { ...source.data, revoked: true });
		});
		expect((await test.service.authorizeOperation(request)).permit).toBe(false);
	});
});
