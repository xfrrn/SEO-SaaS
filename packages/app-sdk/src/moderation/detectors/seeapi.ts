import * as z from "zod";
import { digest } from "../primitives";
import type {
	ContentItem,
	DetectorFinding,
	ModerationDetector,
	RequestedCheck,
} from "../types";
import { httpsURL, seeAPIFailure, seeAPIHTTP } from "./seeapi-http";
import { parseSeeAPIResult, seeAPITextCategories } from "./seeapi-results";

/** Metadata must describe the immutable, ownership-checked asset represented by the URL. */
export interface SeeAPIImage {
	url: string;
	revision: string;
	media_type: "image/png" | "image/jpeg";
	size_bytes: number;
	width: number;
	height: number;
}
export interface SeeAPIVideo {
	url: string;
	revision: string;
	media_type: "video/mp4" | "video/quicktime";
	size_bytes: number;
	duration_ms: number;
}
/** Changing thresholds or input resolution requires a new detector version. */
export interface SeeAPIModerationOptions {
	api_key: string;
	base_url: string;
	version: string;
	id?: string;
	fetch?: typeof globalThis.fetch;
	poll_interval_ms?: number;
	max_response_bytes?: number;
	text_threshold?: number;
	image_threshold?: number;
	video_num_frames?: number;
	video_threshold_offset?: number;
	resolveImage?: (
		item: ContentItem & { modality: "image" },
		signal: AbortSignal,
	) => Promise<SeeAPIImage>;
	resolveVideo?: (
		item: ContentItem & { modality: "video" },
		signal: AbortSignal,
	) => Promise<SeeAPIVideo>;
}
const configuration = z.object({
	version: z.string().min(1).max(256),
	text_threshold: z.number().min(0.01).max(0.99),
	image_threshold: z.number().min(0.01).max(0.99),
	video_num_frames: z.number().int().min(8).max(32),
	video_threshold_offset: z.number().min(0).max(0.1),
});
const imageSchema = z
	.object({
		url: z.string(),
		revision: z.string(),
		media_type: z.enum(["image/png", "image/jpeg"]),
		size_bytes: z.number().int().positive().max(16_777_216),
		width: z.number().int().min(256).max(8192),
		height: z.number().int().min(256).max(8192),
	})
	.refine(
		(asset) =>
			asset.width * asset.height >= 78_400 &&
			asset.width * asset.height <= 32_000_000,
	);
