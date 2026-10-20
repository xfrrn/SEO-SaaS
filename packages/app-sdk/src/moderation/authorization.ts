import type { ConsentProof } from "./authorization-consents";
import { validateConsentScope } from "./authorization-consents";
import type { ConsentState } from "./consents";
import { canonical, moderationError } from "./primitives";
import type { ModerationRuntime, Prepared } from "./runtime";
import type {
	AttemptState,
	AuthorizeRequest,
	EnforcementAction,
	ModerationDecision,
	ModerationTransaction,
	Operation,
	OperationAuthorization,
	Stage,
	StoredRecord,
	TrustedContext,
} from "./types";
import { authorizationSchema } from "./validation";
import { operationStages, stagePrerequisites } from "./workflow";

interface GrantCommand {
	fingerprint: string;
	result: OperationAuthorization;
	delivery_epoch: number;
}
interface Assessment {
	decision_ids: string[];
	deadlines: number[];
	reason: string | null;
}
const purpose = (operation: Operation) =>
	operation === "deliver" ? "publish" : operation;
const isFuture = (value: string, now: number) =>
	Number.isFinite(Date.parse(value)) && Date.parse(value) > now;

async function assess(
	tx: ModerationTransaction,
	tenant_id: string,
	attempt: StoredRecord<AttemptState>,
	stages: Stage[],
	operation: Operation,
	prepared: Prepared,
	now: number,
	result: Assessment,
	source = false,
	targetOperation: Operation = operation,
): Promise<string | null> {
	const state = attempt.data;
	if (
		attempt.subject_id !== state.subject_id ||
		attempt.key !== state.attempt_id ||
		attempt.attempt_id !== state.attempt_id
	)
		return "ATTEMPT_BINDING_MISMATCH";
	if (state.revoked) return "ATTEMPT_REVOKED";
	if (state.provider_status === "policy_refused")
		return "PROVIDER_POLICY_REFUSED";
	if (
		!source &&
		state.kind === "generation" &&
		operation === "generate" &&
		state.provider_status !== null
	)
		return "NEW_GENERATION_ATTEMPT_REQUIRED";
	if (
		state.kind === "generation" &&
		operation !== "generate" &&
		state.provider_status !== "succeeded"
	)
		return "PROVIDER_SUCCESS_REQUIRED";
	if (stages.some((stage) => !state.stages[stage])) return "CHECKPOINT_MISSING";
	for (const [stage, current] of Object.entries(state.stages)) {
		const stored = await tx.get<ModerationDecision>(
			"decision",
			current.decision_id,
		);
		const decision = stored?.data;
		if (
			!stored ||
			!decision ||
			stored.subject_id !== state.subject_id ||
			stored.attempt_id !== state.attempt_id ||
			decision.tenant_id !== tenant_id ||
			decision.subject_id !== state.subject_id ||
			decision.attempt_id !== state.attempt_id ||
			decision.decision_id !== current.decision_id ||
			decision.stage !== stage ||
			decision.job_id !== state.job_id ||
			decision.content_revision !== current.content_revision ||
			decision.context_digest !== current.context_digest
		)
			return "DECISION_BINDING_MISMATCH";
		const prior = stagePrerequisites(state.kind, decision.stage);
		const prerequisites = prior?.map(
			(entry) => state.stages[entry]?.decision_id ?? null,
		);
		if (
			!prior ||
			prerequisites?.includes(null) ||
			canonical(prerequisites) !== canonical(decision.prerequisite_decision_ids)
		)
			return "PREREQUISITE_CHANGED";
		if (decision.policy_version !== prepared.policy.version)
			return "POLICY_REEVALUATION_REQUIRED";
		if (decision.capability_snapshot_id !== prepared.capability_snapshot_id)
			return "CAPABILITY_REEVALUATION_REQUIRED";
		if (decision.decision !== "allow" || decision.enforcement !== "continue")
			return "CURRENT_DECISION_DENIED";
		if (decision.expires_at !== null) {
			if (!isFuture(decision.expires_at, now)) return "DECISION_EXPIRED";
			result.deadlines.push(Date.parse(decision.expires_at));
		}
		if (
			decision.check_coverage.some(
				(check) =>
					check.required &&
					check.mode === "enforce" &&
					check.coverage !== "checked" &&
					check.coverage !== "not_applicable",
			)
		)
			return "REQUIRED_COVERAGE_INCOMPLETE";
		result.decision_ids.push(decision.decision_id);
		for (const id of decision.action_ids) {
			const record = await tx.get<EnforcementAction>("action", id);
			const action = record?.data;
			if (
				!record ||
				!action ||
				record.subject_id !== state.subject_id ||
				record.attempt_id !== state.attempt_id ||
				action.action_id !== id ||
				action.subject_id !== state.subject_id ||
				action.attempt_id !== state.attempt_id ||
				action.status !== "succeeded" ||
				!isFuture(action.expires_at, now)
			)
				return "ACTION_INCOMPLETE";
			result.deadlines.push(Date.parse(action.expires_at));
		}
	}
	for (const id of state.consent_ids) {
		const record = await tx.get<ConsentState>("consent", id);
		const consent = record?.data;
		if (
			!record ||
			!consent ||
			record.subject_id !== state.subject_id ||
			consent.subject_id !== state.subject_id ||
			consent.consent_id !== id ||
			consent.status !== "verified" ||
			!consent.purposes.includes(purpose(operation)) ||
			!consent.verified_purposes?.includes(purpose(operation)) ||
			!consent.purposes.includes(purpose(targetOperation)) ||
			!consent.verified_purposes?.includes(purpose(targetOperation)) ||
			!isFuture(consent.expires_at, now) ||
			consent.verified_expires_at === null ||
			!isFuture(consent.verified_expires_at, now)
		)
			return "CONSENT_INVALID";
		result.deadlines.push(
			Date.parse(consent.expires_at),
			Date.parse(consent.verified_expires_at),
		);
	}
	return null;
}

