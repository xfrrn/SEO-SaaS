import * as z from "zod";
import { createModerationCleanup } from "./cleanup";
import {
	boundedLimit,
	pageLimit,
	token,
	trustedContext,
} from "./lifecycle-validation";
import { bounded, moderationError } from "./primitives";
import type { ModerationRuntime } from "./runtime";
import type {
	AttemptState,
	EffectivePolicy,
	EnforcementAction,
	ModerationDecision,
	ModerationTransaction,
} from "./types";

export type { CleanupReceipt, CleanupRequest } from "./cleanup";

const pageSchema = z
	.object({
		context: trustedContext,
		cursor: z
			.string()
			.min(1)
			.max(4096)
			.regex(/^[A-Za-z0-9_.:-]+$/)
			.optional(),
		limit: pageLimit.optional(),
	})
	.strict();
const expireSchema = pageSchema.extend({ idempotency_key: token });
const actionsSchema = pageSchema.extend({ idempotency_key: token });
export type ListReviewsRequest = z.infer<typeof pageSchema>;
export type ExpireReviewsRequest = z.infer<typeof expireSchema>;
export type RunActionsRequest = z.infer<typeof actionsSchema>;
export function createModerationMaintenance(runtime: ModerationRuntime) {
	async function listReviews(request: ListReviewsRequest) {
		const input = pageSchema.parse(request);
		const prepared = await runtime.prepare(input.context, "review");
		const limit = boundedLimit(
			input.limit,
			prepared.policy.limits.max_page_size,
		);
		return runtime.options.storage.transaction(
			input.context.tenant_id,
			async (tx) => {
				const records = await tx.list<ModerationDecision>("decision", {
					...(input.cursor ? { after: input.cursor } : {}),
					limit,
				});
				const reviews: {
					decision: ModerationDecision;
					state_revision: number;
				}[] = [];
				for (const record of records) {
					if (record.data.decision !== "review") continue;
					const attempt = await tx.get<AttemptState>(
						"attempt",
						record.data.attempt_id,
					);
					if (
						attempt?.data.stages[record.data.stage]?.decision_id ===
							record.key &&
						!(await attemptHeld(tx, attempt.data))
					)
						reviews.push({
							decision: record.data,
							state_revision: attempt.revision,
						});
				}
				return {
					reviews,
					next_cursor:
						records.length === limit ? records[records.length - 1]!.key : null,
				};
			},
		);
	}

	async function expireReviews(request: ExpireReviewsRequest) {
		const input = expireSchema.parse(request);
		return runtime.command(
			input.context,
			"expire_reviews",
			input.idempotency_key,
			input,
			"worker",
			async (tx, prepared) => {
				const limit = boundedLimit(
					input.limit,
					prepared.policy.limits.max_page_size,
				);
				const records = await tx.list<ModerationDecision>("decision", {
					...(input.cursor ? { after: input.cursor } : {}),
					limit,
				});
				let expired = 0;
				for (const record of records) {
					const old = record.data;
					if (
						old.decision !== "review" ||
						old.expires_at === null ||
						Date.parse(old.expires_at) > Date.now()
					)
						continue;
					const attempt = await tx.get<AttemptState>("attempt", old.attempt_id);
					if (
						!attempt ||
						attempt.data.stages[old.stage]?.decision_id !== old.decision_id ||
						(await attemptHeld(tx, attempt.data))
					)
						continue;
					const decision_id = crypto.randomUUID();
					const decision: ModerationDecision = {
						...old,
						decision_id,
						decision: "block",
						block_level: "soft",
						enforcement: "deny",
						mode: "enforce",
						would_decision: "block",
						would_block_level: "soft",
						supersedes_decision_id: old.decision_id,
						expires_at: null,
						created_at: new Date().toISOString(),
					};
					await tx.insert({
						kind: "decision",
						key: decision_id,
						subject_id: old.subject_id,
						attempt_id: old.attempt_id,
						data: decision,
					});
					await tx.replace(attempt, {
						...attempt.data,
						revoked: true,
						revocation_reasons: [
							...new Set([
								...(attempt.data.revocation_reasons ?? []),
								"review_timeout",
							]),
						],
						delivery_epoch: attempt.data.delivery_epoch + 1,
						stages: {
							...attempt.data.stages,
							[old.stage]: {
								decision_id,
								content_revision: old.content_revision,
								context_digest: old.context_digest,
							},
						},
					});
					await runtime.event(
						tx,
						{ ...input.context, subject_id: old.subject_id },
						`review_timeout:${decision_id}`,
						"review_timeout",
						{
							decision_id,
							supersedes_decision_id: old.decision_id,
							reason_code: "REVIEW_TIMEOUT",
						},
						old.attempt_id,
					);
					expired++;
				}
				return {
					expired,
					next_cursor:
						records.length === limit ? records[records.length - 1]!.key : null,
				};
			},
		);
	}

	async function runPendingActions(request: RunActionsRequest) {
		const input = actionsSchema.parse(request);
		const claims = await runtime.command(
			input.context,
			"claim_actions",
			input.idempotency_key,
			input,
			"worker",
			async (tx, prepared) => {
				const limit = boundedLimit(
					input.limit,
					prepared.policy.limits.max_page_size,
				);
				const claimed: EnforcementAction[] = [];
				const terminal_receipts: {
					action_id: string;
					status: "failed";
					reason_code: string;
				}[] = [];
				const records = await tx.list<EnforcementAction>("action", {
					...(input.cursor ? { after: input.cursor } : {}),
					limit,
				});
				for (const record of records) {
					const action = record.data;
					if (action.status === "succeeded") continue;
					const terminalReason =
						Date.parse(action.expires_at) <= Date.now()
							? "ACTION_EXPIRED"
							: action.attempts >= prepared.policy.limits.action_max_attempts
								? "ACTION_RETRY_LIMIT"
								: null;
					if (terminalReason) {
						if (
							action.status !== "failed" ||
							action.reason_code !== terminalReason
						) {
							await tx.replace(record, {
								...action,
								status: "failed",
								reason_code: terminalReason,
								lease_token: null,
								lease_until: null,
							});
							await runtime.event(
								tx,
								{ ...input.context, subject_id: action.subject_id },
								`action_terminal:${action.action_id}:${terminalReason}`,
								"action_receipt",
								{
									action_id: action.action_id,
									decision_id: action.decision_id,
									status: "failed",
									reason_code: terminalReason,
									attempts: action.attempts,
								},
								action.attempt_id,
							);
						}
						terminal_receipts.push({
							action_id: action.action_id,
							status: "failed",
							reason_code: terminalReason,
						});
						continue;
					}
					if (
						Date.parse(action.next_attempt_at) > Date.now() ||
						(action.lease_until !== null &&
							Date.parse(action.lease_until) > Date.now())
					)
						continue;
					const decision = await tx.get<ModerationDecision>(
						"decision",
						action.decision_id,
					);
					if (!decision || !decision.data.action_ids.includes(action.action_id))
						continue;
					const sourcePolicy = await tx.get<EffectivePolicy>(
						"policy",
						decision.data.policy_version,
					);
					const sourceRule =
						sourcePolicy &&
						[...sourcePolicy.data.rules, ...sourcePolicy.data.abuse_rules].find(
							(rule) => rule.id === action.rule_id,
						);
					if (!sourceRule)
						throw moderationError(
							"INVALID_ACTION",
							"Action source policy or rule is missing",
						);
					if (sourceRule.mode !== "enforce") continue;
					if (
						!(await actionIsCurrent(
							tx,
							action,
							decision.data,
							sourcePolicy!.data.abuse_rules.some(
								(rule) => rule.id === action.rule_id,
							),
						))
					)
						continue;
					const updated = {
						...action,
						attempts: action.attempts + 1,
						lease_token: crypto.randomUUID(),
						lease_until: new Date(
							Date.now() + prepared.policy.limits.action_lease_ms,
						).toISOString(),
					};
					await tx.replace(record, updated);
					claimed.push(updated);
				}
				return {
					actions: claimed,
					terminal_receipts,
					retry_ms: prepared.policy.limits.action_retry_ms,
					lease_ms: prepared.policy.limits.action_lease_ms,
					next_cursor:
						records.length === limit ? records[records.length - 1]!.key : null,
				};
			},
		);
		const receipts: {
			action_id: string;
			status: "succeeded" | "failed" | "pending" | "superseded";
			reason_code: string;
		}[] = [...claims.terminal_receipts];
		for (const action of claims.actions) {
			const leased = await runtime.options.storage.transaction(
				input.context.tenant_id,
				async (tx) => {
					const current = await tx.get<EnforcementAction>(
						"action",
						action.action_id,
					);
					if (
						!current ||
						current.data.lease_token !== action.lease_token ||
						current.data.status === "succeeded" ||
						Date.parse(current.data.expires_at) <= Date.now()
					)
						return null;
					const source = await tx.get<ModerationDecision>(
						"decision",
						current.data.decision_id,
					);
					const policy =
						source &&
						(await tx.get<EffectivePolicy>(
							"policy",
							source.data.policy_version,
						));
					if (
						!source ||
						!policy ||
						!(await actionIsCurrent(
							tx,
							current.data,
							source.data,
							policy.data.abuse_rules.some(
								(rule) => rule.id === current.data.rule_id,
							),
						))
					)
						return null;
					return (
						await tx.replace(current, {
							...current.data,
							lease_until: new Date(Date.now() + claims.lease_ms).toISOString(),
						})
					).data;
				},
			);
			if (!leased) continue;
			let outcome: {
				status: "succeeded" | "failed" | "pending";
				reason_code: string;
			};
			try {
				const value = runtime.options.executeAction
					? await bounded(
							Math.min(
								runtime.options.boundary_timeout_ms,
								Math.max(1, Date.parse(leased.lease_until!) - Date.now()),
							),
							(signal) =>
								runtime.options.executeAction!({
									...leased,
									context: { ...input.context, subject_id: action.subject_id },
									signal,
								}),
						)
					: { status: "failed", reason_code: "ACTION_ADAPTER_MISSING" };
				outcome = z
					.object({
						status: z.enum(["succeeded", "failed", "pending"]),
						reason_code: token,
					})
					.strict()
					.parse(value);
			} catch {
				outcome = { status: "failed", reason_code: "ACTION_EXECUTION_FAILED" };
			}
			const receipt = await runtime.options.storage.transaction(
				input.context.tenant_id,
				async (tx) => {
					const live = await tx.get<EnforcementAction>(
						"action",
						action.action_id,
					);
					if (!live || live.data.lease_token !== action.lease_token)
						return {
							action_id: action.action_id,
							status: "superseded" as const,
							reason_code: "ACTION_LEASE_SUPERSEDED",
						};
					await tx.replace(live, {
						...live.data,
						status: outcome.status,
						reason_code: outcome.reason_code,
						lease_token: null,
						lease_until: null,
						next_attempt_at: new Date(
							Date.now() + claims.retry_ms,
						).toISOString(),
					});
					await runtime.event(
						tx,
						{ ...input.context, subject_id: action.subject_id },
						`action_receipt:${action.action_id}:${action.attempts}`,
						"action_receipt",
						{
							action_id: action.action_id,
							decision_id: action.decision_id,
							status: outcome.status,
							reason_code: outcome.reason_code,
							attempts: action.attempts,
						},
						action.attempt_id,
					);
					return { action_id: action.action_id, ...outcome };
				},
			);
			receipts.push(receipt);
		}
		return { receipts, next_cursor: claims.next_cursor };
	}

	return {
		listReviews,
		expireReviews,
		runPendingActions,
		...createModerationCleanup(runtime),
	};
}

async function attemptHeld(tx: ModerationTransaction, attempt: AttemptState) {
	for (const stage of Object.values(attempt.stages)) {
		if (
			stage &&
			(await tx.get<ModerationDecision>("decision", stage.decision_id))?.data
				.decision === "legal_hold"
		)
			return true;
	}
	return false;
}

async function actionIsCurrent(
	tx: ModerationTransaction,
	action: EnforcementAction,
	source: ModerationDecision,
	abuse: boolean,
) {
	const attempt = await tx.get<AttemptState>("attempt", action.attempt_id);
	if (!attempt || attempt.data.subject_id !== action.subject_id) return false;
	const stages = abuse
		? Object.values(attempt.data.stages)
		: [attempt.data.stages[source.stage]];
	for (const stage of stages) {
		const current =
			stage &&
			(await tx.get<ModerationDecision>("decision", stage.decision_id));
		if (
			current?.data.attempt_id === action.attempt_id &&
			current.data.subject_id === action.subject_id &&
			current.data.action_ids.includes(action.action_id)
		)
			return true;
	}
	return false;
}
