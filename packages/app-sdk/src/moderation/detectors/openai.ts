import { moderationError } from "../primitives";
import type {
	ContentItem,
	DetectorFinding,
	ModerationDetector,
	RequestedCheck,
	VideoInspectionManifest,
	VideoInspectionPlan,
} from "../types";

const imageCategories = [
	"sexual",
	"self-harm",
	"self-harm/intent",
	"self-harm/instructions",
	"violence",
	"violence/graphic",
];
const textCategories = [
	...imageCategories,
	"sexual/minors",
	"harassment",
	"harassment/threatening",
	"hate",
	"hate/threatening",
	"illicit",
	"illicit/violent",
];
/** Host extraction evidence; unmet requirements must name every incomplete step. */
export interface ResolvedVideoInspection {
	plan: VideoInspectionPlan;
	manifest: VideoInspectionManifest;
}
/** Credentials and private asset resolution must only be configured on the server. */
export interface OpenAIModerationOptions {
	api_key: string;
	endpoint: string;
	model: "omni-moderation-latest" | "omni-moderation-2024-09-26";
	resolveImage(asset_ref: string, signal: AbortSignal): Promise<string>;
	resolveVideo?: (
		item: ContentItem & { modality: "video" },
		signal: AbortSignal,
	) => Promise<ResolvedVideoInspection>;
}

/** OpenAI native categories only; sampled frames do not claim full-video or CSAM coverage. */
export function createOpenAIModerationDetector(
	options: OpenAIModerationOptions,
): ModerationDetector {
	validateHTTPS(options.endpoint);
	if (
		!options.api_key.trim() ||
		!["omni-moderation-latest", "omni-moderation-2024-09-26"].includes(
			options.model,
		)
	)
		throw moderationError(
			"INVALID_DETECTOR",
			"OpenAI requires credentials and a supported omni model",
		);
	const capabilities: ModerationDetector["capabilities"] = [
		...textCategories.map((category) => ({
			modality: "text" as const,
			category,
			inspection_scope: "text.semantic",
		})),
		...imageCategories.map((category) => ({
			modality: "image" as const,
			category,
			inspection_scope: "image.original",
		})),
		...(options.resolveVideo
			? imageCategories.map((category) => ({
					modality: "video" as const,
					category,
					inspection_scope: "video.sampled_frames",
				}))
			: []),
	];
	return {
		id: "openai-moderation",
		version: "1",
		layer: "safety",
		capabilities,
		async check({ requested_checks, signal }) {
			const output: DetectorFinding[] = [];
			const byItem = new Map<string, RequestedCheck[]>();
			for (const check of requested_checks)
				byItem.set(check.item.item_id, [
					...(byItem.get(check.item.item_id) ?? []),
					check,
				]);
			for (const checks of byItem.values()) {
				signal.throwIfAborted();
				const item = checks[0]!.item;
				const supported = checks.filter((check) =>
					capabilities.some(
						(capability) =>
							capability.modality === item.modality &&
							capability.category === check.rule.category &&
							capability.inspection_scope === check.rule.minimum_scope,
					),
				);
				for (const check of checks.filter(
					(check) => !supported.includes(check),
				))
					output.push(empty(check, "unsupported", "DETECTOR_UNSUPPORTED"));
				if (!supported.length) continue;
				try {
					if (item.modality === "video")
						output.push(
							...(await inspectVideo(
								{ ...item, modality: "video" },
								supported,
								options,
								signal,
							)),
						);
					else if (item.modality === "text" || item.modality === "image") {
						const media =
							item.modality === "text"
								? item.text
								: await imageURL(options, item.asset_ref, signal);
						output.push(
							...(await inspect(
								media,
								item.modality,
								supported,
								options,
								signal,
							)),
						);
					}
				} catch {
					output.push(
						...supported.map((check) =>
							empty(check, "failed", "OPENAI_FAILED"),
						),
					);
				}
			}
			return output;
		},
	};
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw moderationError(
			"INVALID_PROVIDER_RESULT",
			"OpenAI returned invalid moderation data",
		);
	return value as Record<string, unknown>;
}

function validateHTTPS(value: string) {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw moderationError(
			"INVALID_DETECTOR_URL",
			"Moderation URL must be HTTPS",
		);
	}
	if (url.protocol !== "https:" || url.username || url.password || url.hash)
		throw moderationError(
			"INVALID_DETECTOR_URL",
			"Moderation URL must be HTTPS without credentials or fragments",
		);
}