async function prerequisites(
	tx: ModerationTransaction,
	context: TrustedContext,
	attempt: StoredRecord<AttemptState>,
	operation: Operation,
	prepared: Prepared,
	now: number,
): Promise<Assessment> {
	const result: Assessment = { decision_ids: [], deadlines: [], reason: null };
	const stages = operationStages(attempt.data.kind, operation);
	if (!stages) return { ...result, reason: "INVALID_WORKFLOW" };
	result.reason = await assess(
		tx,
		context.tenant_id,
		attempt,
		stages,
		operation,
		prepared,
		now,
		result,
	);
	if (result.reason) return result;
	const visited = new Set([attempt.key]);
	const sources = [...attempt.data.source_decision_ids];
	for (let index = 0; index < sources.length; index++) {
		const source = await tx.get<ModerationDecision>(
			"decision",
			sources[index]!,
		);
		const sourceAttempt = source
			? await tx.get<AttemptState>("attempt", source.data.attempt_id)
			: null;
		if (
			!source ||
			!sourceAttempt ||
			source.data.tenant_id !== context.tenant_id ||
			source.subject_id !== sourceAttempt.data.subject_id ||
			source.data.subject_id !== sourceAttempt.data.subject_id ||
			source.attempt_id !== sourceAttempt.key ||
			sourceAttempt.data.stages[source.data.stage]?.decision_id !== source.key
		) {
			result.reason = "SOURCE_DECISION_INVALID";
			break;
		}
		if (sourceAttempt.key === attempt.key) {
			result.reason = "SOURCE_CYCLE";
			break;
		}
		const visitedSource = visited.has(sourceAttempt.key);
		visited.add(sourceAttempt.key);
		const sourceOperation =
			source.data.stage === "presentation" || source.data.stage === "output"
				? "publish"
				: source.data.operation;
		const sourceStages = operationStages(
			sourceAttempt.data.kind,
			sourceOperation,
		);
		if (!sourceStages) {
			result.reason = "SOURCE_WORKFLOW_INVALID";
			break;
		}
		result.reason = await assess(
			tx,
			context.tenant_id,
			sourceAttempt,
			sourceStages,
			sourceOperation,
			prepared,
			now,
			result,
			true,
			operation,
		);
		if (result.reason) break;
		if (!visitedSource) sources.push(...sourceAttempt.data.source_decision_ids);
	}
	result.decision_ids = [...new Set(result.decision_ids)];
	return result;
}

