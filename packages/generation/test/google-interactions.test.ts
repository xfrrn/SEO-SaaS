import { describe, expect, it, vi } from "vitest";
import { createGoogleInteractionsGenerationProvider } from "../src/providers/google";
import type { ProviderCall } from "../src/types";

const call = (): ProviderCall & { inputs: [] } => ({
	model: {
		id: "video",
		providerId: "google-interactions",
		model: "configured-model",
		version: "1",
		kind: "video",
		modes: ["text-to-video"],
		maxInputAssets: 1,
	},
	request: {
		model: "video",
		mode: "text-to-video",
		prompt: "a tree in the wind",
		parameters: { aspect_ratio: "9:16" },
		inputAssets: [],
		idempotencyKey: crypto.randomUUID(),
	},
	userId: "owner",
	submissionKey: "attempt",
	signal: AbortSignal.timeout(5000),
	inputs: [],
});

describe("Google Interactions media", () => {
	it("submits background media and parses REST steps instead of SDK-only output fields", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json({
					id: "interaction-id",
					model: "configured-model",
					status: "in_progress",
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					id: "interaction-id",
					model: "configured-model",
					status: "completed",
					steps: [
						{
							type: "user_input",
							content: [
								{ type: "video", mime_type: "video/mp4", data: "ignored" },
							],
						},
						{
							type: "model_output",
							content: [
								{
									type: "video",
									mime_type: "video/mp4",
									uri: "https://storage.googleapis.com/generated/video.mp4",
								},
							],
						},
					],
				}),
			);
		const provider = createGoogleInteractionsGenerationProvider({
			apiKey: "server-secret",
			fetch: fetcher,
		});
		expect(await provider.submit(call())).toEqual({
			status: "running",
			taskId: "interaction-id",
		});
		expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
			background: true,
			store: true,
			response_format: { type: "video", delivery: "uri", aspect_ratio: "9:16" },
		});
		expect(
			await provider.poll!({ ...call(), taskId: "interaction-id" }),
		).toEqual({
			status: "succeeded",
			taskId: "interaction-id",
			outputs: [
				{
					mediaType: "video/mp4",
					url: "https://storage.googleapis.com/generated/video.mp4",
				},
			],
		});
	});
	it("supports image input and confirms cancellation from the native resource", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json({ id: "interaction-id", status: "in_progress" }),
			)
			.mockResolvedValueOnce(
				Response.json({ id: "interaction-id", status: "cancelled" }),
			);
		const provider = createGoogleInteractionsGenerationProvider({
			apiKey: "server-secret",
			fetch: fetcher,
		});
		await provider.submit({
			...call(),
			inputs: [{ bytes: new Uint8Array([1, 2]), mediaType: "image/png" }],
		});
		expect(
			JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).input[0],
		).toEqual({ type: "image", mime_type: "image/png", data: "AQI=" });
		expect(
			await provider.cancel!({ ...call(), taskId: "interaction-id" }),
		).toEqual({ status: "cancelled", taskId: "interaction-id" });
	});
	it("rejects mismatched resources and unsupported parameters", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({
				id: "other-id",
				model: "other-model",
				status: "completed",
			}),
		);
		const provider = createGoogleInteractionsGenerationProvider({
			apiKey: "server-secret",
			fetch: fetcher,
		});
		await expect(
			provider.poll!({ ...call(), taskId: "original" }),
		).rejects.toThrow("binding mismatch");
		const input = call();
		input.request.parameters = { callback_url: "https://untrusted.example" };
		await expect(provider.submit(input)).rejects.toMatchObject({
			generationOutcome: "rejected",
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
});
