import { describe, expect, it } from "vitest";
import type { AttemptState } from "../src/moderation/types";
import {
	context,
	contextDigest,
	revision,
	setupLifecycle,
} from "./moderation-lifecycle-fixtures";

describe("moderation facts and consent lifecycle", () => {
	it("keeps technical errors separate from policy refusal and persists invalid outcome anomalies", async () => {
		const { service, storage, seedAttempt } = await setupLifecycle();
		await seedAttempt();
		await service.recordProviderResult({
			context,
			event_id: "provider",
			attempt_id: "attempt",
			status: "technical_error",
			provider: "provider",
			provider_request_id: null,
			provider_model: null,
			error_code: "HTTP_503",
		});
		const input = {
			context,
			event_id: "outcome",
			attempt_id: "attempt",
			outcome: "refused" as const,
			provider_event_id: "provider",
			decision_id: null,
		};
		await expect(service.recordOutcome(input)).rejects.toMatchObject({
			body: { code: "INVALID_OUTCOME" },
		});
		await expect(service.recordOutcome(input)).rejects.toMatchObject({
			body: { code: "INVALID_OUTCOME" },
		});
		expect(
			(await storage.get<AttemptState>(context.tenant_id, "attempt", "attempt"))
				?.data,
		).toMatchObject({
			provider_status: "technical_error",
			outcome: null,
			revoked: true,
		});
		expect(
			(await storage.get(context.tenant_id, "event", "outcome_anomaly:outcome"))
				?.data,
		).toMatchObject({
			type: "audit_anomaly",
			reason_code: "REFUSED_REQUIRES_POLICY_REFUSAL",
		});
	});

	it("requires both output and presentation before recording accepted, without overwriting the original outcome", async () => {
		const { service, storage, seedAttempt, seedDecision } =
			await setupLifecycle();
		await seedAttempt();
		await seedDecision();
		const presentation = await seedDecision({ stage: "presentation" });
		await service.recordProviderResult({
			context,
			event_id: "provider",
			attempt_id: "attempt",
			status: "succeeded",
			provider: "provider",
			provider_request_id: "req",
			provider_model: "model",
			error_code: null,
		});
		const request = {
			context,
			event_id: "accepted",
			attempt_id: "attempt",
			outcome: "accepted" as const,
			provider_event_id: "provider",
			decision_id: presentation.decision_id,
		};
		expect(await service.recordOutcome(request)).toMatchObject({
			accepted: true,
		});
		expect(await service.recordOutcome(request)).toMatchObject({
			accepted: true,
		});
		await expect(
			service.recordOutcome({ ...request, event_id: "change" }),
		).rejects.toMatchObject({ body: { code: "INVALID_OUTCOME" } });
		expect(
			(await storage.get<AttemptState>(context.tenant_id, "attempt", "attempt"))
				?.data.outcome,
		).toBe("accepted");
	});

	it("retains an unauthorized actual delivery as an anomaly and closes later authorization", async () => {
		const { service, storage, seedAttempt, seedDecision } =
			await setupLifecycle();
		await seedAttempt();
		const decision = await seedDecision();
		const input = {
			context,
			event_id: "delivery",
			attempt_id: "attempt",
			decision_id: decision.decision_id,
			authorization_id: null,
			content_revision: revision,
			context_digest: contextDigest,
			status: "released" as const,
			occurred_at: new Date().toISOString(),
		};
		expect(await service.recordDelivery(input)).toMatchObject({
			recorded: true,
			anomaly: true,
		});
		expect(await service.recordDelivery(input)).toMatchObject({
			recorded: true,
			anomaly: true,
		});
		expect(
			(await storage.get(context.tenant_id, "event", "delivery:delivery"))
				?.data,
		).toMatchObject({ type: "delivery", status: "released", anomaly: true });
		expect(
			(await storage.get<AttemptState>(context.tenant_id, "attempt", "attempt"))
				?.data.revoked,
		).toBe(true);
	});

	it("accepts a matching delivery authorization and records later report withdrawal", async () => {
		const { service, storage, runtime, seedAttempt, seedDecision } =
			await setupLifecycle();
		await seedAttempt();
		const decision = await seedDecision();
		await storage.transaction(context.tenant_id, (tx) =>
			runtime.event(
				tx,
				context,
				"authorization:auth",
				"authorization",
				{
					authorization_id: "auth",
					attempt_id: "attempt",
					operation: "deliver",
					permit: true,
					decision_ids: [decision.decision_id],
					reason_code: "ALLOW",
					expires_at: new Date(Date.now() + 10_000).toISOString(),
					content_revision: revision,
					context_digest: contextDigest,
					delivery_epoch: 0,
				},
				"attempt",
			),
		);
		expect(
			await service.recordDelivery({
				context,
				event_id: "delivery",
				attempt_id: "attempt",
				decision_id: decision.decision_id,
				authorization_id: "auth",
				content_revision: revision,
				context_digest: contextDigest,
				status: "released",
				occurred_at: new Date().toISOString(),
			}),
		).toMatchObject({ anomaly: false });
		await service.recordFeedback({
			context,
			event_id: "report",
			decision_id: decision.decision_id,
			type: "report",
			reason_code: "USER_REPORT",
			evidence_ref: "private:report",
		});
		expect(
			(await storage.get<AttemptState>(context.tenant_id, "attempt", "attempt"))
				?.data.revoked_decision_ids,
		).toEqual([decision.decision_id]);
		expect(
			(await storage.get<AttemptState>(context.tenant_id, "attempt", "attempt"))
				?.data.revoked,
		).toBe(true);
	});

	it("does not let a later success erase provider policy refusal", async () => {
		const { service, storage, seedAttempt } = await setupLifecycle();
		await seedAttempt();
		const input = {
			context,
			attempt_id: "attempt",
			provider: "provider",
			provider_request_id: null,
			provider_model: null,
			error_code: null,
		};
		await service.recordProviderResult({
			...input,
			event_id: "refused",
			status: "policy_refused",
		});
		expect(
			await service.recordProviderResult({
				...input,
				event_id: "succeeded",
				status: "succeeded",
			}),
		).toMatchObject({ anomaly: true });
		expect(
			(await storage.get<AttemptState>(context.tenant_id, "attempt", "attempt"))
				?.data,
		).toMatchObject({ provider_status: "policy_refused", revoked: true });
	});

	it("keeps declarations immutable while verification uses CAS and an independent permission", async () => {
		const { service, storage, options, seedAttempt } = await setupLifecycle();
		const declaration = await service.recordConsent({
			context,
			event_id: "declare",
			asset_digest: "b".repeat(64),
			declaration_version: "1",
			purposes: ["generate", "publish"],
			expires_at: new Date(Date.now() + 60_000).toISOString(),
			evidence_ref: "private:declaration",
		});
		await seedAttempt({ consent_ids: [declaration.consent_id] });
		const verified = await service.verifyConsent({
			context,
			event_id: "verify",
			consent_id: declaration.consent_id,
			expected_consent_revision: 1,
			status: "verified",
			evidence_ref: "private:proof",
			method: "manual",
			purposes: ["generate"],
			expires_at: new Date(Date.now() + 30_000).toISOString(),
			reason_code: "PROOF_CHECKED",
		});
		expect(verified).toMatchObject({
			status: "verified",
			purposes: ["generate", "publish"],
			verified_purposes: ["generate"],
			evidence_ref: "private:declaration",
			revision: 2,
		});
		expect(options.authorize).toHaveBeenCalledWith(context, "verify_consent");
		await expect(
			service.verifyConsent({
				context,
				event_id: "stale",
				consent_id: declaration.consent_id,
				expected_consent_revision: 1,
				status: "verified",
				evidence_ref: "private:proof",
				method: "manual",
				purposes: ["generate"],
				expires_at: verified.expires_at,
				reason_code: "CHECKED",
			}),
		).rejects.toMatchObject({ body: { code: "STATE_CONFLICT" } });
		await service.revokeConsent({
			context,
			event_id: "revoke",
			consent_id: declaration.consent_id,
			expected_consent_revision: 2,
			reason_code: "OWNER_REVOKED",
		});
		expect(
			(await storage.get<AttemptState>(context.tenant_id, "attempt", "attempt"))
				?.data.revoked,
		).toBe(true);
		await expect(
			service.revokeConsent({
				context: { ...context, subject_id: "other" },
				event_id: "foreign",
				consent_id: declaration.consent_id,
				expected_consent_revision: 3,
				reason_code: "OTHER",
			}),
		).rejects.toMatchObject({ body: { code: "NOT_FOUND" } });
	});
});
