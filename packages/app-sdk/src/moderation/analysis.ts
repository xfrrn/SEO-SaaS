import { requestedCheckId, runChecks } from "./detection";
import type { Reservation } from "./execution-state";
import { bounded, digest, moderationError, rank } from "./primitives";
import type { ModerationRuntime, Prepared } from "./runtime";
import type {
	BlockLevel,
	CheckReport,
	CheckRequest,
	Decision,
	EvaluationRequest,
} from "./types";

type Analysis = {
	report: CheckReport;
	would_decision: Decision;
	would_block_level: BlockLevel;
};

export async function incomplete(
	input: CheckRequest | EvaluationRequest,
	prepared: Prepared,
	decision: Decision,
	level: BlockLevel,
	reason: string,
	execution: CheckReport["execution"] = "completed",
): Promise<Analysis> {
	const check_coverage = [];
	for (const item of input.items)
		for (const rule of prepared.policy.rules.filter(
			(entry) =>
				entry.stages.includes(input.stage) &&
				entry.modalities.includes(item.modality),
		)) {
			check_coverage.push({
				requested_check_id: await requestedCheckId(item, rule),
				item_id: item.item_id,
				category: rule.category,
				modality: item.modality,
				minimum_scope: rule.minimum_scope,
				required: rule.required,
				mode: rule.mode,
				coverage:
					execution === "completed"
						? ("skipped" as const)
						: ("failed" as const),
				finding_ids: [],
				reason_code: reason,
			});
		}
	return {
		report: {
			report_id: crypto.randomUUID(),
			tenant_id: input.context.tenant_id,
			subject_id: input.context.subject_id,
			job_id: input.job_id,
			attempt_id: input.attempt_id,
			stage: input.stage,
			content_revision: input.content_revision,
			context_digest: input.context_digest,
			policy_version: prepared.policy.version,
			capability_snapshot_id: prepared.capability_snapshot_id,
			findings: [],
			check_coverage,
			abuse_findings: [],
			decision,
			block_level: level,
			execution,
			created_at: new Date().toISOString(),
		},
		would_decision: decision,
		would_block_level: level,
	};
}

