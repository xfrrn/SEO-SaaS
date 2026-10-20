import * as z from "zod";
import { createModerationAuthorization } from "./authorization";
import { createModerationConsents } from "./consents";
import { createModerationEvents } from "./events";
import { createModerationEvidence } from "./evidence";
import { createModerationExecution } from "./execution";
import { createModerationMaintenance } from "./maintenance";
import { moderationError } from "./primitives";
import { createModerationRuntime } from "./runtime";
import type { ModerationOptions } from "./types";
import { contextSchema, evaluationSchema, identifier } from "./validation";
import { operationStages } from "./workflow";

const capabilitiesQuery = z.strictObject({
	context: contextSchema,
	stage: z
		.enum(["prompt", "input", "output", "presentation", "reuse"])
		.optional(),
	modality: z.enum(["text", "image", "audio", "video"]).optional(),
	attempt_kind: z.enum(["generation", "publication", "reuse"]).optional(),
});
const reviewBody = z.strictObject({
	context: contextSchema,
	event_id: identifier,
	expected_decision_id: identifier,
	reason_code: identifier,
	evaluation: evaluationSchema,
});
export type CapabilitiesRequest = z.infer<typeof capabilitiesQuery>;
export type ResolveReviewRequest = z.infer<typeof reviewBody>;

/** Create the server module once; storage and trusted host adapters are mandatory. */
export function createModeration(options: ModerationOptions) {
	if (
		!Array.isArray(options.detectors) ||
		new Set(options.detectors.map((detector) => detector.id)).size !==
			options.detectors.length
	)
		throw moderationError(
			"INVALID_CONFIGURATION",
			"Moderation detector identifiers must be unique",
		);
	const runtime = createModerationRuntime(options);
	const execution = createModerationExecution(runtime);
	return {
		check: execution.check,
		evaluate: execution.evaluate,
		...createModerationAuthorization(runtime),
		...createModerationEvents(runtime),
		...createModerationConsents(runtime),
		...createModerationMaintenance(runtime),
		...createModerationEvidence(runtime),
		async resolveReview(input: ResolveReviewRequest) {
			const request = reviewBody.parse(input);
			await runtime.prepare(request.context, "review");
			if (
				request.context.tenant_id !== request.evaluation.context.tenant_id ||
				request.context.subject_id !== request.evaluation.context.subject_id ||
				request.context.actor_id !== request.evaluation.context.actor_id
			)
				throw moderationError(
					"FORBIDDEN",
					"Review identity must match evaluation identity",
				);
			return execution.evaluateReview(
				{
					...request.evaluation,
					idempotency_key: `review:${request.event_id}`,
				},
				{
					event_id: request.event_id,
					reason_code: request.reason_code,
					expected_decision_id: request.expected_decision_id,
				},
			);
		},
		async getCapabilities(input: CapabilitiesRequest) {
			const request = capabilitiesQuery.parse(input);
			const prepared = await runtime.prepare(request.context, "capabilities");
			const stages = request.attempt_kind
				? operationStages(request.attempt_kind, "deliver")!
				: ["prompt", "input", "output", "presentation", "reuse"];
			const matrix = options.detectors.map((detector) => ({
				id: detector.id,
				version: detector.version,
				layer: detector.layer,
				enabled: !prepared.controls.disabled_detectors.includes(detector.id),
				capabilities: detector.capabilities,
			}));
			const readiness = prepared.policy.rules
				.filter(
					(rule) =>
						rule.required &&
						rule.mode === "enforce" &&
						rule.stages.some((stage) => stages.includes(stage)) &&
						(!request.stage ||
							(stages.includes(request.stage) &&
								rule.stages.includes(request.stage))),
				)
				.flatMap((rule) =>
					rule.modalities
						.filter(
							(modality) => !request.modality || modality === request.modality,
						)
						.map((modality) => ({
							rule_id: rule.id,
							stages: rule.stages.filter(
								(stage) =>
									stages.includes(stage) &&
									(!request.stage || stage === request.stage),
							),
							category: rule.category,
							modality,
							minimum_scope: rule.minimum_scope,
							ready: rule.detector_ids.some((id) =>
								matrix.some(
									(detector) =>
										detector.id === id &&
										detector.layer === rule.layer &&
										detector.enabled &&
										detector.capabilities.some(
											(capability) =>
												capability.category === rule.category &&
												capability.modality === modality &&
												capability.inspection_scope === rule.minimum_scope,
										),
								),
							),
						})),
				);
			await options.storage.transaction(request.context.tenant_id, (tx) =>
				runtime.snapshots(tx, prepared),
			);
			return {
				policy_version: prepared.policy.version,
				capability_snapshot_id: prepared.capability_snapshot_id,
				matrix,
				readiness,
				ready:
					!prepared.controls.block_all &&
					readiness.length > 0 &&
					readiness.every((entry) => entry.ready),
			};
		},
	};
}
