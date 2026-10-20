import { bounded, digest, moderationError, rank } from "./primitives";
import type {
	BlockLevel,
	CheckCoverage,
	ContentItem,
	Controls,
	Decision,
	DetectorFinding,
	Finding,
	ModerationDetector,
	PolicyRule,
	RequestedCheck,
} from "./types";

/** Shared logical identity also applies to skipped and failed preflight checks. */
export function requestedCheckId(item: ContentItem, rule: PolicyRule) {
	return digest({
		item_id: item.item_id,
		revision: item.revision,
		field: item.field,
		modality: item.modality,
		rule_id: rule.id,
		category: rule.category,
		minimum_scope: rule.minimum_scope,
	});
}

/** Execute exact-scope checks, retaining failed primary evidence after recovery. */
export async function runChecks(input: {
	items: ContentItem[];
	rules: PolicyRule[];
	detectors: ModerationDetector[];
	controls: Controls;
	timeout_ms: number;
	signal?: AbortSignal;
}) {
	const states = await Promise.all(
		input.items.flatMap((item) =>
			input.rules
				.filter((rule) => rule.modalities.includes(item.modality))
				.map(async (rule) => ({
					check: {
						item,
						rule,
						requested_check_id: await requestedCheckId(item, rule),
					},
					findings: [] as Finding[],
					candidates: rule.detector_ids
						.flatMap((id) => {
							const detector = input.detectors.find(
								(candidate) => candidate.id === id,
							);
							return detector &&
								!input.controls.disabled_detectors.includes(id) &&
								detector.layer === rule.layer &&
								detector.capabilities.some(
									(capability) =>
										capability.modality === item.modality &&
										capability.category === rule.category &&
										capability.inspection_scope === rule.minimum_scope,
								)
								? [detector]
								: [];
						})
						.filter(() => !input.controls.block_all),
				})),
		),
	);
	for (
		let attempt = 0;
		attempt < Math.max(0, ...states.map((state) => state.candidates.length));
		attempt++
	) {
		const groups = new Map<ModerationDetector, typeof states>();
		for (const state of states) {
			const detector = state.candidates[attempt];
			if (
				!detector ||
				state.findings.some((finding) => finding.coverage === "checked")
			)
				continue;
			groups.set(detector, [...(groups.get(detector) ?? []), state]);
		}
		await Promise.all(
			[...groups].map(async ([detector, group]) => {
				let results: DetectorFinding[];
				let received = false;
				try {
					results = await bounded(
						input.timeout_ms,
						(signal) =>
							detector.check({
								items: [
									...new Map(
										group.map(({ check }) => [check.item.item_id, check.item]),
									).values(),
								],
								requested_checks: group.map(({ check }) => check),
								signal,
							}),
						input.signal,
					);
					validateResults(
						results,
						group.map(({ check }) => check),
					);
					received = true;
				} catch {
					results = group.map(({ check }) => ({
						requested_check_id: check.requested_check_id,
						coverage: "failed",
						flagged: false,
						score: null,
						reason_code: "DETECTOR_FAILED",
					}));
				}
				for (const state of group) {
					const result = results.find(
						(entry) =>
							entry.requested_check_id === state.check.requested_check_id,
					)!;
					state.findings.push(
						await toFinding(state.check, result, detector, received),
					);
				}
			}),
		);
	}
	for (const state of states)
		if (!state.findings.length)
			state.findings.push(
				await toFinding(
					state.check,
					{
						requested_check_id: state.check.requested_check_id,
						coverage: input.controls.block_all ? "skipped" : "unsupported",
						flagged: false,
						score: null,
						reason_code: input.controls.block_all
							? "BLOCK_ALL"
							: "DETECTOR_UNSUPPORTED",
					},
					null,
				),
			);
	const findings = states.flatMap((state) => state.findings);
	const check_coverage: CheckCoverage[] = states.map(
		({ check, findings: attempts }) => {
			const final =
				attempts.find((finding) => finding.coverage === "checked") ??
				attempts.find((finding) => finding.coverage === "failed") ??
				attempts[attempts.length - 1]!;
			return {
				requested_check_id: check.requested_check_id,
				item_id: check.item.item_id,
				category: check.rule.category,
				modality: check.item.modality,
				minimum_scope: check.rule.minimum_scope,
				mode: check.rule.mode,
				required: check.rule.required,
				coverage: final.coverage,
				finding_ids: attempts.map((finding) => finding.finding_id),
				reason_code: final.reason_code,
			};
		},
	);
	function aggregate(includeShadow: boolean): {
		decision: Decision;
		block_level: BlockLevel;
	} {
		let decision: Decision = input.controls.block_all ? "block" : "allow";
		let block_level: BlockLevel = input.controls.block_all ? "hard" : null;
		for (const state of states) {
			if (!includeShadow && state.check.rule.mode === "shadow") continue;
			const coverage = check_coverage.find(
				(check) => check.requested_check_id === state.check.requested_check_id,
			)!;
			if (
				state.check.rule.required &&
				coverage.coverage !== "checked" &&
				rank(decision, block_level) < 1
			)
				decision = "review";
			for (const finding of state.findings)
				if (
					finding.decision &&
					rank(finding.decision, finding.block_level) >
						rank(decision, block_level)
				) {
					decision = finding.decision;
					block_level = finding.block_level;
				}
		}
		return { decision, block_level };
	}
	const actual = aggregate(false),
		would = aggregate(true);
	const unresolved = check_coverage.filter(
		(check) => check.coverage !== "checked",
	);
	const execution: "completed" | "partial" | "error" =
		unresolved.length === 0
			? "completed"
			: check_coverage.some((check) => check.coverage === "checked")
				? "partial"
				: "error";
	return {
		findings,
		check_coverage,
		...actual,
		execution,
		would_decision: would.decision,
		would_block_level: would.block_level,
	};
}

