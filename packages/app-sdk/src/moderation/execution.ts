import { assessAbuse, resolveAbuse } from "./abuse";
import { analyze } from "./analysis";
import { bindConsents, createActions } from "./effects";
import type { ReviewCommand } from "./execution-state";
import { abandon, reserve } from "./execution-state";
import { bounded, moderationError, rank } from "./primitives";
import type { CommandState, ModerationRuntime } from "./runtime";
import type {
	CheckReport,
	CheckRequest,
	ConsentDeclaration,
	EnforcementAction,
	EvaluationRequest,
	EvaluationResult,
	ModerationDecision,
} from "./types";
import { checkSchema, evaluationSchema } from "./validation";
import { reviewedState, saveDecision } from "./workflow";

/** Execute checks outside transactions, then atomically bind results to the current attempt. */
export function createModerationExecution(runtime: ModerationRuntime) {
	async function execute(
		method: "check" | "evaluate",
		input: CheckRequest | EvaluationRequest,
		signal?: AbortSignal,
		review?: ReviewCommand,
	): Promise<CheckReport | EvaluationResult> {
		const prepared = await runtime.prepare(input.context, method);
		const reserved = await reserve<CheckReport | EvaluationResult>(
			runtime,
			prepared,
			method,
			input,
			review,
		);
		if ("replay" in reserved) return reserved.replay;
		try {
			const controller = AbortSignal.any([
				...(signal ? [signal] : []),
				AbortSignal.timeout(prepared.policy.limits.command_lease_ms),
			]);
			const analysis = await analyze(
				runtime,
				input,
				prepared,
				reserved,
				controller,
				!!review,
			);
			if (
				"attempt_kind" in input &&
				input.consent_ids.length &&
				analysis.report.decision !== "legal_hold"
			) {
				let verified = !!runtime.options.validateConsent;
				for (const id of input.consent_ids) {
					const consent = await runtime.options.storage.get<ConsentDeclaration>(
						input.context.tenant_id,
						"consent",
						id,
					);
					if (!consent || !runtime.options.validateConsent) {
						verified = false;
						break;
					}
					try {
						const consentValid = await bounded(
							runtime.options.boundary_timeout_ms,
							() =>
								runtime.options.validateConsent!(
									input.context,
									consent.data,
									input.items.flatMap((item) =>
										item.modality === "text"
											? []
											: [
													{
														item_id: item.item_id,
														revision: item.revision,
														asset_ref: item.asset_ref,
													},
												],
									),
									input.operation,
								),
							controller,
						);
						if (consentValid === false) verified = false;
					} catch {
						verified = false;
					}
				}
				if (
					!verified &&
					rank(analysis.report.decision, analysis.report.block_level) < 1
				)
					analysis.report.decision = "review";
			}
			const identity =
				"attempt_kind" in input && prepared.policy.abuse_rules.length
					? await resolveAbuse(runtime, input, prepared).catch(() => ({
							account_ref: "",
							ip_digest: null,
							device_ref: null,
							payment_ref: null,
							source_version: "unavailable",
							observed_at: new Date().toISOString(),
						}))
					: null;
			return await runtime.options.storage.transaction(
				input.context.tenant_id,
				async (tx) => {
					const command = await tx.get<CommandState>(
						"command",
						reserved.command.key,
					);
					if (
						!command ||
						command.revision !== reserved.command.revision ||
						command.data.status !== "running" ||
						Date.parse(command.data.lease_until) <= Date.now()
					)
						throw moderationError(
							"STATE_CONFLICT",
							"Moderation execution lease expired",
						);
					let result: CheckReport | EvaluationResult = analysis.report;
					if (
						reserved.review_deadline &&
						Date.parse(reserved.review_deadline) <= Date.now()
					)
						throw moderationError(
							"REVIEW_EXPIRED",
							"Review deadline elapsed during checks",
						);
					if ("attempt_kind" in input) {
						const state = await runtime.attempt(
							tx,
							input.context,
							input.attempt_id,
						);
						if (state.revision !== reserved.state?.revision)
							throw moderationError(
								"STATE_CONFLICT",
								"Moderation state changed during checks",
								{
									current_state_revision: state.revision,
									current_decision_ids: Object.values(state.data.stages).map(
										(entry) => entry.decision_id,
									),
								},
							);
						if (identity && analysis.report.decision !== "legal_hold")
							analysis.report.abuse_findings = await assessAbuse(
								runtime,
								tx,
								input,
								prepared,
								analysis.report,
								identity,
							);
						const decision: ModerationDecision = {
							...analysis.report,
							job_id: input.job_id,
							attempt_id: input.attempt_id,
							decision_id: crypto.randomUUID(),
							operation: input.operation,
							enforcement:
								analysis.report.decision === "legal_hold"
									? "quarantine"
									: analysis.report.decision === "allow"
										? "continue"
										: "deny",
							prerequisite_decision_ids: reserved.prior.map(
								(entry) => entry.decision_id,
							),
							action_ids: [],
							mode: "enforce",
							would_decision: analysis.would_decision,
							would_block_level: analysis.would_block_level,
							would_action_types: [],
							supersedes_decision_id:
								state.data.stages[input.stage]?.decision_id ?? null,
							expires_at: null,
						};
						await createActions(runtime, tx, input, prepared, decision);
						for (const finding of decision.abuse_findings)
							if (finding.effect !== "none") {
								if (
									rank(decision.would_decision, decision.would_block_level) < 1
								)
									decision.would_decision = "review";
								decision.would_action_types.push(finding.effect);
								if (
									finding.mode === "enforce" &&
									rank(decision.decision, decision.block_level) < 1
								) {
									const actions = await Promise.all(
										decision.action_ids.map((id) =>
											tx.get<EnforcementAction>("action", id),
										),
									);
									const action = actions.find(
										(entry) =>
											entry?.data.rule_id === finding.rule_id &&
											entry.data.type === finding.effect,
									);
									if (
										finding.effect === "review" ||
										action?.data.status !== "succeeded" ||
										!(Date.parse(action.data.expires_at) > Date.now())
									) {
										decision.decision = "review";
										decision.block_level = null;
										decision.enforcement = "deny";
									}
								}
							}
						if (
							!(await bindConsents(runtime, tx, input)) &&
							rank(decision.decision, decision.block_level) < 1
						) {
							decision.decision = "review";
							decision.enforcement = "deny";
						}
						if (decision.decision === "review")
							decision.expires_at =
								reserved.review_deadline ??
								new Date(
									Date.now() + prepared.policy.limits.review_ttl_ms,
								).toISOString();
						const safeInput =
							decision.decision === "legal_hold"
								? { ...input, items: [] }
								: input;
						if (decision.decision === "legal_hold") {
							for (const consent_id of input.consent_ids) {
								const key = `restricted_consent:${consent_id}`;
								if (!(await tx.get("event", key)))
									await runtime.event(
										tx,
										input.context,
										key,
										"restricted_consent",
										{ consent_id },
										input.attempt_id,
									);
							}
						}
						const updated = await saveDecision(
							tx,
							reviewedState(state, decision, review?.expected_decision_id),
							safeInput,
							decision,
						);
						await runtime.event(
							tx,
							input.context,
							`evaluated:${decision.decision_id}`,
							review ? "review_resolved" : "evaluated",
							{
								decision_id: decision.decision_id,
								reason_code:
									review?.reason_code ??
									(!input.items.length && input.stage === "input"
										? "EMPTY_INPUT_NOT_APPLICABLE"
										: "EVALUATED"),
								review_event_id: review?.event_id ?? null,
							},
							input.attempt_id,
						);
						result = { decision, state_revision: updated.revision };
					} else
						await tx.insert({
							kind: "report",
							key: analysis.report.report_id,
							subject_id: input.context.subject_id,
							attempt_id: input.attempt_id,
							data: analysis.report,
						});
					await tx.replace(command, {
						...command.data,
						status: "done",
						result,
					});
					return result;
				},
			);
		} catch (error) {
			await abandon(runtime, input.context.tenant_id, reserved);
			throw error;
		}
	}
	return {
		async check(input: CheckRequest, signal?: AbortSignal) {
			return execute(
				"check",
				checkSchema.parse(input),
				signal,
			) as Promise<CheckReport>;
		},
		async evaluate(input: EvaluationRequest, signal?: AbortSignal) {
			return execute(
				"evaluate",
				evaluationSchema.parse(input),
				signal,
			) as Promise<EvaluationResult>;
		},
		async evaluateReview(input: EvaluationRequest, review: ReviewCommand) {
			return execute(
				"evaluate",
				evaluationSchema.parse(input),
				undefined,
				review,
			) as Promise<EvaluationResult>;
		},
	};
}
