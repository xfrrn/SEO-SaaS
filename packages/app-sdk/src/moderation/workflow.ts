import { moderationError } from "./primitives";
import type {
	AttemptKind,
	AttemptState,
	EvaluationRequest,
	ModerationDecision,
	ModerationTransaction,
	Operation,
	Stage,
	StoredRecord,
} from "./types";

const order: Record<
	AttemptKind,
	Partial<Record<Stage, { operation: string; prior: Stage[] }>>
> = {
	generation: {
		prompt: { operation: "generate", prior: [] },
		input: { operation: "generate", prior: ["prompt"] },
		output: { operation: "publish", prior: ["prompt", "input"] },
		presentation: {
			operation: "publish",
			prior: ["prompt", "input", "output"],
		},
	},
	publication: {
		input: { operation: "publish", prior: [] },
		presentation: { operation: "publish", prior: ["input"] },
	},
	reuse: {
		reuse: { operation: "reuse", prior: [] },
		presentation: { operation: "publish", prior: ["reuse"] },
	},
};

/** A single source of truth for the prerequisites of external side effects. */
export function stagePrerequisites(
	kind: AttemptKind,
	stage: Stage,
): Stage[] | null {
	const prior = order[kind][stage]?.prior;
	return prior ? [...prior] : null;
}

/** A single source of truth for the prerequisites of external side effects. */
export function operationStages(
	kind: AttemptKind,
	operation: Operation,
): Stage[] | null {
	if (operation === "generate")
		return kind === "generation" ? ["prompt", "input"] : null;
	if (operation === "reuse") return kind === "reuse" ? ["reuse"] : null;
	return kind === "generation"
		? ["prompt", "input", "output", "presentation"]
		: kind === "publication"
			? ["input", "presentation"]
			: ["reuse", "presentation"];
}

