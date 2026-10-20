import * as z from "zod";
import {
	contentDigest,
	decisionForAttempt,
	nullableToken,
	timestamp,
	token,
	trustedContext,
} from "./lifecycle-validation";
import { moderationError } from "./primitives";
import type { ModerationRuntime } from "./runtime";
import type { ModerationDecision, OperationAuthorization } from "./types";

const base = z
	.object({ context: trustedContext, event_id: token, attempt_id: token })
	.strict();
const providerSchema = base.extend({
	status: z.enum(["succeeded", "policy_refused", "technical_error"]),
	provider: token,
	provider_request_id: nullableToken,
	provider_model: nullableToken,
	error_code: nullableToken,
});
const outcomeSchema = base.extend({
	outcome: z.enum(["accepted", "refused", "output_blocked"]),
	provider_event_id: token,
	decision_id: nullableToken,
});
const deliverySchema = base.extend({
	decision_id: token,
	authorization_id: nullableToken,
	content_revision: token,
	context_digest: contentDigest,
	status: z.enum(["released", "withheld", "revoked"]),
	occurred_at: timestamp,
});
const feedbackSchema = z
	.object({
		context: trustedContext,
		event_id: token,
		decision_id: token,
		type: z.enum(["report", "appeal"]),
		reason_code: token,
		evidence_ref: nullableToken,
	})
	.strict();

export type ProviderResultRequest = z.infer<typeof providerSchema>;
export type OutcomeRequest = z.infer<typeof outcomeSchema>;
export type DeliveryRequest = z.infer<typeof deliverySchema>;
export type FeedbackRequest = z.infer<typeof feedbackSchema>;

interface ProviderFact {
	type: string;
	status: ProviderResultRequest["status"];
	provider_event_id: string;
	attempt_id: string;
}
interface AuthorizationFact extends OperationAuthorization {
	content_revision: string;
	context_digest: string;
	delivery_epoch: number;
}