async function imageURL(
	options: OpenAIModerationOptions,
	asset_ref: string,
	signal: AbortSignal,
) {
	const url = await options.resolveImage(asset_ref, signal);
	if (typeof url !== "string")
		throw moderationError(
			"INVALID_MEDIA",
			"Image resolver returned invalid media",
		);
	if (url.startsWith("data:")) {
		if (
			!/^data:image\/(png|jpeg|webp|gif);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
				url,
			) ||
			!url.split(",")[1]
		)
			throw moderationError(
				"INVALID_MEDIA",
				"Image resolver requires an image base64 data URL",
			);
	} else validateHTTPS(url);
	return url;
}

function empty(
	check: RequestedCheck,
	coverage: DetectorFinding["coverage"],
	reason_code: string,
): DetectorFinding {
	return {
		requested_check_id: check.requested_check_id,
		coverage,
		flagged: false,
		score: null,
		reason_code,
	};
}

async function inspect(
	media: string,
	modality: "text" | "image",
	checks: RequestedCheck[],
	options: OpenAIModerationOptions,
	signal: AbortSignal,
): Promise<DetectorFinding[]> {
	const response = await fetch(options.endpoint, {
		method: "POST",
		redirect: "error",
		signal,
		headers: {
			authorization: `Bearer ${options.api_key}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model: options.model,
			input:
				modality === "text"
					? media
					: [{ type: "image_url", image_url: { url: media } }],
		}),
	});
	if (!response.ok)
		throw moderationError(
			"PROVIDER_UNAVAILABLE",
			"OpenAI moderation request failed",
		);
	const body = object(await response.json());
	if (
		typeof body.model !== "string" ||
		!body.model ||
		!Array.isArray(body.results) ||
		body.results.length !== 1
	)
		throw moderationError(
			"INVALID_PROVIDER_RESULT",
			"OpenAI returned invalid moderation data",
		);
	const result = object(body.results[0]),
		categories = object(result.categories),
		scores = object(result.category_scores),
		applied = object(result.category_applied_input_types);
	if (typeof result.flagged !== "boolean")
		throw moderationError(
			"INVALID_PROVIDER_RESULT",
			"OpenAI returned invalid moderation data",
		);
	return checks.map((check) => {
		const category = check.rule.category,
			score = scores[category],
			flag = categories[category],
			types = applied[category];
		if (
			typeof flag !== "boolean" ||
			typeof score !== "number" ||
			!Number.isFinite(score) ||
			score < 0 ||
			score > 1 ||
			!Array.isArray(types) ||
			types.some((type) => type !== "text" && type !== "image")
		)
			return empty(check, "failed", "OPENAI_CATEGORY_INVALID");
		if (!types.includes(modality))
			return empty(check, "unsupported", "OPENAI_MODALITY_UNSUPPORTED");
		return {
			requested_check_id: check.requested_check_id,
			coverage: "checked",
			flagged: flag,
			score,
			reason_code: flag ? "OPENAI_CATEGORY_FLAGGED" : "OPENAI_CATEGORY_SCORED",
			provider_model: body.model as string,
			provider_request_id:
				response.headers.get("x-request-id") ??
				(typeof body.id === "string" ? body.id : undefined),
			native_category: category,
		};
	});
}

async function inspectVideo(
	item: ContentItem & { modality: "video" },
	checks: RequestedCheck[],
	options: OpenAIModerationOptions,
	signal: AbortSignal,
): Promise<DetectorFinding[]> {
	if (!options.resolveVideo)
		return checks.map((check) =>
			empty(check, "unsupported", "VIDEO_EXTRACTOR_UNAVAILABLE"),
		);
	const { plan, manifest } = await options.resolveVideo(item, signal);
	const valid = validManifest(plan, manifest, item.revision);
	if (!valid)
		return checks.map((check) =>
			empty(check, "failed", "VIDEO_MANIFEST_INVALID"),
		);
	if (manifest.unmet_requirements.length || plan.include_audio)
		return checks.map((check) => ({
			...empty(
				check,
				"missing",
				plan.include_audio
					? "VIDEO_AUDIO_UNSUPPORTED"
					: "VIDEO_EXTRACTION_INCOMPLETE",
			),
			media_evidence: { video_plan: plan, video_manifest: manifest },
		}));
	const frames: DetectorFinding[][] = [];
	for (const frame of manifest.frames) {
		signal.throwIfAborted();
		try {
			frames.push(
				await inspect(
					await imageURL(options, frame.asset_ref, signal),
					"image",
					checks,
					options,
					signal,
				),
			);
		} catch {
			frames.push(
				checks.map((check) => empty(check, "failed", "OPENAI_FRAME_FAILED")),
			);
		}
		// Return known hits before another provider call can hang and lose the evidence.
		if (
			frames[frames.length - 1]!.some((finding) =>
				checks.some(
					(check) =>
						check.requested_check_id === finding.requested_check_id &&
						check.rule.mode === "enforce" &&
						(finding.flagged ||
							(finding.score !== null &&
								check.rule.threshold !== null &&
								finding.score >= check.rule.threshold)),
				),
			)
		)
			break;
	}
	return checks.map((check) => {
		const attempts = frames.map(
			(frame) =>
				frame.find(
					(finding) => finding.requested_check_id === check.requested_check_id,
				)!,
		);
		const flagged = attempts.find((finding) => finding.flagged);
		// A failing frame cannot erase a real category hit, but cannot count as full coverage.
		const incomplete =
			frames.length !== manifest.frames.length ||
			attempts.some((finding) => finding.coverage !== "checked");
		const highest = attempts.reduce((best, finding) =>
			(finding.score ?? -1) > (best.score ?? -1) ? finding : best,
		);
		return {
			...highest,
			coverage: incomplete ? "failed" : "checked",
			flagged: Boolean(flagged),
			reason_code: incomplete
				? "VIDEO_FRAME_INCOMPLETE"
				: "VIDEO_FRAMES_CHECKED",
			media_evidence: { video_plan: plan, video_manifest: manifest },
		};
	});
}

function validManifest(
	plan: VideoInspectionPlan,
	manifest: VideoInspectionManifest,
	revision: string,
) {
	if (
		!plan ||
		!manifest ||
		typeof plan.version !== "string" ||
		!plan.version ||
		typeof manifest.extractor_version !== "string" ||
		!manifest.extractor_version ||
		manifest.plan_version !== plan.version ||
		manifest.asset_revision !== revision ||
		[
			plan.include_first_frame,
			plan.include_last_frame,
			plan.include_audio,
			plan.sample_scene_changes,
		].some((flag) => typeof flag !== "boolean") ||
		!Number.isFinite(plan.frames_per_second) ||
		plan.frames_per_second <= 0 ||
		!Number.isFinite(plan.max_duration_ms) ||
		plan.max_duration_ms <= 0 ||
		!Number.isInteger(plan.max_frames) ||
		plan.max_frames < 1 ||
		!Number.isFinite(manifest.actual_duration_ms) ||
		manifest.actual_duration_ms <= 0 ||
		manifest.actual_duration_ms > plan.max_duration_ms ||
		!Array.isArray(manifest.frames) ||
		!manifest.frames.length ||
		manifest.frames.length > plan.max_frames ||
		!Array.isArray(manifest.unmet_requirements) ||
		manifest.unmet_requirements.some((entry) => typeof entry !== "string") ||
		!manifest.audio ||
		![
			"checked",
			"unsupported",
			"missing",
			"skipped",
			"failed",
			"not_applicable",
		].includes(manifest.audio.status) ||
		(manifest.audio.transcript_ref !== null &&
			typeof manifest.audio.transcript_ref !== "string")
	)
		return false;
	const times = manifest.frames.map((frame) => frame.timestamp_ms),
		gap = 1000 / plan.frames_per_second;
	if (
		manifest.frames.some(
			(frame, index) =>
				typeof frame.asset_ref !== "string" ||
				!frame.asset_ref ||
				!Number.isFinite(frame.timestamp_ms) ||
				frame.timestamp_ms < 0 ||
				frame.timestamp_ms > manifest.actual_duration_ms ||
				(index > 0 && frame.timestamp_ms <= times[index - 1]!),
		)
	)
		return false;
	if (plan.include_first_frame && times[0] !== 0) return false;
	if (
		plan.include_last_frame &&
		times[times.length - 1]! < manifest.actual_duration_ms - gap
	)
		return false;
	return (
		times.every((time, index) =>
			index === 0 ? time <= gap : time - times[index - 1]! <= gap,
		) && manifest.actual_duration_ms - times[times.length - 1]! <= gap
	);
}
