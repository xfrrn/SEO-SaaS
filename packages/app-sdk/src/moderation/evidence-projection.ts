import type {
	AttemptState,
	CheckReport,
	ModerationDecision,
	ModerationTransaction,
	StoredRecord,
} from "./types";

export function checkProjection(check: CheckReport | ModerationDecision) {
	return {
		stage: check.stage,
		policy_version: check.policy_version,
		capability_snapshot_id: check.capability_snapshot_id,
		decision: check.decision,
		block_level: check.block_level,
		execution: check.execution,
		created_at: check.created_at,
		coverage: check.check_coverage.map(
			({
				requested_check_id,
				category,
				modality,
				minimum_scope,
				required,
				mode,
				coverage,
				reason_code,
			}) => ({
				requested_check_id,
				category,
				modality,
				minimum_scope,
				required,
				mode,
				coverage,
				reason_code,
			}),
		),
		findings: check.findings.map(
			({
				category,
				modality,
				inspection_scope,
				coverage,
				mode,
				decision,
				block_level,
				detector_id,
				detector_version,
				provider_model,
				native_category,
				native_flagged,
				score,
				threshold,
				rule_id,
				reason_code,
			}) => ({
				category,
				modality,
				inspection_scope,
				coverage,
				mode,
				decision,
				block_level,
				detector_id,
				detector_version,
				provider_model,
				native_category,
				native_flagged,
				score,
				threshold,
				rule_id,
				reason_code,
			}),
		),
		abuse: check.abuse_findings.map(
			({
				rule_id,
				coverage,
				observed_count,
				threshold,
				effect,
				mode,
				reason_code,
			}) => ({
				rule_id,
				coverage,
				observed_count,
				threshold,
				effect,
				mode,
				reason_code,
			}),
		),
	};
}

export function eventProjection(record: StoredRecord) {
	const data = record.data;
	const common = {
		type: "event",
		event_type: data.type,
		attempt_id: record.attempt_id,
		recorded_at: record.created_at,
	};
	if (data.type === "provider_result")
		return {
			...common,
			status: data.status,
			provider: data.provider,
			model: data.provider_model,
			error_code: data.error_code,
		};
	if (data.type === "outcome")
		return {
			...common,
			original_outcome: data.outcome,
			decision_id: data.decision_id,
		};
	if (data.type === "delivery")
		return {
			...common,
			status: data.status,
			observed_at: data.observed_at,
			decision_id: data.decision_id,
			anomaly: data.anomaly,
		};
	if (
		[
			"audit_anomaly",
			"review_timeout",
			"action_receipt",
			"cleanup_receipt",
		].includes(String(data.type))
	)
		return {
			...common,
			reason_code: data.reason_code ?? null,
			status: data.status ?? null,
			decision_id: data.decision_id ?? null,
		};
	return null;
}

export async function summarize(
	tx: ModerationTransaction,
	attempts: AttemptState[],
	decisions: ModerationDecision[],
	reports: CheckReport[],
	deliveries: {
		attempt_id: string | null;
		status: string;
		occurred_at: string;
	}[],
) {
	const unique = new Map(
		attempts.map((attempt) => [attempt.attempt_id, attempt]),
	);
	const generation = [...unique.values()].filter(
		(attempt) => attempt.kind === "generation",
	);
	const current: ModerationDecision[] = [];
	const initial = new Map<string, ModerationDecision>();
	for (const decision of decisions) {
		const attempt = await tx.get<AttemptState>("attempt", decision.attempt_id);
		if (
			attempt?.data.stages[decision.stage]?.decision_id === decision.decision_id
		)
			current.push(decision);
		const key = `${decision.attempt_id}:${decision.stage}`;
		if (!initial.has(key) || initial.get(key)!.created_at > decision.created_at)
			initial.set(key, decision);
	}
	const checks = new Map<string, { coverage: string; created_at: string }>();
	for (const report of [...reports, ...decisions]) {
		const id =
			report.attempt_id ??
			("report_id" in report ? report.report_id : report.decision_id);
		for (const coverage of report.check_coverage) {
			const key = `${id}:${report.stage}:${report.content_revision}:${report.policy_version}:${coverage.requested_check_id}`;
			if (!checks.has(key) || checks.get(key)!.created_at <= report.created_at)
				checks.set(key, {
					coverage: coverage.coverage,
					created_at: report.created_at,
				});
		}
	}
	const latestDelivery = new Map<
		string,
		{ status: string; occurred_at: string }
	>();
	for (const delivery of deliveries)
		if (
			delivery.attempt_id &&
			(!latestDelivery.has(delivery.attempt_id) ||
				latestDelivery.get(delivery.attempt_id)!.occurred_at <
					delivery.occurred_at)
		)
			latestDelivery.set(delivery.attempt_id, delivery);
	const initialBlocked = new Set(
		[...initial.values()]
			.filter((decision) => decision.decision === "block")
			.map((decision) => decision.attempt_id),
	);
	const currentDenied = new Set(
		current
			.filter((decision) => decision.decision !== "allow")
			.map((decision) => decision.attempt_id),
	);
	const allAttempts = new Set([
		...unique.keys(),
		...decisions.map((decision) => decision.attempt_id),
	]);
	return {
		attempts: allAttempts.size,
		unknown_attempts: allAttempts.size - unique.size,
		generation_attempts: generation.length,
		publication_attempts: [...unique.values()].filter(
			(attempt) => attempt.kind === "publication",
		).length,
		reuse_attempts: [...unique.values()].filter(
			(attempt) => attempt.kind === "reuse",
		).length,
		original_outcomes: {
			accepted: generation.filter((attempt) => attempt.outcome === "accepted")
				.length,
			refused: generation.filter((attempt) => attempt.outcome === "refused")
				.length,
			output_blocked: generation.filter(
				(attempt) => attempt.outcome === "output_blocked",
			).length,
			unknown: generation.filter((attempt) => attempt.outcome === null).length,
		},
		initial_blocked_attempts: initialBlocked.size,
		initial_block_rate: allAttempts.size
			? initialBlocked.size / allAttempts.size
			: null,
		current_denied_attempts: currentDenied.size,
		current_denial_rate: allAttempts.size
			? currentDenied.size / allAttempts.size
			: null,
		current_decisions: {
			total: current.length,
			review: current.filter((decision) => decision.decision === "review")
				.length,
			error: current.filter((decision) => decision.execution === "error")
				.length,
		},
		logical_checks: {
			total: checks.size,
			checked: [...checks.values()].filter(
				(value) => value.coverage === "checked",
			).length,
			unsupported: [...checks.values()].filter(
				(value) => value.coverage === "unsupported",
			).length,
			failed: [...checks.values()].filter(
				(value) => value.coverage === "failed",
			).length,
			missing: [...checks.values()].filter(
				(value) => value.coverage === "missing",
			).length,
			skipped: [...checks.values()].filter(
				(value) => value.coverage === "skipped",
			).length,
		},
		actual_delivery: {
			known_attempts: latestDelivery.size,
			released: [...latestDelivery.values()].filter(
				(value) => value.status === "released",
			).length,
			withheld: [...latestDelivery.values()].filter(
				(value) => value.status === "withheld",
			).length,
			revoked: [...latestDelivery.values()].filter(
				(value) => value.status === "revoked",
			).length,
		},
		false_positive_rate: null,
		false_negative_rate: null,
	};
}