export function createModerationEvents(runtime: ModerationRuntime) {
	async function recordProviderResult(request: ProviderResultRequest) {
		const input = providerSchema.parse(request);
		return runtime.command(
			input.context,
			"provider",
			input.event_id,
			input,
			"record",
			async (tx) => {
				const record = await runtime.attempt(
					tx,
					input.context,
					input.attempt_id,
				);
				if (record.data.kind !== "generation")
					throw moderationError(
						"INVALID_WORKFLOW",
						"Provider results require a generation attempt",
					);
				const conflict =
					record.data.provider_status !== null &&
					record.data.provider_status !== input.status;
				const blocked = input.status === "policy_refused" || conflict;
				await runtime.event(
					tx,
					input.context,
					`provider:${input.event_id}`,
					"provider_result",
					{
						provider_event_id: input.event_id,
						attempt_id: input.attempt_id,
						status: input.status,
						provider: input.provider,
						provider_request_id: input.provider_request_id,
						provider_model: input.provider_model,
						error_code: input.error_code,
					},
					input.attempt_id,
				);
				if (conflict)
					await runtime.event(
						tx,
						input.context,
						`provider_anomaly:${input.event_id}`,
						"audit_anomaly",
						{ reason_code: "CONFLICTING_PROVIDER_RESULT" },
						input.attempt_id,
					);
				await tx.replace(record, {
					...record.data,
					provider_status:
						record.data.provider_status === "policy_refused"
							? "policy_refused"
							: input.status,
					provider_event_id: input.event_id,
					revoked: record.data.revoked || blocked,
					revocation_reasons: [
						...new Set([
							...(record.data.revocation_reasons ?? []),
							...(input.status === "policy_refused"
								? ["provider_refused"]
								: []),
							...(conflict ? ["provider_conflict"] : []),
						]),
					],
					delivery_epoch: record.data.delivery_epoch + (blocked ? 1 : 0),
				});
				return { event_id: input.event_id, anomaly: conflict };
			},
		);
	}

	async function recordOutcome(request: OutcomeRequest) {
		const input = outcomeSchema.parse(request);
		const result = await runtime.command(
			input.context,
			"outcome",
			input.event_id,
			input,
			"record",
			async (tx) => {
				const record = await runtime.attempt(
					tx,
					input.context,
					input.attempt_id,
				);
				const provider = await tx.get<ProviderFact>(
					"event",
					`provider:${input.provider_event_id}`,
				);
				const decision = input.decision_id
					? await tx.get<ModerationDecision>("decision", input.decision_id)
					: null;
				const matchingDecision =
					decision?.data.attempt_id === input.attempt_id &&
					decision.data.subject_id === input.context.subject_id;
				const current =
					decision &&
					record.data.stages[decision.data.stage]?.decision_id ===
						input.decision_id;
				const postGeneration =
					decision && ["output", "presentation"].includes(decision.data.stage);
				let reason: string | null = null;
				if (record.data.kind !== "generation")
					reason = "OUTCOME_REQUIRES_GENERATION";
				else if (record.data.outcome !== null) reason = "OUTCOME_ALREADY_FINAL";
				else if (
					!provider ||
					provider.attempt_id !== input.attempt_id ||
					provider.data.attempt_id !== input.attempt_id ||
					provider.subject_id !== input.context.subject_id
				)
					reason = "OUTCOME_PROVIDER_MISMATCH";
				else if (input.decision_id && !matchingDecision)
					reason = "OUTCOME_DECISION_MISMATCH";
				else if (
					input.outcome === "refused" &&
					provider.data.status !== "policy_refused"
				)
					reason = "REFUSED_REQUIRES_POLICY_REFUSAL";
				else if (
					input.outcome !== "refused" &&
					provider.data.status !== "succeeded"
				)
					reason = "OUTCOME_REQUIRES_PROVIDER_SUCCESS";
				else if (
					input.outcome === "output_blocked" &&
					(!current || !postGeneration || decision?.data.decision !== "block")
				)
					reason = "OUTCOME_REQUIRES_OUTPUT_BLOCK";
				else if (input.outcome === "accepted") {
					const ids = [
						record.data.stages.output?.decision_id,
						record.data.stages.presentation?.decision_id,
					];
					const stages = await Promise.all(
						ids.map((id) =>
							id ? tx.get<ModerationDecision>("decision", id) : null,
						),
					);
					if (
						!current ||
						!postGeneration ||
						record.data.revoked ||
						stages.some(
							(entry) =>
								!entry ||
								entry.data.decision !== "allow" ||
								entry.data.enforcement !== "continue",
						)
					)
						reason = "ACCEPTED_REQUIRES_OUTPUT_AND_PRESENTATION_ALLOW";
				}
				if (reason) {
					await runtime.event(
						tx,
						input.context,
						`outcome_anomaly:${input.event_id}`,
						"audit_anomaly",
						{
							reason_code: reason,
							observed_outcome: input.outcome,
							provider_event_id: input.provider_event_id,
							decision_id: input.decision_id,
						},
						input.attempt_id,
					);
					await tx.replace(record, {
						...record.data,
						revoked: true,
						revocation_reasons: [
							...new Set([
								...(record.data.revocation_reasons ?? []),
								"outcome_anomaly",
							]),
						],
						delivery_epoch: record.data.delivery_epoch + 1,
					});
					return {
						event_id: input.event_id,
						accepted: false,
						reason_code: reason,
					};
				}
				await runtime.event(
					tx,
					input.context,
					`outcome:${input.event_id}`,
					"outcome",
					{
						outcome: input.outcome,
						provider_event_id: input.provider_event_id,
						decision_id: input.decision_id,
					},
					input.attempt_id,
				);
				await tx.replace(record, { ...record.data, outcome: input.outcome });
				return {
					event_id: input.event_id,
					accepted: true,
					reason_code: "OUTCOME_RECORDED",
				};
			},
		);
		if (!result.accepted)
			throw moderationError(
				"INVALID_OUTCOME",
				"Moderation outcome contradicts recorded facts",
				{ reason_code: result.reason_code },
			);
		return result;
	}

	async function recordDelivery(request: DeliveryRequest) {
		const input = deliverySchema.parse(request);
		return runtime.command(
			input.context,
			"delivery",
			input.event_id,
			input,
			"record",
			async (tx) => {
				const attempt = await runtime.attempt(
					tx,
					input.context,
					input.attempt_id,
				);
				const decision = await tx.get<ModerationDecision>(
					"decision",
					input.decision_id,
				);
				const authorization = input.authorization_id
					? await tx.get<AuthorizationFact>(
							"event",
							`authorization:${input.authorization_id}`,
						)
					: null;
				const permitted =
					authorization?.data.permit === true &&
					authorization.data.operation === "deliver" &&
					authorization.attempt_id === input.attempt_id &&
					authorization.subject_id === input.context.subject_id &&
					authorization.data.decision_ids.includes(input.decision_id) &&
					authorization.data.content_revision === input.content_revision &&
					authorization.data.context_digest === input.context_digest &&
					authorization.data.delivery_epoch === attempt.data.delivery_epoch &&
					authorization.data.expires_at !== null &&
					Date.parse(authorization.data.expires_at) >=
						Date.parse(input.occurred_at) &&
					Date.parse(authorization.created_at) <=
						Date.parse(input.occurred_at) &&
					Date.parse(input.occurred_at) <= Date.now();
				const matching =
					decision?.data.attempt_id === input.attempt_id &&
					decision.data.subject_id === input.context.subject_id &&
					decision.data.content_revision === input.content_revision &&
					decision.data.context_digest === input.context_digest &&
					attempt.data.stages[decision.data.stage]?.decision_id ===
						input.decision_id;
				const anomaly =
					input.status === "released" &&
					(!permitted ||
						!matching ||
						attempt.data.revoked ||
						attempt.data.provider_status === "policy_refused" ||
						decision?.data.decision !== "allow" ||
						decision.data.enforcement !== "continue");
				await runtime.event(
					tx,
					input.context,
					`delivery:${input.event_id}`,
					"delivery",
					{
						decision_id: input.decision_id,
						authorization_id: input.authorization_id,
						content_revision: input.content_revision,
						context_digest: input.context_digest,
						status: input.status,
						observed_at: input.occurred_at,
						anomaly,
					},
					input.attempt_id,
				);
				if (anomaly)
					await runtime.event(
						tx,
						input.context,
						`delivery_anomaly:${input.event_id}`,
						"audit_anomaly",
						{
							reason_code: "DELIVERY_WITHOUT_CURRENT_AUTHORIZATION",
							delivery_event_id: input.event_id,
						},
						input.attempt_id,
					);
				if (anomaly || input.status === "revoked")
					await tx.replace(attempt, {
						...attempt.data,
						revoked: true,
						revocation_reasons: [
							...new Set([
								...(attempt.data.revocation_reasons ?? []),
								anomaly ? "delivery_anomaly" : "delivery_revoked",
							]),
						],
						delivery_epoch: attempt.data.delivery_epoch + 1,
					});
				return { event_id: input.event_id, recorded: true, anomaly };
			},
		);
	}

	async function recordFeedback(request: FeedbackRequest) {
		const input = feedbackSchema.parse(request);
		return runtime.command(
			input.context,
			"feedback",
			input.event_id,
			input,
			"record",
			async (tx) => {
				const decision = await decisionForAttempt(
					tx,
					input.context,
					input.decision_id,
				);
				if (decision.data.decision === "legal_hold")
					throw moderationError(
						"RESTRICTED_CASE",
						"Restricted cases require their dedicated process",
					);
				const attempt = await runtime.attempt(
					tx,
					input.context,
					decision.data.attempt_id,
				);
				await runtime.event(
					tx,
					input.context,
					`feedback:${input.event_id}`,
					"feedback",
					{
						decision_id: input.decision_id,
						feedback_type: input.type,
						reason_code: input.reason_code,
						evidence_ref: input.evidence_ref,
					},
					attempt.key,
				);
				await tx.replace(attempt, {
					...attempt.data,
					revoked: true,
					revoked_decision_ids: [
						...new Set([
							...(attempt.data.revoked_decision_ids ?? []),
							input.decision_id,
						]),
					],
					delivery_epoch: attempt.data.delivery_epoch + 1,
				});
				return {
					event_id: input.event_id,
					state_revision: attempt.revision + 1,
				};
			},
		);
	}
	return {
		recordProviderResult,
		recordOutcome,
		recordDelivery,
		recordFeedback,
	};
}
