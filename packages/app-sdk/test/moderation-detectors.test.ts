import { afterEach, describe, expect, it, vi } from "vitest";
import { runChecks } from "../src/moderation/detection";
import type { ResolvedVideoInspection } from "../src/moderation/detectors/openai";
import { createOpenAIModerationDetector } from "../src/moderation/detectors/openai";
import type {
	ContentItem,
	ModerationDetector,
	PolicyRule,
} from "../src/moderation/types";

const text: ContentItem = {
	item_id: "prompt",
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
const controls = { version: "1", block_all: false, disabled_detectors: [] };
function rule(overrides: Partial<PolicyRule> = {}): PolicyRule {
	return {
		id: "violence",
		category: "violence",
		layer: "safety",
		stages: ["prompt"],
		modalities: ["text", "image", "video"],
		minimum_scope: "text.semantic",
		required: true,
		mode: "enforce",
		detector_ids: ["openai-moderation"],
		threshold: 0.8,
		block_level: "soft",
		public_description: "Violence",
		action: null,
		...overrides,
	};
}
function detector(
	id: string,
	check: ModerationDetector["check"],
	scope = "text.semantic",
): ModerationDetector {
	return {
		id,
		version: "1",
		layer: "safety",
		capabilities: [
			{ modality: "text", category: "violence", inspection_scope: scope },
		],
		check,
	};
}
const clear: ModerationDetector["check"] = async ({ requested_checks }) =>
	requested_checks.map((check) => ({
		requested_check_id: check.requested_check_id,
		coverage: "checked",
		flagged: false,
		score: 0.1,
		reason_code: "CLEAR",
	}));
function run(
	detectors: ModerationDetector[],
	rules = [rule()],
	items = [text],
	extra: Partial<Parameters<typeof runChecks>[0]> = {},
) {
	return runChecks({
		detectors,
		rules,
		items,
		controls,
		timeout_ms: 1000,
		...extra,
	});
}
function openai(
	resolveVideo?: (
		item: ContentItem & { modality: "video" },
		signal: AbortSignal,
	) => Promise<ResolvedVideoInspection>,
) {
	return createOpenAIModerationDetector({
		api_key: "test-api-key",
		endpoint: "https://api.openai.com/v1/moderations",
		model: "omni-moderation-2024-09-26",
		resolveImage: async () => "data:image/png;base64,YQ==",
		resolveVideo,
	});
}
function response(score = 0.1, flagged = false, modality = "text") {
	return Response.json(
		{
			id: "moderation-1",
			model: "omni-moderation-2024-09-26",
			results: [
				{
					flagged,
					categories: { violence: flagged },
					category_scores: { violence: score },
					category_applied_input_types: { violence: [modality] },
				},
			],
		},
		{ headers: { "x-request-id": "request-1" } },
	);
}
function extraction(
	overrides: Partial<ResolvedVideoInspection["manifest"]> = {},
): ResolvedVideoInspection {
	return {
		plan: {
			version: "plan-1",
			frames_per_second: 1,
			include_first_frame: true,
			include_last_frame: true,
			sample_scene_changes: false,
			include_audio: false,
			max_duration_ms: 1000,
			max_frames: 2,
		},
		manifest: {
			plan_version: "plan-1",
			extractor_version: "extractor-1",
			asset_revision: "1",
			actual_duration_ms: 1000,
			frames: [
				{ timestamp_ms: 0, asset_ref: "first" },
				{ timestamp_ms: 1000, asset_ref: "last" },
			],
			audio: { status: "not_applicable", transcript_ref: null },
			unmet_requirements: [],
			...overrides,
		},
	};
}

afterEach(() => vi.unstubAllGlobals());

describe("moderation detection orchestration", () => {
	it("groups checks by detector and retains stable logical identities", async () => {
		const check = vi.fn(clear),
			adapter = detector("primary", check);
		const first = await run(
			[adapter],
			[rule({ detector_ids: ["primary"] })],
			[text, { ...text, item_id: "title", field: "title" }],
		);
		expect(first.decision).toBe("allow");
		expect(check).toHaveBeenCalledTimes(1);
		const second = await run([adapter], [rule({ detector_ids: ["primary"] })]);
		expect(first.check_coverage[0]?.requested_check_id).toBe(
			second.check_coverage[0]?.requested_check_id,
		);
		const changed = await run(
			[adapter],
			[rule({ detector_ids: ["primary"] })],
			[{ ...text, revision: "2" }],
		);
		expect(changed.check_coverage[0]?.requested_check_id).not.toBe(
			second.check_coverage[0]?.requested_check_id,
		);
	});
	it("recovers technical failures through equivalent backup without erasing evidence", async () => {
		const backup = vi.fn(clear);
		const result = await run(
			[
				detector("primary", async () => {
					throw new Error("private provider error");
				}),
				detector("backup", backup),
			],
			[rule({ detector_ids: ["primary", "backup"] })],
		);
		expect(result.decision).toBe("allow");
		expect(result.execution).toBe("completed");
		expect(result.findings.map((finding) => finding.coverage)).toEqual([
			"failed",
			"checked",
		]);
		expect(result.findings.map((finding) => finding.native_flagged)).toEqual([
			null,
			false,
		]);
		expect(JSON.stringify(result)).not.toContain("private provider error");
	});
	it("does not retry policy blocks and does not replace original scope with weaker coverage", async () => {
		const backup = vi.fn(clear);
		const blocked = detector("primary", async ({ requested_checks }) =>
			requested_checks.map((check) => ({
				requested_check_id: check.requested_check_id,
				coverage: "checked",
				flagged: true,
				score: 0.01,
				reason_code: "FLAGGED",
			})),
		);
		expect(
			(
				await run(
					[blocked, detector("backup", backup)],
					[rule({ detector_ids: ["primary", "backup"] })],
				)
			).decision,
		).toBe("block");
		expect(backup).not.toHaveBeenCalled();
		const weak = vi.fn(clear);
		const missing = await run(
			[detector("primary", weak, "text.rules")],
			[rule({ detector_ids: ["primary"] })],
		);
		expect(missing.decision).toBe("review");
		expect(missing.check_coverage[0]?.coverage).toBe("unsupported");
		expect(weak).not.toHaveBeenCalled();
	});
	it("holds required unsupported capabilities, skips disabled detectors and block-all calls", async () => {
		const check = vi.fn(clear),
			adapters = [detector("primary", check)];
		const missing = await run(
			adapters,
			[rule({ detector_ids: ["primary"] })],
			[text],
			{ controls: { ...controls, disabled_detectors: ["primary"] } },
		);
		expect(missing.decision).toBe("review");
		const stopped = await run(
			adapters,
			[rule({ detector_ids: ["primary"] })],
			[text],
			{ controls: { ...controls, block_all: true } },
		);
		expect(stopped.decision).toBe("block");
		expect(stopped.block_level).toBe("hard");
		expect(check).not.toHaveBeenCalled();
	});
	it("treats malformed, duplicate and missing detector results as failures", async () => {
		for (const check of [
			async () => [],
			async () => [
				{
					requested_check_id: "unknown",
					coverage: "checked",
					flagged: false,
					score: 0,
					reason_code: "CLEAR",
				},
			],
			async ({
				requested_checks,
			}: Parameters<ModerationDetector["check"]>[0]) => [
				{
					requested_check_id: requested_checks[0]!.requested_check_id,
					coverage: "checked",
					flagged: false,
					score: Number.NaN,
					reason_code: "CLEAR",
				},
			],
		]) {
			const result = await run(
				[detector("primary", check as ModerationDetector["check"])],
				[rule({ detector_ids: ["primary"] })],
			);
			expect(result.decision).toBe("review");
			expect(result.check_coverage[0]?.coverage).toBe("failed");
		}
	});
	it("bounds an uncooperative adapter and retains shadow observations without enforcement", async () => {
		const timed = await run(
			[detector("primary", () => new Promise(() => {}))],
			[rule({ detector_ids: ["primary"] })],
			[text],
			{ timeout_ms: 5 },
		);
		expect(timed.decision).toBe("review");
		const shadow = await run(
			[
				detector("primary", async ({ requested_checks }) =>
					requested_checks.map((check) => ({
						requested_check_id: check.requested_check_id,
						coverage: "checked",
						flagged: false,
						score: 0.8,
						reason_code: "SCORED",
					})),
				),
			],
			[
				rule({
					detector_ids: ["primary"],
					mode: "shadow",
					block_level: "hard",
				}),
			],
		);
		expect(shadow.decision).toBe("allow");
		expect(shadow.would_decision).toBe("block");
		expect(shadow.would_block_level).toBe("hard");
		expect(shadow.check_coverage[0]?.mode).toBe("shadow");
	});
	it("keeps a partial-frame block even when a backup fills coverage", async () => {
		const partial = detector("primary", async ({ requested_checks }) =>
			requested_checks.map((check) => ({
				requested_check_id: check.requested_check_id,
				coverage: "failed",
				flagged: true,
				score: 0.9,
				reason_code: "PARTIAL_HIT",
			})),
		);
		const result = await run(
			[partial, detector("backup", clear)],
			[rule({ detector_ids: ["primary", "backup"] })],
		);
		expect(result.decision).toBe("block");
		expect(result.check_coverage[0]?.coverage).toBe("checked");
	});
});

/** @see https://developers.openai.com/api/docs/guides/moderation */
describe("OpenAI moderation adapter", () => {
	it("sends text to a bounded, redirect-free request and preserves provenance", async () => {
		const fetch = vi.fn(async () => response());
		vi.stubGlobal("fetch", fetch);
		const result = await run([openai()]);
		expect(result.decision).toBe("allow");
		expect(result.findings[0]).toMatchObject({
			provider_request_id: "request-1",
			provider_model: "omni-moderation-2024-09-26",
			native_category: "violence",
			native_flagged: false,
			score: 0.1,
		});
		expect(fetch.mock.calls[0]).toMatchObject([
			"https://api.openai.com/v1/moderations",
			{ redirect: "error", method: "POST" },
		]);
	});
	it("blocks both native flags and configured thresholds", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response(0.1, true)),
		);
		const flagged = await run([openai()]);
		expect(flagged.decision).toBe("block");
		expect(flagged.findings[0]?.native_flagged).toBe(true);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response(0.8, false)),
		);
		const scored = await run([openai()]);
		expect(scored.decision).toBe("block");
		expect(scored.findings[0]?.native_flagged).toBe(false);
	});
	it("never claims image minors, audio, nudity or non-native categories", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const result = await run(
			[openai()],
			[rule({ category: "sexual/minors", minimum_scope: "image.original" })],
			[image],
		);
		expect(result.decision).toBe("review");
		expect(result.check_coverage[0]?.coverage).toBe("unsupported");
		expect(result.findings[0]?.native_flagged).toBeNull();
		expect(
			openai().capabilities.some(
				(entry) => entry.modality === "audio" || entry.category === "nudity",
			),
		).toBe(false);
		expect(fetch).not.toHaveBeenCalled();
	});
	it("does not substitute zero for absent modality support and rejects malformed native data", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response(0, false, "text")),
		);
		expect(
			(
				await run(
					[openai()],
					[rule({ minimum_scope: "image.original" })],
					[image],
				)
			).decision,
		).toBe("review");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					model: "omni-moderation-latest",
					results: [{ flagged: false }],
				}),
			),
		);
		expect((await run([openai()])).check_coverage[0]?.coverage).toBe("failed");
	});
	it("rejects insecure endpoints and unsafe resolved image schemes", async () => {
		for (const endpoint of [
			"http://example.test",
			"https://user:secret@example.test",
			"https://example.test/#fragment",
		])
			expect(() =>
				createOpenAIModerationDetector({
					api_key: "key",
					endpoint,
					model: "omni-moderation-latest",
					resolveImage: async () => "",
				}),
			).toThrow();
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const adapter = createOpenAIModerationDetector({
			api_key: "key",
			endpoint: "https://example.test/moderate",
			model: "omni-moderation-latest",
			resolveImage: async () => "file:///private/image.png",
		});
		expect(
			(
				await run(
					[adapter],
					[rule({ minimum_scope: "image.original" })],
					[image],
				)
			).decision,
		).toBe("review");
		expect(fetch).not.toHaveBeenCalled();
	});
	it("requires all video frames and holds an incomplete extraction", async () => {
		const fetch = vi.fn(async () => response(0.1, false, "image"));
		vi.stubGlobal("fetch", fetch);
		const rules = [rule({ minimum_scope: "video.sampled_frames" })];
		expect(
			(await run([openai(async () => extraction())], rules, [video]))
				.check_coverage[0]?.coverage,
		).toBe("checked");
		expect(fetch).toHaveBeenCalledTimes(2);
		fetch.mockClear();
		expect(
			(
				await run(
					[
						openai(async () =>
							extraction({ unmet_requirements: ["scene_changes"] }),
						),
					],
					rules,
					[video],
				)
			).decision,
		).toBe("review");
		expect(fetch).not.toHaveBeenCalled();
	});
	it("returns a known video block before another frame can hang", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(response(0.95, true, "image"))
			.mockRejectedValueOnce(new Error("upstream failure"));
		vi.stubGlobal("fetch", fetch);
		const result = await run(
			[openai(async () => extraction())],
			[rule({ minimum_scope: "video.sampled_frames" })],
			[video],
		);
		expect(result.decision).toBe("block");
		expect(result.check_coverage[0]?.coverage).toBe("failed");
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
