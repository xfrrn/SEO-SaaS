import * as z from "zod";
import {
	checkProjection,
	eventProjection,
	summarize,
} from "./evidence-projection";
import { timestamp, trustedContext } from "./lifecycle-validation";
import { moderationError } from "./primitives";
import type { ModerationRuntime } from "./runtime";
import type {
	AttemptState,
	CheckReport,
	EnforcementAction,
	ModerationDecision,
	ModerationTransaction,
	RecordKind,
	StoredRecord,
} from "./types";

const publicSchema = z.object({ context: trustedContext }).strict();
const exportSchema = z
	.object({ context: trustedContext, from: timestamp, to: timestamp })
	.strict();
export type PublicPolicyRequest = z.infer<typeof publicSchema>;
export type ExportEvidenceRequest = z.infer<typeof exportSchema>;

export function createModerationEvidence(runtime: ModerationRuntime) {
	async function getPublicPolicy(request: PublicPolicyRequest) {
		const input = publicSchema.parse(request);
		const { policy } = await runtime.prepare(input.context, "capabilities");
		const categories = new Map<string, Set<string>>();
		for (const rule of policy.rules) {
			const descriptions = categories.get(rule.category) ?? new Set<string>();
			descriptions.add(rule.public_description);
			categories.set(rule.category, descriptions);
		}
		return {
			policy_version: policy.version,
			platform_version: policy.platform_version,
			tenant_version: policy.tenant_version,
			categories: [...categories].map(([category, descriptions]) => ({
				category,
				descriptions: [...descriptions],
			})),
		};
	}

	async function exportEvidence(request: ExportEvidenceRequest) {
		const input = exportSchema.parse(request);
		const prepared = await runtime.prepare(input.context, "export");
		const from = new Date(input.from).toISOString();
		const to = new Date(input.to).toISOString();
		if (
			Date.parse(from) >= Date.parse(to) ||
			Date.parse(to) > Date.now() ||
			Date.parse(to) - Date.parse(from) > prepared.policy.limits.retention_ms
		) {
			throw moderationError(
				"INVALID_WINDOW",
				"Evidence export requires a bounded past time window",
			);
		}
		return runtime.options.storage.transaction(
			input.context.tenant_id,
			async (tx) => {
				const cutoff = new Date().toISOString();
				await runtime.snapshots(tx, prepared);
				const audit_id = crypto.randomUUID();
				const records: StoredRecord[] = [];
				for (const kind of [
					"attempt",
					"report",
					"decision",
					"event",
					"action",
				] as const) {
					await collect(
						tx,
						kind,
						from,
						to,
						records,
						prepared.policy.limits.max_export_records,
					);
				}
				const included = new Set(
					records.map((record) => `${record.kind}:${record.key}`),
				);
				function include(record: StoredRecord | null) {
					if (!record || included.has(`${record.kind}:${record.key}`)) return;
					included.add(`${record.kind}:${record.key}`);
					records.push(record);
					if (records.length > prepared.policy.limits.max_export_records)
						throw moderationError(
							"EXPORT_LIMIT_EXCEEDED",
							"Split the evidence export window",
						);
				}
				for (const attempt_id of new Set(
					records
						.map((record) => record.attempt_id)
						.filter((id): id is string => id !== null),
				)) {
					const attempt = await tx.get<AttemptState>("attempt", attempt_id);
					include(attempt as StoredRecord | null);
					let eventCursor: string | undefined;
					for (;;) {
						const eventPage = await tx.list<Record<string, unknown>>("event", {
							attempt_id,
							before: new Date(Date.parse(cutoff) + 1).toISOString(),
							...(eventCursor ? { after: eventCursor } : {}),
							limit: Math.min(
								1000,
								prepared.policy.limits.max_export_records + 1,
							),
						});
						for (const event of eventPage) include(event);
						if (
							eventPage.length <
							Math.min(1000, prepared.policy.limits.max_export_records + 1)
						)
							break;
						eventCursor = eventPage[eventPage.length - 1]!.key;
					}
					for (const stage of Object.values(attempt?.data.stages ?? {})) {
						let decision_id: string | null = stage?.decision_id ?? null;
						const visited = new Set<string>();
						while (decision_id && !visited.has(decision_id)) {
							visited.add(decision_id);
							const decision: StoredRecord<ModerationDecision> | null =
								await tx.get<ModerationDecision>("decision", decision_id);
							include(decision as StoredRecord | null);
							decision_id = decision?.data.supersedes_decision_id ?? null;
						}
					}
				}
				const restricted = new Map<string, boolean>();
				async function isRestricted(attempt_id: string | null) {
					if (!attempt_id) return false;
					if (restricted.has(attempt_id)) return restricted.get(attempt_id)!;
					const attempt = await tx.get<AttemptState>("attempt", attempt_id);
					let value = false;
					for (const stage of Object.values(attempt?.data.stages ?? {})) {
						if (
							stage &&
							(await tx.get<ModerationDecision>("decision", stage.decision_id))
								?.data.decision === "legal_hold"
						)
							value = true;
					}
					restricted.set(attempt_id, value);
					return value;
				}
				const projections: object[] = [];
				const attempts: AttemptState[] = [];
				const decisions: ModerationDecision[] = [];
				const reports: CheckReport[] = [];
				const deliveries: {
					attempt_id: string | null;
					status: string;
					occurred_at: string;
				}[] = [];
				const policyVersions = new Set<string>([prepared.policy.version]);
				const capabilities = new Set<string>([prepared.capability_snapshot_id]);
				let restricted_excluded = 0;
				for (const record of records) {
					if (
						(await isRestricted(record.attempt_id)) ||
						record.data.decision === "legal_hold"
					) {
						restricted_excluded++;
						continue;
					}
					if (record.kind === "attempt") {
						const attempt = record.data as unknown as AttemptState;
						attempts.push(attempt);
						projections.push({
							type: "attempt",
							attempt_id: attempt.attempt_id,
							kind: attempt.kind,
							original_outcome: attempt.outcome,
							provider_status: attempt.provider_status,
							revoked: attempt.revoked,
							created_at: attempt.created_at,
						});
					} else if (record.kind === "decision" || record.kind === "report") {
						const check = record.data as unknown as
							| ModerationDecision
							| CheckReport;
						policyVersions.add(check.policy_version);
						capabilities.add(check.capability_snapshot_id);
						const base = checkProjection(check);
						if ("decision_id" in check) {
							decisions.push(check);
							const attempt = await tx.get<AttemptState>(
								"attempt",
								check.attempt_id,
							);
							projections.push({
								type: "decision",
								...base,
								decision_id: check.decision_id,
								attempt_id: check.attempt_id,
								current:
									attempt?.data.stages[check.stage]?.decision_id ===
									check.decision_id,
								enforcement: check.enforcement,
								mode: check.mode,
								would_decision: check.would_decision,
								supersedes_decision_id: check.supersedes_decision_id,
							});
						} else {
							reports.push(check);
							projections.push({
								type: "report",
								...base,
								report_id: check.report_id,
							});
						}
					} else if (record.kind === "action") {
						const action = record.data as unknown as EnforcementAction;
						projections.push({
							type: "action",
							action_id: action.action_id,
							attempt_id: action.attempt_id,
							decision_id: action.decision_id,
							action_type: action.type,
							status: action.status,
							attempts: action.attempts,
							reason_code: action.reason_code,
						});
					} else {
						const projection = eventProjection(record);
						if (projection) projections.push(projection);
						if (
							record.data.type === "delivery" &&
							typeof record.data.status === "string"
						)
							deliveries.push({
								attempt_id: record.attempt_id,
								status: record.data.status,
								occurred_at:
									typeof record.data.observed_at === "string"
										? record.data.observed_at
										: record.created_at,
							});
					}
				}
				for (const version of policyVersions) {
					const record = await tx.get<{
						version: string;
						platform_version: string;
						tenant_version: string;
						rules: { category: string; public_description: string }[];
					}>("policy", version);
					if (record)
						projections.push({
							type: "policy",
							policy_version: version,
							platform_version: record.data.platform_version,
							tenant_version: record.data.tenant_version,
							categories: record.data.rules.map((rule) => ({
								category: rule.category,
								description: rule.public_description,
							})),
						});
				}
				for (const id of capabilities) {
					const record = await tx.get<{
						controls: { version: string; disabled_detectors: string[] };
						detectors: {
							id: string;
							version: string;
							layer: string;
							capabilities: object[];
						}[];
					}>("capability", id);
					if (record)
						projections.push({
							type: "capability",
							capability_snapshot_id: id,
							controls_version: record.data.controls.version,
							detectors: record.data.detectors.map((detector) => ({
								...detector,
								enabled: !record.data.controls.disabled_detectors.includes(
									detector.id,
								),
							})),
						});
				}
				if (projections.length > prepared.policy.limits.max_export_records)
					throw moderationError(
						"EXPORT_LIMIT_EXCEEDED",
						"Split the evidence export window",
					);
				const summary = await summarize(
					tx,
					attempts,
					decisions,
					reports,
					deliveries,
				);
				await runtime.event(
					tx,
					input.context,
					`export:${audit_id}`,
					"evidence_export",
					{
						audit_id,
						from,
						to,
						cutoff,
						records: projections.length,
						restricted_excluded,
					},
				);
				return {
					audit_id,
					cutoff,
					from,
					to,
					scope:
						"attempts_with_activity_in_window_and_current_state_at_cutoff" as const,
					restricted_excluded,
					summary,
					jsonl:
						projections
							.map((projection) => JSON.stringify(projection))
							.join("\n") + (projections.length ? "\n" : ""),
				};
			},
		);
	}
	return { getPublicPolicy, exportEvidence };
}

async function collect(
	tx: ModerationTransaction,
	kind: RecordKind,
	from: string,
	to: string,
	records: StoredRecord[],
	maximum: number,
) {
	let after: string | undefined;
	for (;;) {
		const page = await tx.list<Record<string, unknown>>(kind, {
			since: from,
			before: to,
			...(after ? { after } : {}),
			limit: Math.min(1000, maximum + 1),
		});
		for (const record of page) {
			if (record.created_at >= from) records.push(record);
			if (records.length > maximum)
				throw moderationError(
					"EXPORT_LIMIT_EXCEEDED",
					"Split the evidence export window",
				);
		}
		if (page.length < Math.min(1000, maximum + 1)) break;
		after = page[page.length - 1]!.key;
	}
}
