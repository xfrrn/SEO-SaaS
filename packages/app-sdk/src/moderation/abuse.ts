import { bounded } from "./primitives";
import type { ModerationRuntime, Prepared } from "./runtime";
import type {
	AbuseFinding,
	CheckReport,
	EvaluationRequest,
	ModerationTransaction,
	ResolvedAbuseContext,
} from "./types";

/** Count logical events once, independently of the number of detector attempts. */
export async function assessAbuse(
	runtime: ModerationRuntime,
	tx: ModerationTransaction,
	input: EvaluationRequest,
	prepared: Prepared,
	report: CheckReport,
	identity: ResolvedAbuseContext,
): Promise<AbuseFinding[]> {
	const now = Date.now();
	const findings: AbuseFinding[] = [];
	for (const rule of prepared.policy.abuse_rules) {
		const value =
			rule.identity === "account"
				? identity.account_ref
				: rule.identity === "ip"
					? identity.ip_digest
					: rule.identity === "device"
						? identity.device_ref
						: identity.payment_ref;
		const window_start = Math.floor(now / rule.window_ms) * rule.window_ms;
		const subject_ref = value
			? await runtime.opaque(input.context.tenant_id, [rule.identity, value])
			: "missing";
		const counterKey = `${rule.id}:${subject_ref}:${window_start}`;
		const stored = await tx.get<{ count: number }>("counter", counterKey);
		let count = stored?.data.count ?? 0;
		const hits = report.check_coverage.filter((check) =>
			report.findings.some(
				(finding) =>
					finding.requested_check_id === check.requested_check_id &&
					(rule.mode === "shadow" || finding.mode === "enforce") &&
					(rule.metric === "repeat_hits"
						? finding.decision === "block"
						: finding.score !== null &&
							rule.edge_score !== null &&
							finding.score >= rule.edge_score),
			),
		);
		const events =
			rule.metric === "requests"
				? [`request:${input.attempt_id}`]
				: hits.map(
						(hit) =>
							`${input.attempt_id}:${input.stage}:${hit.requested_check_id}`,
					);
		if (value)
			for (const key of events) {
				const eventKey = `abuse:${rule.id}:${await runtime.opaque(input.context.tenant_id, key)}`;
				if (await tx.get("event", eventKey)) continue;
				count++;
				await runtime.event(
					tx,
					input.context,
					eventKey,
					"abuse_counted",
					{
						rule_id: rule.id,
						window_start: new Date(window_start).toISOString(),
						mode: rule.mode,
					},
					input.attempt_id,
				);
			}
		if (value) {
			if (stored) await tx.replace(stored, { count });
			else
				await tx.insert({
					kind: "counter",
					key: counterKey,
					subject_id:
						rule.identity === "account" ? input.context.subject_id : null,
					attempt_id: null,
					data: { count },
				});
		}
		findings.push({
			rule_id: rule.id,
			subject_ref,
			window_start: new Date(window_start).toISOString(),
			window_end: new Date(window_start + rule.window_ms).toISOString(),
			coverage: value ? "checked" : "missing",
			observed_count: value ? count : null,
			threshold: rule.threshold,
			effect:
				value && count < rule.threshold
					? "none"
					: value
						? rule.effect
						: "review",
			evidence_event_ids: [],
			mode: rule.mode,
			reason_code: value
				? count >= rule.threshold
					? "ABUSE_THRESHOLD"
					: "ABUSE_CLEAR"
				: "ABUSE_SIGNAL_MISSING",
		});
	}
	return findings;
}

export async function resolveAbuse(
	runtime: ModerationRuntime,
	request: EvaluationRequest,
	prepared: Prepared,
): Promise<ResolvedAbuseContext> {
	return runtime.options.resolveAbuseContext
		? bounded(prepared.policy.limits.detector_timeout_ms, (signal) =>
				runtime.options.resolveAbuseContext!(
					request.context,
					request.attempt_id,
					signal,
				),
			)
		: {
				account_ref: request.context.subject_id,
				ip_digest: null,
				device_ref: null,
				payment_ref: null,
				source_version: "authenticated-account",
				observed_at: new Date().toISOString(),
			};
}
