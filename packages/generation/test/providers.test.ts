import { describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { createFalGenerationProvider } from "../src/providers/fal";
import { createGoogleGenerationProvider } from "../src/providers/google";
import { createOpenAIGenerationProvider } from "../src/providers/openai";
import type { GenerationMode, ProviderCall } from "../src/types";

function call(
	model = "image-model",
	kind: "image" | "video" = "image",
): ProviderCall & { inputs: [] } {
	const mode: GenerationMode =
		kind === "image" ? "text-to-image" : "text-to-video";
	return {
		model: {
			id: "configured",
			providerId: "provider",
			model,
			version: "1",
			kind,
			modes: [mode],
			maxInputAssets: 1,
		},
		request: {
			model: "configured",
			mode,
			prompt: "a tree",
			parameters: {},
			inputAssets: [],
			idempotencyKey: crypto.randomUUID(),
		},
		userId: "private-user",
		submissionKey: "attempt-id",
		signal: AbortSignal.timeout(5000),
		inputs: [],
	};
}

describe("official generation transports", () => {
	it("maps OpenAI image requests without exposing user IDs or forwarding arbitrary fields", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({
				data: [{ b64_json: "aW1hZ2U=" }],
				usage: { total_tokens: 5 },
			}),
		);
		const provider = createOpenAIGenerationProvider({
			apiKey: "server-secret",
			fetch: fetcher,
		});
		const result = await provider.submit(call());
		expect(result).toMatchObject({
			status: "succeeded",
			outputs: [{ base64: "aW1hZ2U=", mediaType: "image/png" }],
		});
		const [url, init] = fetcher.mock.calls[0]!;
		expect(String(url)).toBe("https://api.openai.com/v1/images/generations");
		const body = JSON.parse(String(init?.body));
		expect(body).toMatchObject({ model: "image-model", prompt: "a tree" });
		expect(body.safety_identifier).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.stringify(body)).not.toContain("private-user");
		const invalid = call();
		invalid.request.parameters = { apiKey: "forged" };
		await expect(provider.submit(invalid)).rejects.toMatchObject({
			generationOutcome: "rejected",
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("uses multipart image edits and keeps MIME types", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ data: [{ b64_json: "aW1hZ2U=" }] }));
		const provider = createOpenAIGenerationProvider({
			apiKey: "server-secret",
			fetch: fetcher,
		});
		const input = call();
		input.request.mode = "image-to-image";
		await provider.submit({
			...input,
			inputs: [{ mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]) }],
		});
		const [url, init] = fetcher.mock.calls[0]!;
		expect(String(url)).toContain("images/edits");
		expect(init?.body).toBeInstanceOf(FormData);
		const form = init?.body as FormData;
		expect((form.getAll("image[]")[0] as File).type).toBe("image/png");
	});

	it("maps Gemini image parts and distinguishes policy refusal", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json({
					candidates: [
						{
							content: {
								parts: [
									{ inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } },
								],
							},
						},
					],
				}),
			)
			.mockResolvedValueOnce(
				Response.json({ promptFeedback: { blockReason: "SAFETY" } }),
			);
		const provider = createGoogleGenerationProvider({
			apiKey: "server-secret",
			fetch: fetcher,
		});
		expect(await provider.submit(call())).toMatchObject({
			status: "succeeded",
			outputs: [{ mediaType: "image/png", base64: "aW1hZ2U=" }],
		});
		expect(await provider.submit(call())).toMatchObject({
			status: "failed",
			code: "policy_refused",
		});
		expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
			generationConfig: { responseModalities: ["IMAGE"] },
		});
	});

	it("tracks Veo operations and rejects unrelated operation names", async () => {
		const taskId = "models/video-model/operations/operation-id";
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ name: taskId }))
			.mockResolvedValueOnce(
				Response.json({
					name: taskId,
					done: true,
					response: {
						generateVideoResponse: {
							generatedSamples: [
								{
									video: {
										uri: "https://generativelanguage.googleapis.com/v1beta/files/video:download?alt=media",
									},
								},
							],
						},
					},
				}),
			);
		const provider = createGoogleGenerationProvider({
			apiKey: "server-secret",
			fetch: fetcher,
		});
		const input = call("video-model", "video");
		expect(await provider.submit(input)).toEqual({ status: "running", taskId });
		expect(await provider.poll!({ ...input, taskId })).toMatchObject({
			status: "succeeded",
			taskId,
			outputs: [{ mediaType: "video/mp4" }],
		});
		await expect(
			provider.poll!({
				...input,
				taskId: "models/other-model/operations/operation-id",
			}),
		).rejects.toThrow("Invalid Google operation");
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it("requires fal input/output mapping and uses the configured queue root", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ request_id: "request-id" }))
			.mockResolvedValueOnce(Response.json({ status: "COMPLETED" }))
			.mockResolvedValueOnce(
				Response.json({ images: [{ url: "https://v3.fal.media/output.png" }] }),
			);
		const provider = createFalGenerationProvider({
			apiKey: "server-secret",
			fetch: fetcher,
			models: {
				"fal-ai/example/version": {
					queueModel: "fal-ai/example",
					mapInput: ({ request }) => ({ prompt: request.prompt }),
					parseOutput: (data) =>
						z
							.object({ images: z.array(z.object({ url: z.url() })) })
							.parse(data)
							.images.map((image) => ({
								url: image.url,
								mediaType: "image/png",
							})),
				},
			},
		});
		const input = call("fal-ai/example/version");
		expect(await provider.submit(input)).toEqual({
			status: "running",
			taskId: "request-id",
		});
		expect(
			await provider.poll!({ ...input, taskId: "request-id" }),
		).toMatchObject({
			status: "succeeded",
			outputs: [{ url: "https://v3.fal.media/output.png" }],
		});
		expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
			"https://queue.fal.run/fal-ai/example/version",
			"https://queue.fal.run/fal-ai/example/requests/request-id/status",
			"https://queue.fal.run/fal-ai/example/requests/request-id",
		]);
	});

	it.each([
		400, 429, 500,
	])("sanitizes provider HTTP %i errors and identifies ambiguous outcomes", async (status) => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				new Response("credential-secret raw prompt", { status }),
			);
		const provider = createOpenAIGenerationProvider({
			apiKey: "server-secret",
			fetch: fetcher,
		});
		await expect(provider.submit(call())).rejects.toMatchObject({
			message: "Generation provider request failed",
			generationOutcome: status < 500 ? "rejected" : "unknown",
			status,
		});
	});

	it("bounds provider JSON responses before parsing", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ data: "x".repeat(100) }));
		const provider = createOpenAIGenerationProvider({
			apiKey: "server-secret",
			fetch: fetcher,
			maxResponseBytes: 8,
		});
		await expect(provider.submit(call())).rejects.toMatchObject({
			generationOutcome: "unknown",
		});
	});

	it("blocks untrusted media URLs and strips credentials on allowed CDN redirects", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: {
						location:
							"https://media.googleusercontent.com/video.mp4?signature=abc",
					},
				}),
			)
			.mockResolvedValueOnce(
				new Response(new Uint8Array([1, 2]), {
					headers: { "content-type": "video/mp4" },
				}),
			);
		const provider = createGoogleGenerationProvider({
			apiKey: "server-secret",
			fetch: fetcher,
		});
		for (const url of [
			"http://127.0.0.1/private",
			"https://127.0.0.1/private",
			"https://storage.googleapis.com.evil.example/video",
			"https://user:pass@storage.googleapis.com/video",
			"https://storage.googleapis.com:8443/video",
		])
			await expect(
				provider.readOutput!(
					{ mediaType: "video/mp4", url },
					AbortSignal.timeout(5000),
				),
			).rejects.toThrow("not allowed");
		expect(fetcher).not.toHaveBeenCalled();
		await provider.readOutput!(
			{
				mediaType: "video/mp4",
				url: "https://generativelanguage.googleapis.com/v1beta/files/video:download",
			},
			AbortSignal.timeout(5000),
		);
		expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
			"x-goog-api-key": "server-secret",
		});
		expect(fetcher.mock.calls[1]?.[1]?.headers).toEqual({});
	});
});