function validateResults(results: DetectorFinding[], checks: RequestedCheck[]) {
	if (
		!Array.isArray(results) ||
		results.length !== checks.length ||
		new Set(results.map((entry) => entry?.requested_check_id)).size !==
			checks.length
	)
		throw moderationError(
			"INVALID_DETECTOR_RESULT",
			"Detector returned invalid results",
		);
	for (const result of results) {
		if (
			!result ||
			!checks.some(
				(check) => check.requested_check_id === result.requested_check_id,
			) ||
			!["checked", "unsupported", "missing", "skipped", "failed"].includes(
				result.coverage,
			) ||
			typeof result.flagged !== "boolean" ||
			(result.score !== null &&
				(typeof result.score !== "number" ||
					!Number.isFinite(result.score) ||
					result.score < 0 ||
					result.score > 1)) ||
			typeof result.reason_code !== "string" ||
			!result.reason_code ||
			[
				result.provider_model,
				result.provider_request_id,
				result.native_category,
			].some((entry) => entry !== undefined && typeof entry !== "string")
		)
			throw moderationError(
				"INVALID_DETECTOR_RESULT",
				"Detector returned invalid results",
			);
	}
}

async function toFinding(
	check: RequestedCheck,
	result: DetectorFinding,
	detector: ModerationDetector | null,
	received = true,
): Promise<Finding> {
	const blocked =
		result.flagged ||
		(check.rule.threshold !== null &&
			result.score !== null &&
			result.score >= check.rule.threshold);
	return {
		finding_id: await digest({
			check: check.requested_check_id,
			detector: detector?.id ?? null,
			version: detector?.version ?? null,
		}),
		requested_check_id: check.requested_check_id,
		item_id: check.item.item_id,
		modality: check.item.modality,
		category: check.rule.category,
		inspection_scope: check.rule.minimum_scope,
		coverage: result.coverage,
		mode: check.rule.mode,
		decision: blocked
			? "block"
			: result.coverage === "checked"
				? "allow"
				: null,
		block_level: blocked ? check.rule.block_level : null,
		detector_id: detector?.id ?? null,
		detector_version: detector?.version ?? null,
		provider_model: result.provider_model ?? null,
		provider_request_id: result.provider_request_id ?? null,
		native_category: result.native_category ?? null,
		native_flagged: detector && received ? result.flagged : null,
		score: result.score,
		threshold: check.rule.threshold,
		rule_id: check.rule.id,
		reason_code: result.reason_code,
		...(result.media_evidence ? { media_evidence: result.media_evidence } : {}),
	};
}