/** Reject out-of-order calls before any media or provider work takes place. */
export async function checkWorkflow(
	tx: ModerationTransaction,
	request: EvaluationRequest,
	review?: { expected_decision_id: string },
) {
	const step = order[request.attempt_kind][request.stage];
	if (!step || step.operation !== request.operation)
		throw moderationError(
			"INVALID_WORKFLOW",
			"Invalid moderation stage and operation",
		);
	let state = await tx.get<AttemptState>("attempt", request.attempt_id);
	if (!state) {
		if (request.expected_state_revision !== 0 || step.prior.length)
			throw moderationError(
				"STATE_CONFLICT",
				"Moderation attempt must begin at its first stage",
				{ current_state_revision: 0, current_decision_ids: [] },
			);
		state = await tx.insert({
			kind: "attempt",
			key: request.attempt_id,
			subject_id: request.context.subject_id,
			attempt_id: request.attempt_id,
			data: {
				attempt_id: request.attempt_id,
				job_id: request.job_id,
				subject_id: request.context.subject_id,
				kind: request.attempt_kind,
				stages: {},
				source_decision_ids: request.source_decision_ids,
				consent_ids: request.consent_ids,
				revoked: false,
				delivery_epoch: 0,
				provider_status: null,
				provider_event_id: null,
				outcome: null,
				created_at: new Date().toISOString(),
			} satisfies AttemptState,
		});
	}
	if (
		state.data.subject_id !== request.context.subject_id ||
		state.data.job_id !== request.job_id ||
		state.data.kind !== request.attempt_kind
	)
		throw moderationError("NOT_FOUND", "Moderation attempt not found");
	if (state.revision !== request.expected_state_revision)
		throw moderationError("STATE_CONFLICT", "Moderation attempt changed", {
			current_state_revision: state.revision,
			current_decision_ids: Object.values(state.data.stages).map(
				(entry) => entry.decision_id,
			),
		});
	if (state.data.revoked && !review)
		throw moderationError(
			"ATTEMPT_REVOKED",
			"Revoked attempts require controlled review or a new attempt",
		);
	if (
		JSON.stringify(state.data.consent_ids) !==
			JSON.stringify(request.consent_ids) ||
		JSON.stringify(state.data.source_decision_ids) !==
			JSON.stringify(request.source_decision_ids)
	)
		throw moderationError(
			"INVALID_WORKFLOW",
			"Changed sources or consent require a new attempt",
		);
	const existing = state.data.stages[request.stage];
	if (
		existing &&
		(existing.content_revision !== request.content_revision ||
			existing.context_digest !== request.context_digest)
	)
		throw moderationError(
			"INVALID_WORKFLOW",
			"Changed content requires a new moderation attempt",
		);
	const prior: ModerationDecision[] = [];
	for (const stage of step.prior) {
		const ref = state.data.stages[stage];
		const record = ref
			? await tx.get<ModerationDecision>("decision", ref.decision_id)
			: null;
		if (
			!record ||
			record.data.attempt_id !== request.attempt_id ||
			record.data.subject_id !== request.context.subject_id
		)
			throw moderationError(
				"STAGE_ORDER",
				"Required moderation stage is missing",
			);
		prior.push(record.data);
	}
	let review_deadline: string | null = null;
	if (existing) {
		const current = await tx.get<ModerationDecision>(
			"decision",
			existing.decision_id,
		);
		if (!current)
			throw moderationError("NOT_FOUND", "Current decision is missing");
		if (review && existing.decision_id !== review.expected_decision_id)
			throw moderationError(
				"STATE_CONFLICT",
				"Review decision is no longer current",
			);
		if (
			current.data.decision === "legal_hold" ||
			(!review && current.data.decision === "block")
		)
			throw moderationError(
				"DECISION_BLOCKED",
				"Blocked decisions require a controlled review or a new attempt",
			);
		if (current.data.decision === "review")
			review_deadline = current.data.expires_at;
	} else if (review)
		throw moderationError("NOT_FOUND", "Review target is missing");
	for (const decision of prior) {
		if (
			decision.decision === "review" &&
			decision.expires_at &&
			(!review_deadline ||
				Date.parse(decision.expires_at) < Date.parse(review_deadline))
		)
			review_deadline = decision.expires_at;
	}
	if (review_deadline && Date.parse(review_deadline) <= Date.now())
		throw moderationError(
			"REVIEW_EXPIRED",
			"Expired review requires a new attempt",
		);
	return { state, prior, review_deadline };
}

export function reviewedState(
	state: StoredRecord<AttemptState>,
	decision: ModerationDecision,
	target?: string,
): StoredRecord<AttemptState> {
	if (!target || !state.data.revoked_decision_ids?.includes(target))
		return state;
	const targets = state.data.revoked_decision_ids.flatMap((id) =>
		id !== target
			? [id]
			: decision.decision === "allow"
				? []
				: [decision.decision_id],
	);
	return {
		...state,
		data: {
			...state.data,
			revoked_decision_ids: targets,
			revoked: targets.length > 0 || !!state.data.revocation_reasons?.length,
		},
	};
}

export async function saveDecision(
	tx: ModerationTransaction,
	state: StoredRecord<AttemptState>,
	request: EvaluationRequest,
	decision: ModerationDecision,
) {
	await tx.insert({
		kind: "decision",
		key: decision.decision_id,
		subject_id: request.context.subject_id,
		attempt_id: request.attempt_id,
		data: decision,
	});
	const assets = request.items.flatMap((item) =>
		item.modality === "text"
			? []
			: [
					{
						item_id: item.item_id,
						revision: item.revision,
						asset_ref: item.asset_ref,
					},
				],
	);
	return tx.replace(state, {
		...state.data,
		stages: {
			...state.data.stages,
			[request.stage]: {
				decision_id: decision.decision_id,
				content_revision: request.content_revision,
				context_digest: request.context_digest,
			},
		},
		stage_assets: { ...state.data.stage_assets, [request.stage]: assets },
		delivery_epoch: state.data.delivery_epoch + 1,
	});
}
