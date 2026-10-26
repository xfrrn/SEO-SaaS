import { describe, expect, it, vi } from "vitest";
import { runChecks } from "../src/moderation/detection";
import type { SeeAPIModerationOptions } from "../src/moderation/detectors/seeapi";
import { createSeeAPIModerationDetector } from "../src/moderation/detectors/seeapi";
import type {
	ContentItem,
	ModerationDetector,
	PolicyRule,
} from "../src/moderation/types";
import {
	evaluation,
	platformPolicy,
	policyRule,
	setupModeration,
} from "./moderation-fixtures";

const text: ContentItem = {
	item_id: "text",
	field: "prompt",
	revision: "1",
	modality: "text",
	text: "ordinary text",
};
const image: ContentItem = {
	item_id: "image",
	field: "media",
	revision: "1",
	modality: "image",
	asset_ref: "private-image",
};
const video: ContentItem = {
	...image,
	item_id: "video",
	modality: "video",
	asset_ref: "private-video",
};
const imageAsset = {
	url: "https://assets.example/image.png?signature=private",
	revision: "1",
	media_type: "image/png" as const,
	width: 512,
	height: 512,
	size_bytes: 100,
};
const videoAsset = {
	url: "https://assets.example/video.mp4",
	revision: "1",
	media_type: "video/mp4" as const,
	duration_ms: 6000,
	size_bytes: 1000,
};
const options = {
	api_key: "server-only-secret",
	base_url: "https://api.seeapi.com",
	version: "fixture-1",
	poll_interval_ms: 1,
};
function task(model: string, data: unknown, status = "succeeded") {
	return {
		id: "task_fixture",
		object: "inference",
		model,
		provider: "seeapi",
		endpoint:
			model === "text-nsfw-filter"
				? "text-moderation"
				: model === "nsfw-filter-2"
					? "image-moderation"
					: "video-moderation",
		status,
		error: null,
		result: data === null ? null : { type: "json", data },
	};
}
function textResult(flagged = false) {
	return {
		flagged,
		threshold: 0.3,
		categories: {
			sexual_explicit: { score: flagged ? 0.9 : 0.05, flagged },
			sexual_suggestive: { score: 0.05, flagged: false },
		},
	};
}
function videoResult() {
	return {
		flagged: false,
		output: {
			scope: "sampled_frames",
			report_schema_version: 5,
			sampling_complete: true,
			checked_frames: 1,
			flagged_frame_count: 0,
			nsfw_detected: false,
			frames: [
				{
					frame_number: 1,
					timestamp_seconds: 0,
					nsfw_detected: false,
					nsfw: [] as string[],
					special: [] as string[],
					image_url: "https://private.example/frame",
				},
			],
		},
	};
}
function detector(
	fetcher: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
	extra: Partial<SeeAPIModerationOptions> = {},
) {
	return createSeeAPIModerationDetector({
		...options,
		fetch: vi.fn<typeof fetch>().mockImplementation(fetcher),
		resolveImage: async () => imageAsset,
		resolveVideo: async () => videoAsset,
		...extra,
	});
}
function rule(item: ContentItem, category = "sexual"): PolicyRule {
	return policyRule({
		id: category.replace("/", "-"),
		category,
		modalities: [item.modality],
		detector_ids: ["seeapi-moderation"],
		threshold: null,
		minimum_scope:
			item.modality === "video"
				? "video.provider_sampled_frames"
				: item.modality === "image"
					? "image.original"
					: "text.semantic",
	});
}
function check(
	provider: ModerationDetector,
	item = text,
	rules = [rule(item)],
	extra: {
		execution_key?: string;
		timeout_ms?: number;
		detectors?: ModerationDetector[];
	} = {},
) {
	return runChecks({
		execution_key: "opaque-tenant-command",
		items: [item],
		rules,
		detectors: [provider],
		controls: { version: "1", block_all: false, disabled_detectors: [] },
		timeout_ms: 500,
		...extra,
	});
}

