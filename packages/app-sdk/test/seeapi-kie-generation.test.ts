import type {
	GenerationPolicy,
	PolicyContext,
	PolicyDecision,
	StoredGenerationAsset,
} from "@app/generation";
import { describe, expect, it, vi } from "vitest";
import {
	createKieGenerationProvider,
	kieNanoBanana2Adapter,
	kieNanoBanana2Parameters,
} from "../../generation/src/providers/kie";
import { setup as setupGeneration } from "../../generation/test/fixture";
import type { ContentItem, Stage } from "../src/moderation";
import { createSeeAPIModerationDetector } from "../src/moderation";
import {
	contextDigest,
	evaluation,
	platformPolicy,
	policyRule,
	setupModeration,
} from "./moderation-fixtures";

/** Synthetic upstream responses; authentication, jobs, audit SQL and asset handling are real. */
async function connected(
	outcome: "clear" | "flagged" | "unavailable" | "pending",
	blockPrompt = false,
) {
	let revoked = false;
	const errors: unknown[] = [];
	const seeapi = vi
		.fn<typeof fetch>()
		.mockImplementation(async (_url, init) => {
			const request = JSON.parse(String(init?.body)) as { model: string };
			if (request.model === "nsfw-filter-2" && outcome === "unavailable")
				return new Response(null, { status: 402 });
			const image = request.model === "nsfw-filter-2";
			return Response.json({
				id: "task_moderation",
				object: "inference",
				model: request.model,
				endpoint: image ? "image-moderation" : "text-moderation",
				provider: "seeapi",
				status: image && outcome === "pending" ? "processing" : "succeeded",
				error: null,
				result:
					image && outcome === "pending"
						? null
						: {
								type: "json",
								data: image
									? {
											flagged: outcome === "flagged",
											categories: {
												nsfw: outcome === "flagged" ? ["nudity"] : [],
												special_care: [],
											},
										}
									: {
											flagged: blockPrompt,
											threshold: 0.3,
											categories: {
												sexual_explicit: {
													score: blockPrompt ? 0.9 : 0.01,
													flagged: blockPrompt,
												},
												sexual_suggestive: { score: 0.01, flagged: false },
											},
										},
							},
			});
		});
	const detector = createSeeAPIModerationDetector({
		api_key: "fixture-secret",
		base_url: "https://api.seeapi.com",
		version: "1",
		fetch: seeapi,
		resolveImage: async (item) => ({
			url: "https://private.example/authorized-output.png",
			revision: item.revision,
			media_type: "image/png",
			size_bytes: 16,
			width: 512,
			height: 512,
		}),
	});
	const moderation = await setupModeration({
		platform: platformPolicy({
			rules: [
				policyRule({
					id: "text-safety",
					category: "sexual",
					threshold: null,
					detector_ids: [detector.id],
				}),
				policyRule({
					id: "image-safety",
					category: "sexual",
					threshold: null,
					detector_ids: [detector.id],
					modalities: ["image"],
					minimum_scope: "image.original",
				}),
			],
		}),
		options: {
			detectors: [detector],
			resolveControls: async () => ({
				version: revoked ? "2" : "1",
				block_all: revoked,
				disabled_detectors: [],
			}),
		},
	});
	const context = (input: PolicyContext) => ({
		tenant_id: "tenant-example",
		subject_id: input.userId,
		actor_id: input.userId,
	});
	async function evaluate(
		input: PolicyContext,
		stage: Stage,
		items: ContentItem[],
	): Promise<PolicyDecision> {
		const current = await moderation.storage.get(
			context(input).tenant_id,
			"attempt",
			input.attemptId,
		);
		const result = await moderation.sdk.evaluate(
			evaluation(stage, current?.revision ?? 0, {
				context: context(input),
				job_id: input.jobId,
				attempt_id: input.attemptId,
				items,
				idempotency_key: `${input.attemptId}:${stage}`,
			}),
			input.signal,
		);
		return result.decision.decision === "legal_hold"
			? "block"
			: result.decision.decision;
	}
	const authorize = (input: PolicyContext, operation: "generate" | "deliver") =>
		moderation.sdk.authorizeOperation({
			context: context(input),
			attempt_id: input.attemptId,
			operation,
			content_revision: "content-1",
			context_digest: contextDigest,
			idempotency_key: crypto.randomUUID(),
		});
	const policy: GenerationPolicy = {
		async beforeGenerate(input) {
			const decision = await evaluate(input, "prompt", [
				{
					item_id: "prompt",
					field: "prompt",
					revision: "1",
					modality: "text",
					text: input.request.prompt,
				},
			]);
			if (decision !== "allow") return decision;
			const checked = await evaluate(input, "input", []);
			return checked !== "allow"
				? checked
				: (await authorize(input, "generate")).permit
					? "allow"
					: "review";
		},
		async beforeDeliver(
			input: PolicyContext & { assets: StoredGenerationAsset[] },
		) {
			try {
				await moderation.sdk.recordProviderResult({
					context: context(input),
					event_id: `${input.attemptId}:provider`,
					attempt_id: input.attemptId,
					status: "succeeded",
					provider: "kie",
					provider_request_id: "task_generation",
					provider_model: "nano-banana-2",
					error_code: null,
				});
				const checked = await evaluate(
					input,
					"output",
					input.assets.map((asset) => ({
						item_id: asset.id,
						field: "media",
						revision: "1",
						modality: "image",
						asset_ref: `generation:${asset.id}`,
					})),
				);
				if (checked !== "allow") return checked;
				return evaluate(input, "presentation", [
					{
						item_id: "title",
						field: "title",
						revision: "1",
						modality: "text",
						text: "Generated image",
					},
				]);
			} catch (error) {
				errors.push(error);
				throw error;
			}
		},
		async authorizeDelivery(input) {
			return (await authorize(input, "deliver")).permit;
		},
	};
	const kie = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
		if (init?.method === "POST")
			return Response.json({ code: 200, data: { taskId: "task_generation" } });
		if (String(url).includes("recordInfo"))
			return Response.json({
				code: 200,
				data: {
					taskId: "task_generation",
					model: "nano-banana-2",
					state: "success",
					resultJson: JSON.stringify({
						resultUrls: ["https://cdn.example/result.png"],
					}),
				},
			});
		return new Response("synthetic-image", {
			headers: { "Content-Type": "image/png" },
		});
	});
	const provider = createKieGenerationProvider({
		apiKey: "fixture-key",
		models: { "nano-banana-2": kieNanoBanana2Adapter },
		downloadHosts: ["cdn.example"],
		fetch: kie,
	});
	const generation = await setupGeneration(
		{
			policy,
			models: [
				{
					id: "picture",
					model: "nano-banana-2",
					providerId: "kie",
					version: "1",
					kind: "image",
					modes: ["text-to-image"],
					maxInputAssets: 0,
					parameters: kieNanoBanana2Parameters,
				},
			],
		},
		provider,
	);
	return {
		generation,
		moderation,
		kie,
		seeapi,
		errors,
		revoke: () => {
			revoked = true;
		},
	};
}

