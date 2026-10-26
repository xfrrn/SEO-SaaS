import * as z from "zod";
import type {
	DetectorFinding,
	ProviderModerationEvidence,
	RequestedCheck,
} from "../types";
import type { SeeAPIInference } from "./seeapi-http";

export const seeAPITextCategories: Record<string, string[]> = {
	sexual: ["sexual_explicit", "sexual_suggestive"],
	"sexual/minors": ["sexual_minors"],
	violence: ["violence"],
	hate: ["hate"],
	harassment: ["harassment"],
	"self-harm": ["self_harm"],
};
const labels = z.array(z.string().min(1).max(128)).max(64);
const resultSchema = z.object({
	type: z.literal("json"),
	data: z.object({ flagged: z.boolean() }).passthrough(),
});
const textSchema = z.object({
	flagged: z.boolean(),
	threshold: z.number().min(0.01).max(0.99),
	categories: z.record(z.string(), z.unknown()),
});
const imageSchema = z.object({
	flagged: z.boolean(),
	categories: z.record(z.string(), z.unknown()),
});
const frameSchema = z.object({
	frame_number: z.number().int().positive(),
	timestamp_seconds: z.number().min(0).max(30),
	nsfw_detected: z.boolean(),
	nsfw: labels,
	special: labels.optional(),
});
const videoSchema = z.object({
	scope: z.literal("sampled_frames"),
	report_schema_version: z.literal(5),
	sampling_complete: z.boolean(),
	checked_frames: z.number().int().nonnegative().max(32),
	flagged_frame_count: z.number().int().nonnegative().max(32),
	frames: z.array(z.unknown()).max(32),
	nsfw_detected: z.boolean(),
});

/** Map exact native categories, retaining positive evidence even in an incomplete report. */
export function parseSeeAPIResult(
	task: SeeAPIInference,
	checks: RequestedCheck[],
	parameters: Record<string, number | boolean>,
): DetectorFinding[] {
	const { data } = resultSchema.parse(task.result);
	function finding(
		check: RequestedCheck,
		input: Pick<DetectorFinding, "coverage" | "flagged" | "score">,
		native: string[],
		evidence?: ProviderModerationEvidence,
	): DetectorFinding {
		return {
			requested_check_id: check.requested_check_id,
			...input,
			reason_code: input.flagged
				? "SEEAPI_CATEGORY_FLAGGED"
				: input.coverage === "checked"
					? "SEEAPI_CATEGORY_CHECKED"
					: "SEEAPI_COVERAGE_INCOMPLETE",
			provider_model: task.model,
			provider_request_id: task.id,
			native_category: native.join(","),
			provider_evidence: evidence ?? { parameters, labels: native },
		};
	}
	if (task.model === "text-nsfw-filter") {
		const result = textSchema.parse(data);
		const categorySchema = z.object({
			score: z.number().min(0).max(1),
			flagged: z.boolean(),
		});
		const parsed = Object.fromEntries(
			Object.entries(result.categories).map(([name, category]) => [
				name,
				categorySchema.safeParse(category),
			]),
		);
		const coherent =
			result.flagged ===
			Object.values(parsed).some(
				(category) => category.success && category.data.flagged,
			);
		return checks.map((check) => {
			const native = seeAPITextCategories[check.rule.category]!;
			const categories = native.map((name) => parsed[name]);
			const complete =
				coherent &&
				result.threshold === parameters.threshold &&
				categories.every((category) => category?.success);
			const flagged = native.filter((name) => {
				const flag = z
					.object({ flagged: z.literal(true) })
					.safeParse(result.categories[name]);
				return flag.success;
			});
			return finding(
				check,
				{
					coverage: complete ? "checked" : "missing",
					flagged: flagged.length > 0,
					score: complete
						? Math.max(
								...categories.map((category) =>
									category?.success ? category.data.score : 0,
								),
							)
						: null,
				},
				native,
				{
					parameters: { ...parameters, threshold: result.threshold },
					labels: flagged,
				},
			);
		});
	}
	if (task.model === "nsfw-filter-2") {
		const result = imageSchema.parse(data);
		function category(value: unknown, allowed: string[]) {
			const raw = z.array(z.unknown()).max(64).safeParse(value);
			const native = raw.success
				? raw.data.filter(
						(label): label is string =>
							typeof label === "string" && allowed.includes(label),
					)
				: [];
			return {
				complete: raw.success && native.length === raw.data.length,
				labels: native,
			};
		}
		const nsfw = category(result.categories.nsfw, [
			"nudity",
			"sexual_activity",
			"sexual_suggestive",
		]);
		const special = category(result.categories.special_care, ["sexual_minors"]);
		const coherent =
			result.flagged === !!(nsfw.labels.length || special.labels.length);
		return checks.map((check) => {
			const parsed = check.rule.category === "sexual" ? nsfw : special;
			const native = parsed.labels;
			return finding(
				check,
				{
					coverage: parsed.complete && coherent ? "checked" : "missing",
					flagged: native.length > 0,
					score: null,
				},
				native,
			);
		});
	}
	if (
		data.output === null &&
		data.reason === "content_policy_blocked" &&
		data.flagged
	) {
		return checks.map((check) =>
			finding(
				check,
				{
					coverage: "missing",
					flagged: check.rule.category === "sexual",
					score: null,
				},
				["content_policy_blocked"],
			),
		);
	}
	const report = videoSchema.parse(data.output);
	const frames = report.frames.flatMap((frame) => {
		const parsed = frameSchema.safeParse(frame);
		return parsed.success ? [parsed.data] : [];
	});
	const consistent =
		report.nsfw_detected === data.flagged &&
		data.flagged === frames.some((frame) => frame.nsfw_detected) &&
		frames.every(
			(frame) =>
				frame.nsfw_detected === !!(frame.nsfw.length || frame.special?.length),
		) &&
		report.flagged_frame_count ===
			frames.filter((frame) => frame.nsfw_detected).length;
	const complete =
		report.sampling_complete &&
		consistent &&
		frames.length > 0 &&
		frames.length <= Number(parameters.num_frames) &&
		frames.length === report.checked_frames &&
		frames.length === report.frames.length &&
		new Set(frames.map((frame) => frame.frame_number)).size === frames.length &&
		frames.every(
			(frame, index) =>
				!index ||
				frame.timestamp_seconds >= frames[index - 1]!.timestamp_seconds,
		);
	return checks.map((check) => {
		const special = check.rule.category === "sexual/minors";
		const native = [
			...new Set(
				frames.flatMap((frame) =>
					special ? (frame.special ?? []) : frame.nsfw,
				),
			),
		];
		const recognized = native.filter((label) =>
			special ? label === "sexual_minors" : true,
		);
		const covered =
			complete &&
			(!special ||
				frames.every(
					(frame) =>
						frame.special !== undefined &&
						frame.special.every((label) => label === "sexual_minors"),
				));
		return finding(
			check,
			{
				coverage: covered ? "checked" : "missing",
				flagged: recognized.length > 0,
				score: null,
			},
			native,
			{
				parameters,
				labels: native,
				video: {
					scope: report.scope,
					report_schema_version: report.report_schema_version,
					requested_frames: Number(parameters.num_frames),
					checked_frames: report.checked_frames,
					sampling_complete: report.sampling_complete,
					frames,
				},
			},
		);
	});
}