/** @see https://www.seeapi.com/docs/text-nsfw-filter/text-moderation/ */
describe("SeeAPI native moderation", () => {
	it("keeps recognized image hits when another native label is invalid", async () => {
		const result = await check(
			detector(async () =>
				Response.json(
					task("nsfw-filter-2", {
						flagged: true,
						categories: {
							nsfw: ["nudity", { malformed: true }],
							special_care: [],
						},
					}),
				),
			),
			image,
		);
		expect(result.decision).toBe("block");
		expect(result.findings[0]).toMatchObject({
			native_flagged: true,
			coverage: "missing",
			score: null,
		});
	});

	it("does not claim audio or host-extracted video coverage", async () => {
		const fetcher = vi.fn<typeof fetch>();
		for (const scope of ["video.sampled_frames", "video.audio"]) {
			expect(
				(
					await check(detector(fetcher), video, [
						{ ...rule(video), minimum_scope: scope },
					])
				).decision,
			).toBe("review");
		}
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("preserves valid video hits when another frame is malformed", async () => {
		const body = videoResult();
		const hit = {
			...body.output.frames[0]!,
			nsfw_detected: true,
			nsfw: ["nudity"],
		};
		const result = await check(
			detector(async () =>
				Response.json(
					task("video-nsfw-filter", {
						flagged: true,
						output: {
							...body.output,
							nsfw_detected: true,
							flagged_frame_count: 1,
							checked_frames: 2,
							frames: [hit, { malformed: true }],
						},
					}),
				),
			),
			video,
		);
		expect(result.decision).toBe("block");
		expect(result.findings[0]?.coverage).toBe("missing");
	});

	it("rejects insecure configuration and malformed data URLs before submission", async () => {
		expect(() =>
			detector(vi.fn<typeof fetch>(), { base_url: "http://api.seeapi.com" }),
		).toThrow();
		expect(() =>
			detector(vi.fn<typeof fetch>(), { text_threshold: 1 }),
		).toThrow();
		const fetcher = vi.fn<typeof fetch>();
		const result = await check(
			detector(fetcher, {
				resolveImage: async () => ({
					...imageAsset,
					url: "data:image/png;base64,aW1hZ2U=",
				}),
			}),
			image,
		);
		expect(result.decision).toBe("review");
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("maps text categories, preserves native thresholds and binds opaque request keys", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockImplementation(async () =>
				Response.json(task("text-nsfw-filter", textResult())),
			);
		const provider = detector(fetcher);
		const first = await check(provider);
		expect(first.decision).toBe("allow");
		expect(first.findings[0]).toMatchObject({
			score: 0.05,
			native_flagged: false,
			provider_model: "text-nsfw-filter",
			provider_request_id: "task_fixture",
			provider_evidence: { parameters: { threshold: 0.3 } },
		});
		await check(provider);
		await check(provider, text, [rule(text)], {
			execution_key: "another-command",
		});
		const keys = fetcher.mock.calls.map(([, init]) =>
			new Headers(init?.headers).get("Idempotency-Key"),
		);
		expect(keys[0]).toMatch(/^[a-f0-9]{64}$/);
		expect(keys[0]).toBe(keys[1]);
		expect(keys[0]).not.toBe(keys[2]);
		const [url, init] = fetcher.mock.calls[0]!;
		expect(String(url)).toBe("https://api.seeapi.com/v1/inferences");
		expect(new Headers(init?.headers).get("Authorization")).toBe(
			"Bearer server-only-secret",
		);
		expect(JSON.parse(String(init?.body))).toMatchObject({
			model: "text-nsfw-filter",
			input: { categories: ["sexual_explicit", "sexual_suggestive"] },
		});
	});

	it("is idempotent through real audit commands and isolates the same command across tenants", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockImplementation(async () =>
				Response.json(task("text-nsfw-filter", textResult())),
			);
		const instance = await setupModeration({
			platform: platformPolicy({ rules: [rule(text)] }),
			options: { detectors: [detector(fetcher)] },
		});
		const input = evaluation();
		await instance.sdk.evaluate(input);
		await instance.sdk.evaluate(input);
		await instance.sdk.evaluate({
			...input,
			context: { ...input.context, tenant_id: "another-tenant" },
		});
		expect(fetcher).toHaveBeenCalledTimes(2);
		const keys = fetcher.mock.calls.map(([, init]) =>
			new Headers(init?.headers).get("Idempotency-Key"),
		);
		expect(keys[0]).not.toBe(keys[1]);
		expect(keys.join()).not.toContain("tenant");
	});

	it("polls accepted image tasks without treating 202 as a clean assessment", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json(task("nsfw-filter-2", null, "processing"), {
					status: 202,
					headers: { "Retry-After": "0" },
				}),
			)
			.mockResolvedValueOnce(
				Response.json(
					task("nsfw-filter-2", {
						flagged: true,
						categories: { nsfw: ["nudity"], special_care: [] },
					}),
				),
			);
		const result = await check(detector(fetcher), image, [
			rule(image),
			rule(image, "sexual/minors"),
		]);
		expect(result.decision).toBe("block");
		expect(result.findings[0]).toMatchObject({
			native_flagged: true,
			score: null,
		});
		expect(result.findings[1]?.native_flagged).toBe(false);
		expect(String(fetcher.mock.calls[1]?.[0])).toBe(
			"https://api.seeapi.com/v1/inferences/task_fixture",
		);
		expect(JSON.stringify(result)).not.toContain("signature=private");
	});

	it("records special-care image labels independently", async () => {
		const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
			Response.json(
				task("nsfw-filter-2", {
					flagged: true,
					categories: { nsfw: [], special_care: ["sexual_minors"] },
				}),
			),
		);
		const result = await check(detector(fetcher), image, [
			rule(image),
			rule(image, "sexual/minors"),
		]);
		expect(result.findings.map((entry) => entry.native_flagged)).toEqual([
			false,
			true,
		]);
	});

	it("retains real hits when a different text category is malformed or missing", async () => {
		const body = textResult(true);
		body.categories.sexual_suggestive.score = Number.NaN;
		const fetcher = vi
			.fn<typeof fetch>()
			.mockImplementation(async () =>
				Response.json(task("text-nsfw-filter", body)),
			);
		const result = await check(detector(fetcher));
		expect(result.decision).toBe("block");
		expect(result.findings[0]).toMatchObject({
			coverage: "missing",
			native_flagged: true,
			score: null,
		});
	});

	it("does not infer a missing category from the overall flag", async () => {
		const body = textResult();
		const fetcher = vi
			.fn<typeof fetch>()
			.mockImplementation(async () =>
				Response.json(task("text-nsfw-filter", body)),
			);
		const result = await check(detector(fetcher), text, [
			rule(text, "sexual/minors"),
		]);
		expect(result.decision).toBe("review");
	});

	it("does not discard an image hit when the special-care field is absent", async () => {
		const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
			Response.json(
				task("nsfw-filter-2", {
					flagged: true,
					categories: { nsfw: ["nudity"] },
				}),
			),
		);
		const result = await check(detector(fetcher), image, [
			rule(image),
			rule(image, "sexual/minors"),
		]);
		expect(result.decision).toBe("block");
		expect(result.findings[1]?.coverage).toBe("missing");
	});

	it("retains a completed hit before a subsequent item could hang", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockImplementation(async () =>
				Response.json(task("text-nsfw-filter", textResult(true))),
			);
		const result = await runChecks({
			execution_key: "opaque",
			items: [text, { ...text, item_id: "next" }],
			rules: [rule(text)],
			detectors: [detector(fetcher)],
			controls: { version: "1", block_all: false, disabled_detectors: [] },
			timeout_ms: 500,
		});
		expect(result.decision).toBe("block");
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(result.findings[1]?.reason_code).toBe("SEEAPI_NOT_RUN_AFTER_HIT");
	});

	it("honors Retry-After and replays the identical POST body and key", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(null, { status: 429, headers: { "Retry-After": "0.01" } }),
			)
			.mockResolvedValueOnce(
				Response.json(task("text-nsfw-filter", textResult())),
			);
		const started = Date.now();
		expect((await check(detector(fetcher))).decision).toBe("allow");
		expect(Date.now() - started).toBeGreaterThanOrEqual(9);
		expect(fetcher.mock.calls[0]?.[1]?.body).toBe(
			fetcher.mock.calls[1]?.[1]?.body,
		);
		expect(
			new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("Idempotency-Key"),
		).toBe(
			new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("Idempotency-Key"),
		);
	});

	it.each([
		401, 402, 409, 422, 429, 503,
	])("never permits an HTTP %s response", async (status) => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockImplementation(async () => new Response(null, { status }));
		expect((await check(detector(fetcher))).decision).toBe("review");
		expect(fetcher).toHaveBeenCalledTimes(
			status === 429 || status === 503 ? 3 : 1,
		);
	});

	it.each([
		"failed",
		"refunded",
		"expired",
		"canceled",
	])("never permits a %s task", async (state) => {
		expect(
			(
				await check(
					detector(async () =>
						Response.json(task("text-nsfw-filter", null, state)),
					),
				)
			).decision,
		).toBe("review");
	});

	it("aborts polling and rejects null, mismatched and oversized results", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockImplementation(async () =>
				Response.json(task("nsfw-filter-2", null, "processing")),
			);
		expect(
			(
				await check(
					detector(fetcher, { poll_interval_ms: 100 }),
					image,
					[rule(image)],
					{ timeout_ms: 10 },
				)
			).decision,
		).toBe("review");
		expect(fetcher).toHaveBeenCalledTimes(1);
		for (const body of [
			task("nsfw-filter-2", null),
			{ ...task("nsfw-filter-2", { flagged: false }), model: "wrong" },
			"not-json",
		]) {
			expect(
				(
					await check(
						detector(async () => Response.json(body)),
						image,
					)
				).decision,
			).toBe("review");
		}
		expect(
			(
				await check(
					detector(
						async () => Response.json(task("text-nsfw-filter", textResult())),
						{ max_response_bytes: 4 },
					),
				)
			).decision,
		).toBe("review");
	});

	it("rejects unsupported formats, oversized media, changed revisions and long text before submission", async () => {
		const fetcher = vi.fn<typeof fetch>();
		for (const asset of [
			{ ...imageAsset, size_bytes: 20_000_000 },
			{ ...imageAsset, width: 200 },
			{ ...imageAsset, revision: "other" },
			{ ...imageAsset, url: "http://example/image" },
		]) {
			expect(
				(
					await check(
						detector(fetcher, { resolveImage: async () => asset }),
						image,
					)
				).decision,
			).toBe("review");
		}
		for (const asset of [
			{ ...videoAsset, duration_ms: 30_001 },
			{ ...videoAsset, size_bytes: 100_000_001 },
		])
			expect(
				(
					await check(
						detector(fetcher, { resolveVideo: async () => asset }),
						video,
					)
				).decision,
			).toBe("review");
		expect(
			(
				await check(detector(fetcher), {
					...text,
					modality: "text",
					text: "x".repeat(20_001),
				})
			).decision,
		).toBe("review");
		expect(
			(
				await check(detector(fetcher), text, [rule(text)], {
					execution_key: undefined,
				})
			).decision,
		).toBe("review");
		expect(fetcher).not.toHaveBeenCalled();
	});

	/** @see https://www.seeapi.com/docs/video-nsfw-filter/video-moderation/ */
	it("stores native video sampling separately and omits returned frame URLs", async () => {
		const result = await check(
			detector(async () =>
				Response.json(task("video-nsfw-filter", videoResult())),
			),
			video,
			[rule(video), rule(video, "sexual/minors")],
		);
		expect(result.decision).toBe("allow");
		expect(result.findings[0]).toMatchObject({
			inspection_scope: "video.provider_sampled_frames",
			provider_evidence: {
				video: {
					requested_frames: 8,
					checked_frames: 1,
					sampling_complete: true,
				},
			},
		});
		expect(JSON.stringify(result)).not.toContain("private.example");
	});

	it("does not declare unreturned special-care fields clean", async () => {
		const body = videoResult();
		const { special: _special, ...frame } = body.output.frames[0]!;
		const result = await check(
			detector(async () =>
				Response.json(
					task("video-nsfw-filter", {
						...body,
						output: { ...body.output, frames: [frame] },
					}),
				),
			),
			video,
			[rule(video), rule(video, "sexual/minors")],
		);
		expect(result.decision).toBe("review");
		expect(result.findings[0]?.coverage).toBe("checked");
		expect(result.findings[1]?.coverage).toBe("missing");
	});

	it("keeps positive frames blocking despite incomplete sampling and a successful fallback", async () => {
		const body = videoResult();
		body.flagged = true;
		body.output.nsfw_detected = true;
		body.output.sampling_complete = false;
		body.output.flagged_frame_count = 1;
		body.output.frames[0]!.nsfw_detected = true;
		body.output.frames[0]!.nsfw = ["nudity"];
		const provider = detector(async () =>
			Response.json(task("video-nsfw-filter", body)),
		);
		const backup: ModerationDetector = {
			id: "backup",
			version: "1",
			layer: "safety",
			capabilities: provider.capabilities,
			check: async ({ requested_checks }) =>
				requested_checks.map(({ requested_check_id }) => ({
					requested_check_id,
					coverage: "checked",
					flagged: false,
					score: null,
					reason_code: "CLEAR",
				})),
		};
		const result = await check(
			provider,
			video,
			[{ ...rule(video), detector_ids: [provider.id, backup.id] }],
			{ detectors: [provider, backup] },
		);
		expect(result.decision).toBe("block");
		expect(result.findings[0]?.native_flagged).toBe(true);
	});

	it("blocks provider policy refusal without inventing a complete frame report", async () => {
		const result = await check(
			detector(async () =>
				Response.json(
					task("video-nsfw-filter", {
						flagged: true,
						reason: "content_policy_blocked",
						output: null,
					}),
				),
			),
			video,
		);
		expect(result.decision).toBe("block");
		expect(result.findings[0]?.coverage).toBe("missing");
	});
});