/** Only this operation grants a bounded permit; idempotent calls recheck live state. */
export function createModerationAuthorization(runtime: ModerationRuntime) {
	async function authorizeOperation(
		request: AuthorizeRequest,
	): Promise<OperationAuthorization> {
		const input = authorizationSchema.parse(request);
		const denied = (reason_code: string): OperationAuthorization => ({
			authorization_id: null,
			attempt_id: input.attempt_id,
			operation: input.operation,
			permit: false,
			decision_ids: [],
			reason_code,
			expires_at: null,
		});
		let prepared: Prepared;
		try {
			prepared = await runtime.prepare(input.context, "authorize");
		} catch {
			const result = denied("AUTHORIZATION_UNAVAILABLE");
			await runtime.options.storage.transaction(input.context.tenant_id, (tx) =>
				runtime.event(
					tx,
					input.context,
					`authorization_check:${crypto.randomUUID()}`,
					"authorization_check",
					result,
					input.attempt_id,
				),
			);
			return result;
		}
		const fingerprint = await runtime.fingerprint(input.context, input);
		const target: Stage =
			input.operation === "generate"
				? "input"
				: input.operation === "reuse"
					? "reuse"
					: "presentation";
		const consentProof: ConsentProof = prepared.controls.block_all
			? { attempt_revisions: new Map(), revisions: new Map(), reason: null }
			: await validateConsentScope(runtime, input);
		return runtime.options.storage.transaction(
			input.context.tenant_id,
			async (tx) => {
				const now = Date.now();
				const key = `authorize:${input.idempotency_key}`;
				const previous = await tx.get<GrantCommand>("command", key);
				if (
					previous &&
					(previous.data.fingerprint !== fingerprint ||
						previous.subject_id !== input.context.subject_id)
				)
					throw moderationError(
						"IDEMPOTENCY_CONFLICT",
						"Moderation authorization key already used",
					);
				await runtime.snapshots(tx, prepared);
				const record = await tx.get<AttemptState>("attempt", input.attempt_id);
				let result = denied("ATTEMPT_UNAVAILABLE");
				let delivery_epoch = 0;
				if (
					record &&
					record.subject_id === input.context.subject_id &&
					record.data.subject_id === input.context.subject_id
				) {
					delivery_epoch = record.data.delivery_epoch;
					const current = record.data.stages[target];
					const checks: Assessment = prepared.controls.block_all
						? { decision_ids: [], deadlines: [], reason: "BLOCK_ALL" }
						: await prerequisites(
								tx,
								input.context,
								record,
								input.operation,
								prepared,
								now,
							);
					const issuedAt = Date.now();
					const reason = prepared.controls.block_all
						? "BLOCK_ALL"
						: (checks.reason ??
							(checks.deadlines.some((deadline) => deadline <= issuedAt)
								? "PREREQUISITE_EXPIRED"
								: null) ??
							consentProof.reason ??
							(consentProof.attempt_revisions.get(record.key) !==
							record.revision
								? "CONSENT_RECHECK_REQUIRED"
								: null) ??
							(!current ||
							current.content_revision !== input.content_revision ||
							current.context_digest !== input.context_digest
								? "TARGET_VERSION_MISMATCH"
								: null));
					let finalReason = reason;
					for (const [id, revision] of consentProof.attempt_revisions) {
						const attempt = await tx.get<AttemptState>("attempt", id);
						if (!attempt || attempt.revision !== revision)
							finalReason = "CONSENT_RECHECK_REQUIRED";
					}
					for (const [id, revision] of consentProof.revisions) {
						const consent = await tx.get<ConsentState>("consent", id);
						if (!consent || consent.revision !== revision)
							finalReason = "CONSENT_RECHECK_REQUIRED";
					}
					if (finalReason)
						result = {
							...denied(finalReason),
							decision_ids: checks.decision_ids,
						};
					else if (previous) {
						const grant = previous.data.result;
						const valid =
							grant.permit &&
							grant.expires_at !== null &&
							isFuture(grant.expires_at, issuedAt) &&
							Date.parse(grant.expires_at) <= Math.min(...checks.deadlines) &&
							previous.data.delivery_epoch === delivery_epoch &&
							canonical(grant.decision_ids) === canonical(checks.decision_ids);
						result = valid ? grant : denied("NEW_AUTHORIZATION_REQUIRED");
					} else
						result = {
							authorization_id: crypto.randomUUID(),
							attempt_id: input.attempt_id,
							operation: input.operation,
							permit: true,
							decision_ids: checks.decision_ids,
							reason_code: "AUTHORIZED",
							expires_at: new Date(
								Math.min(
									issuedAt + prepared.policy.limits.authorization_ttl_ms,
									...checks.deadlines,
								),
							).toISOString(),
						};
				}
				if (!previous)
					await tx.insert({
						kind: "command",
						key,
						subject_id: input.context.subject_id,
						attempt_id: input.attempt_id,
						data: {
							fingerprint,
							result,
							delivery_epoch,
						} satisfies GrantCommand,
					});
				await runtime.event(
					tx,
					input.context,
					result.permit && !previous
						? `authorization:${result.authorization_id}`
						: `authorization_check:${crypto.randomUUID()}`,
					result.permit && !previous ? "authorization" : "authorization_check",
					{
						...result,
						content_revision: input.content_revision,
						context_digest: input.context_digest,
						delivery_epoch,
						policy_version: prepared.policy.version,
						controls_version: prepared.controls.version,
					},
					input.attempt_id,
				);
				return result;
			},
		);
	}
	return { authorizeOperation };
}