describe("SeeAPI and Kie.ai generation policy integration", () => {
	it("stores private output, checks all stages and reauthorizes every delivery", async () => {
		const { generation, seeapi, revoke, errors } = await connected("clear");
		const { job } = await generation.create();
		await generation.run();
		await generation.run(job.id);
		await generation.run(job.id);
		const result = await generation.get(job.id);
		expect(errors).toEqual([]);
		expect(result.job, JSON.stringify(result.job)).toMatchObject({
			deliveryStatus: "ready",
		});
		expect(result.assets).toHaveLength(1);
		expect(generation.assets.put).toHaveBeenCalled();
		expect(seeapi).toHaveBeenCalledTimes(3);
		revoke();
		expect((await generation.get(job.id)).assets).toEqual([]);
	});
	it.each([
		"flagged",
		"unavailable",
		"pending",
	] as const)("withholds private assets when output moderation is %s", async (outcome) => {
		const { generation } = await connected(outcome);
		const { job } = await generation.create();
		await generation.run();
		await generation.run(job.id);
		await generation.run(job.id);
		const result = await generation.get(job.id);
		expect(result.job.deliveryStatus).toBe(
			outcome === "flagged" ? "blocked" : "review",
		);
		expect(result.assets).toEqual([]);
		expect(generation.assets.put).toHaveBeenCalled();
	});
	it("does not submit any generation for a rejected prompt", async () => {
		const { generation, kie } = await connected("clear", true);
		const { job } = await generation.create();
		await generation.run();
		expect((await generation.get(job.id)).job.deliveryStatus).toBe("blocked");
		expect(kie).not.toHaveBeenCalled();
	});
});
