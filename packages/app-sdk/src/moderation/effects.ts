import type { ModerationRuntime, Prepared } from "./runtime";
import type {
	ConsentDeclaration,
	EnforcementAction,
	EvaluationRequest,
	ModerationDecision,
	ModerationTransaction,
} from "./types";

export async function bindConsents(
	runtime: ModerationRuntime,
	tx: ModerationTransaction,
	input: EvaluationRequest,
): Promise<boolean> {
	const purpose = input.operation === "deliver" ? "publish" : input.operation;
	for (const id of input.consent_ids) {
		const record = await tx.get<
			ConsentDeclaration & {
				verified_purposes: string[] | null;
				verified_expires_at: string | null;
			}
		>("consent", id);
		if (
			!record ||
			record.data.subject_id !== input.context.subject_id ||
			record.data.status !== "verified" ||
			!record.data.purposes.includes(purpose) ||
			!record.data.verified_purposes?.includes(purpose) ||
			Date.parse(record.data.expires_at) <= Date.now() ||
			!record.data.verified_expires_at ||
			Date.parse(record.data.verified_expires_at) <= Date.now()
		)
			return false;
	}
	return true;
}

export async function createActions(
	runtime: ModerationRuntime,
	tx: ModerationTransaction,
	input: EvaluationRequest,
	prepared: Prepared,
	decision: ModerationDecision,
) {
	const actions: {
		rule_id: string;
		type: EnforcementAction["type"];
		parameters: EnforcementAction["parameters"];
	}[] = [];
	for (const finding of decision.findings)
		if (finding.mode === "enforce" && finding.decision === "block") {
			const rule = prepared.policy.rules.find(
				(entry) => entry.id === finding.rule_id,
			);
			const type = rule?.category === "sexual/minors" ? "ban" : rule?.action;
			if (rule && type && !actions.some((action) => action.rule_id === rule.id))
				actions.push({ rule_id: rule.id, type, parameters: {} });
		}
	for (const finding of decision.abuse_findings)
		if (
			finding.mode === "enforce" &&
			finding.effect !== "none" &&
			finding.effect !== "review"
		) {
			const rule = prepared.policy.abuse_rules.find(
				(entry) => entry.id === finding.rule_id,
			);
			if (rule)
				actions.push({
					rule_id: rule.id,
					type: finding.effect,
					parameters: rule.parameters,
				});
		}
	for (const action of actions) {
		const key = `action:${await runtime.opaque(input.context.tenant_id, [input.attempt_id, decision.policy_version, action.rule_id, action.type])}`;
		const previous = await tx.get<EnforcementAction>("action", key);
		if (previous) {
			decision.action_ids.push(previous.data.action_id);
			continue;
		}
		const now = Date.now();
		await tx.insert({
			kind: "action",
			key,
			subject_id: input.context.subject_id,
			attempt_id: input.attempt_id,
			data: {
				action_id: key,
				subject_id: input.context.subject_id,
				attempt_id: input.attempt_id,
				decision_id: decision.decision_id,
				rule_id: action.rule_id,
				type: action.type,
				parameters: action.parameters,
				status: "pending",
				attempts: 0,
				lease_token: null,
				lease_until: null,
				next_attempt_at: new Date(now).toISOString(),
				expires_at: new Date(
					now + prepared.policy.limits.review_ttl_ms,
				).toISOString(),
				reason_code: "ACTION_REQUIRED",
			} satisfies EnforcementAction,
		});
		decision.action_ids.push(key);
	}
}