export async function analyze(
	runtime: ModerationRuntime,
	input: CheckRequest | EvaluationRequest,
	prepared: Prepared,
	reservation: Reservation,
	signal?: AbortSignal,
	reviewing = false,
): Promise<Analysis> {
	if (prepared.controls.block_all)
		return incomplete(input, prepared, "block", "soft", "BLOCK_ALL");
	const blocked = reservation.prior
		.filter((prior) => prior.decision !== "allow")
		.sort(
			(a, b) =>
				rank(b.decision, b.block_level) - rank(a.decision, a.block_level),
		)[0];
	if (blocked || (reservation.state?.data.revoked && !reviewing))
		return incomplete(
			input,
			prepared,
			blocked?.decision ?? "review",
			blocked?.block_level ?? null,
			"PREREQUISITE_DENIED",
		);
	if (
		input.items.length > prepared.policy.limits.max_items ||
		input.items.reduce(
			(size, item) => size + (item.modality === "text" ? item.text.length : 0),
			0,
		) > prepared.policy.limits.max_text_chars ||
		new Set(input.items.map((item) => item.item_id)).size !== input.items.length
	)
		throw moderationError(
			"INVALID_CONTENT",
			"Moderation content exceeds policy limits or repeats identifiers",
		);
	if (
		!input.items.length &&
		!(input.stage === "input" && prepared.policy.allow_empty_input)
	)
		throw moderationError("INVALID_CONTENT", "Moderation content is required");
	await bounded(
		runtime.options.boundary_timeout_ms,
		() =>
			runtime.options.validateContent(
				input.context,
				input.items,
				input.content_revision,
				input.context_digest,
			),
		signal,
	);
	const restricted = await bounded(
		prepared.policy.limits.detector_timeout_ms,
		(inner) =>
			runtime.options.resolveRestrictedSignal(
				input.context,
				input.items,
				inner,
			),
		signal,
	).catch(() => null);
	if (
		!restricted ||
		!["none", "suspected", "confirmed"].includes(restricted.status)
	)
		return incomplete(
			input,
			prepared,
			"review",
			null,
			"RESTRICTED_SIGNAL_UNAVAILABLE",
			"error",
		);
	if (restricted.status !== "none") {
		const held = await incomplete(
			input,
			prepared,
			"legal_hold",
			null,
			"RESTRICTED_HANDOFF",
			"partial",
		);
		let case_ref: string | null = null;
		try {
			if (runtime.options.handoffRestricted) {
				const receipt = await bounded(
					prepared.policy.limits.detector_timeout_ms,
					(inner) =>
						runtime.options.handoffRestricted!({
							context: input.context,
							items: input.items,
							idempotency_key: input.idempotency_key,
							evidence_ref: restricted.evidence_ref,
							signal: inner,
						}),
					signal,
				);
				if (
					typeof receipt.case_ref !== "string" ||
					!receipt.case_ref.length ||
					receipt.case_ref.length > 256
				)
					throw new Error("Invalid handoff receipt");
				case_ref = receipt.case_ref;
				held.report.execution = "completed";
			}
		} catch {
			held.report.execution = "error";
		}
		await runtime.options.storage.transaction(input.context.tenant_id, (tx) =>
			runtime.event(
				tx,
				input.context,
				`restricted:${reservation.command.id}`,
				case_ref ? "restricted_handoff" : "restricted_handoff_failed",
				{
					case_ref,
					reason_code: case_ref
						? "RESTRICTED_TRANSFERRED"
						: "RESTRICTED_TRANSFER_PENDING",
				},
				input.attempt_id,
			),
		);
		return held;
	}
	if (
		"attempt_kind" in input &&
		input.stage === "output" &&
		reservation.state?.data.provider_status !== "succeeded"
	)
		return incomplete(
			input,
			prepared,
			"review",
			null,
			"PROVIDER_NOT_SUCCEEDED",
		);
	const rules =
		"layers" in input
			? prepared.policy.rules.filter(
					(rule) =>
						input.layers.includes(rule.layer) &&
						input.categories.includes(rule.category),
				)
			: prepared.policy.rules;
	const result = await runChecks({
		items: input.items,
		rules: rules.filter((rule) => rule.stages.includes(input.stage)),
		detectors: runtime.options.detectors,
		controls: prepared.controls,
		timeout_ms: prepared.policy.limits.detector_timeout_ms,
		signal,
	});
	const base = await incomplete(
		input,
		prepared,
		result.decision,
		result.block_level,
		"",
		result.execution,
	);
	base.report.findings = result.findings;
	base.report.check_coverage = result.check_coverage;
	base.would_decision = result.would_decision;
	base.would_block_level = result.would_block_level;
	if ("categories" in input)
		for (const category of input.categories) {
			if (
				rules.some(
					(rule) =>
						rule.category === category && rule.stages.includes(input.stage),
				)
			)
				continue;
			for (const item of input.items)
				base.report.check_coverage.push({
					requested_check_id: await digest([
						item.item_id,
						item.revision,
						category,
					]),
					item_id: item.item_id,
					modality: item.modality,
					category,
					minimum_scope: "unconfigured",
					required: true,
					mode: "enforce",
					coverage: "unsupported",
					finding_ids: [],
					reason_code: "POLICY_CHECK_UNCONFIGURED",
				});
			if (rank(base.report.decision, base.report.block_level) < 1)
				base.report.decision = "review";
		}
	// A baseline must cover every submitted item, even when no rule matches its modality.
	if (
		input.items.some(
			(item) =>
				!base.report.check_coverage.some(
					(check) =>
						check.item_id === item.item_id &&
						check.required &&
						check.mode === "enforce",
				),
		)
	) {
		if (rank(base.report.decision, base.report.block_level) < 1)
			base.report.decision = "review";
	}
	return base;
}