const videoSchema = z.object({
	url: z.string(),
	revision: z.string(),
	media_type: z.enum(["video/mp4", "video/quicktime"]),
	size_bytes: z.number().int().positive().max(100_000_000),
	duration_ms: z.number().positive().max(30_000),
});
function imageURL(asset: SeeAPIImage) {
	if (!asset.url.startsWith("data:")) {
		httpsURL(asset.url);
		return;
	}
	const match =
		/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
			asset.url,
		);
	if (!match || match[1] !== asset.media_type || match[2]!.length % 4 !== 0)
		throw seeAPIFailure("SEEAPI_INVALID_IMAGE");
	const bytes = atob(match[2]!);
	if (bytes.length !== asset.size_bytes)
		throw seeAPIFailure("SEEAPI_INVALID_IMAGE");
}
/** Exact modality/category coverage; SeeAPI frame sampling never claims audio inspection. */
export function createSeeAPIModerationDetector(
	options: SeeAPIModerationOptions,
): ModerationDetector {
	const config = configuration.parse({
		version: options.version,
		text_threshold: options.text_threshold ?? 0.3,
		image_threshold: options.image_threshold ?? 0.5,
		video_num_frames: options.video_num_frames ?? 8,
		video_threshold_offset: options.video_threshold_offset ?? 0.02,
	});
	const infer = seeAPIHTTP({
		...options,
		poll_interval_ms: options.poll_interval_ms ?? 2000,
		max_response_bytes: options.max_response_bytes ?? 1_048_576,
	});
	const capabilities: ModerationDetector["capabilities"] = [
		...Object.keys(seeAPITextCategories).map((category) => ({
			modality: "text" as const,
			category,
			inspection_scope: "text.semantic",
		})),
		...(options.resolveImage
			? ["sexual", "sexual/minors"].map((category) => ({
					modality: "image" as const,
					category,
					inspection_scope: "image.original",
				}))
			: []),
		...(options.resolveVideo
			? ["sexual", "sexual/minors"].map((category) => ({
					modality: "video" as const,
					category,
					inspection_scope: "video.provider_sampled_frames",
				}))
			: []),
	];
	return {
		id: options.id ?? "seeapi-moderation",
		version: options.version,
		layer: "safety",
		capabilities,
		async check({ requested_checks, execution_key, signal }) {
			const results: DetectorFinding[] = [];
			const groups = new Map<string, RequestedCheck[]>();
			for (const check of requested_checks) {
				if (
					!capabilities.some(
						(cap) =>
							cap.modality === check.item.modality &&
							cap.category === check.rule.category &&
							cap.inspection_scope === check.rule.minimum_scope,
					)
				) {
					results.push(empty(check, "unsupported", "SEEAPI_UNSUPPORTED"));
					continue;
				}
				groups.set(check.item.item_id, [
					...(groups.get(check.item.item_id) ?? []),
					check,
				]);
			}
			for (const checks of groups.values()) {
				const item = checks[0]!.item;
				let knownTaskId: string | undefined;
				try {
					if (!execution_key)
						throw seeAPIFailure("SEEAPI_EXECUTION_KEY_REQUIRED");
					signal.throwIfAborted();
					let body: {
						model: string;
						endpoint: string;
						input: Record<string, string | string[] | number | boolean>;
					};
					let parameters: Record<string, number | boolean>;
					if (item.modality === "text") {
						if (!item.text.length || item.text.length > 20_000)
							throw seeAPIFailure("SEEAPI_TEXT_LIMIT");
						parameters = { threshold: config.text_threshold };
						body = {
							model: "text-nsfw-filter",
							endpoint: "text-moderation",
							input: {
								text: item.text,
								...parameters,
								categories: [
									...new Set(
										checks.flatMap(
											(check) => seeAPITextCategories[check.rule.category]!,
										),
									),
								].sort(),
							},
						};
					} else if (item.modality === "image" && options.resolveImage) {
						const asset = imageSchema.parse(
							await options.resolveImage(
								{ ...item, modality: "image" },
								signal,
							),
						);
						if (asset.revision !== item.revision)
							throw seeAPIFailure("SEEAPI_ASSET_REVISION");
						imageURL(asset);
						parameters = {
							threshold: config.image_threshold,
							strict_special_care: true,
						};
						body = {
							model: "nsfw-filter-2",
							endpoint: "image-moderation",
							input: { image_url: asset.url, ...parameters },
						};
					} else if (item.modality === "video" && options.resolveVideo) {
						const asset = videoSchema.parse(
							await options.resolveVideo(
								{ ...item, modality: "video" },
								signal,
							),
						);
						if (asset.revision !== item.revision)
							throw seeAPIFailure("SEEAPI_ASSET_REVISION");
						httpsURL(asset.url);
						parameters = {
							num_frames: config.video_num_frames,
							threshold_offset: config.video_threshold_offset,
							strict_special_care: true,
						};
						body = {
							model: "video-nsfw-filter",
							endpoint: "video-moderation",
							input: {
								video_url: asset.url,
								...parameters,
								return_frames: "none",
							},
						};
					} else throw seeAPIFailure("SEEAPI_UNSUPPORTED");
					// URL signatures may expire; a changed body with this key must conflict, not create another charge.
					const key = await digest({
						execution_key,
						detector: options.id ?? "seeapi-moderation",
						version: config.version,
						item_id: item.item_id,
						revision: item.revision,
						checks: checks.map((check) => check.requested_check_id).sort(),
					});
					const task = await infer(body, key, signal);
					knownTaskId = task.id;
					const parsed = parseSeeAPIResult(task, checks, parameters);
					results.push(...parsed);
					if (
						parsed.some((finding) =>
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
					) {
						return [
							...results,
							...requested_checks
								.filter(
									(check) =>
										!results.some(
											(finding) =>
												finding.requested_check_id === check.requested_check_id,
										),
								)
								.map((check) =>
									empty(check, "failed", "SEEAPI_NOT_RUN_AFTER_HIT"),
								),
						];
					}
				} catch (error) {
					const code =
						error &&
						typeof error === "object" &&
						"seeapiCode" in error &&
						typeof error.seeapiCode === "string"
							? error.seeapiCode
							: signal.aborted
								? "SEEAPI_ABORTED"
								: "SEEAPI_INVALID_RESULT";
					const taskId =
						error &&
						typeof error === "object" &&
						"taskId" in error &&
						typeof error.taskId === "string"
							? error.taskId
							: knownTaskId;
					results.push(
						...checks.map((check) => ({
							...empty(check, "failed", code),
							provider_request_id: taskId,
						})),
					);
				}
			}
			return results;
		},
	};
}
function empty(
	check: RequestedCheck,
	coverage: "unsupported" | "failed",
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
