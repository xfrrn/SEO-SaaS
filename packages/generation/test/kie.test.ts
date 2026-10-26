import { describe, expect, it, vi } from "vitest";
import {
	createKieGenerationProvider,
	kieGrokImageToVideoAdapter,
	kieGrokTextToVideoAdapter,
	kieNanoBanana2Adapter,
} from "../src/providers/kie";
import type { GenerationMode, ProviderCall } from "../src/types";
import { setup } from "./fixture";

function call(mode: GenerationMode = "text-to-image"): ProviderCall & {
	inputs: { bytes: Uint8Array; mediaType: string; url: string }[];
} {
	const model = mode.endsWith("image")
		? "nano-banana-2"
		: `grok-imagine/${mode}`;
	return {
		model: {
			id: "picture",
			providerId: "kie",
			model,
			kind: mode.endsWith("image") ? "image" : "video",
			version: "1",
			modes: [mode],
			maxInputAssets: 1,
		},
		request: {
			model: "picture",
			mode,
			prompt: "a tree",
			parameters: {},
			inputAssets: mode.startsWith("image") ? ["private-ref"] : [],
			idempotencyKey: crypto.randomUUID(),
		},
		userId: "private-user",
		submissionKey: "attempt-1",
		signal: AbortSignal.timeout(5000),
		inputs: mode.startsWith("image")
			? [
					{
						bytes: new Uint8Array(4),
						mediaType: "image/png",
						url: "https://assets.example/owned.png",
					},
				]
			: [],
	};
}
const models = {
	"nano-banana-2": kieNanoBanana2Adapter,
	"grok-imagine/text-to-video": kieGrokTextToVideoAdapter,
	"grok-imagine/image-to-video": kieGrokImageToVideoAdapter,
};
const options = {
	apiKey: "server-secret",
	downloadHosts: ["cdn.example"],
	models,
};
function status(state = "success", extra: object = {}) {
	return {
		code: 200,
		data: {
			taskId: "task_one",
			model: "nano-banana-2",
			state,
			resultJson: JSON.stringify({
				resultUrls: ["https://cdn.example/result.png"],
			}),
			...extra,
		},
	};
}

/** @see https://docs.kie.ai/market/common/get-task-detail */
describe("Kie.ai Market provider", () => {
	it("requires an explicit download destination before submitting a paid task", () => {
		expect(() =>
			createKieGenerationProvider({ ...options, downloadHosts: [] }),
		).toThrow();
	});
	it.each<GenerationMode>([
		"text-to-image",
		"image-to-image",
		"text-to-video",
		"image-to-video",
	])("maps %s using an explicit model adapter", async (mode) => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockImplementation(async () =>
				Response.json({ code: 200, data: { taskId: "task_one" } }),
			);
		const provider = createKieGenerationProvider({
			...options,
			fetch: fetcher,
		});
		const input = call(mode);
		expect(await provider.submit(input)).toEqual({
			status: "running",
			taskId: "task_one",
		});
		const [url, init] = fetcher.mock.calls[0]!;
		expect(String(url)).toBe("https://api.kie.ai/api/v1/jobs/createTask");
		expect(new Headers(init?.headers).get("Authorization")).toBe(
			"Bearer server-secret",
		);
		const body = JSON.parse(String(init?.body));
		expect(body).toMatchObject({
			model: input.model.model,
			input: { prompt: "a tree" },
		});
		expect(JSON.stringify(body)).not.toContain("private-user");
		expect(body.callBackUrl).toBeUndefined();
		if (mode === "image-to-image")
			expect(body.input.image_input).toEqual([
				"https://assets.example/owned.png",
			]);
		if (mode === "image-to-video")
			expect(body.input.image_urls).toEqual([
				"https://assets.example/owned.png",
			]);
		expect(provider.cancel).toBeUndefined();
	});

	it.each([
		"waiting",
		"queuing",
		"generating",
		"success",
		"fail",
	])("maps native state %s", async (state) => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockImplementation(async () => Response.json(status(state)));
		const provider = createKieGenerationProvider({
			...options,
			fetch: fetcher,
		});
		const result = await provider.poll!({ ...call(), taskId: "task_one" });
		expect(result.status).toBe(
			state === "success"
				? "succeeded"
				: state === "fail"
					? "failed"
					: "running",
		);
		expect(String(fetcher.mock.calls[0]?.[0])).toBe(
			"https://api.kie.ai/api/v1/jobs/recordInfo?taskId=task_one",
		);
		if (result.status === "succeeded")
			expect(result.outputs).toEqual([
				{ url: "https://cdn.example/result.png", mediaType: "image/png" },
			]);
	});

	it.each([
		400, 401, 402, 403, 404, 422, 429,
	])("distinguishes a business rejection code %s inside HTTP 200", async (code) => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockImplementation(async () => Response.json({ code, msg: "redacted" }));
		await expect(
			createKieGenerationProvider({ ...options, fetch: fetcher }).submit(
				call(),
			),
		).rejects.toMatchObject({ generationOutcome: "rejected", status: code });
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("treats ambiguous submission responses and network failures as unknown", async () => {
		for (const body of [
			{ code: 500 },
			{ code: 200, data: {} },
			{ code: 200, data: { taskId: "../other" } },
			{},
		]) {
			await expect(
				createKieGenerationProvider({
					...options,
					fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json(body)),
				}).submit(call()),
			).rejects.toMatchObject({ generationOutcome: "unknown" });
		}
		await expect(
			createKieGenerationProvider({
				...options,
				fetch: vi
					.fn<typeof fetch>()
					.mockRejectedValue(new Error("connection lost")),
			}).submit(call()),
		).rejects.toMatchObject({ generationOutcome: "unknown" });
	});

	it("rejects another task/model, malformed result JSON, empty outputs and unsafe URLs", async () => {
		for (const body of [
			status("success", { taskId: "another" }),
			status("success", { model: "another" }),
			status("unknown"),
			status("success", { resultJson: "bad" }),
			status("success", { resultJson: JSON.stringify({ resultUrls: [] }) }),
			status("success", {
				resultJson: JSON.stringify({
					resultUrls: ["http://cdn.example/result"],
				}),
			}),
		]) {
			await expect(
				createKieGenerationProvider({
					...options,
					fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json(body)),
				}).poll!({ ...call(), taskId: "task_one" }),
			).rejects.toThrow();
		}
	});

	it("rejects unregistered models and invalid input mappings before sending", async () => {
		const fetcher = vi.fn<typeof fetch>();
		const provider = createKieGenerationProvider({
			...options,
			fetch: fetcher,
		});
		const unregistered = call();
		unregistered.model.model = "missing";
		const forged = call();
		forged.request.parameters = { apiKey: "forged" };
		const missingURL = call("image-to-image");
		missingURL.inputs[0]!.url = "http://private/image";
		for (const input of [unregistered, forged, missingURL])
			await expect(provider.submit(input)).rejects.toMatchObject({
				generationOutcome: "rejected",
			});
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("restricts downloads and redirects without forwarding credentials to a CDN", async () => {
		const fetcher = vi.fn<typeof fetch>().mockImplementation(
			async () =>
				new Response("synthetic image", {
					headers: { "Content-Type": "image/png" },
				}),
		);
		const provider = createKieGenerationProvider({
			...options,
			fetch: fetcher,
		});
		await provider.readOutput!(
			{ url: "https://cdn.example/image.png", mediaType: "image/png" },
			call().signal,
		);
		expect(
			new Headers(fetcher.mock.calls[0]?.[1]?.headers).has("Authorization"),
		).toBe(false);
		await expect(
			provider.readOutput!(
				{ url: "https://untrusted.example/image", mediaType: "image/png" },
				call().signal,
			),
		).rejects.toThrow();
		fetcher.mockImplementationOnce(
			async () =>
				new Response(null, {
					status: 302,
					headers: { Location: "https://untrusted.example/image" },
				}),
		);
		await expect(
			provider.readOutput!(
				{ url: "https://cdn.example/redirect", mediaType: "image/png" },
				call().signal,
			),
		).rejects.toThrow();
	});

	it("never automatically re-submits a Kie request whose response was lost", async () => {
		const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
			throw new Error("accepted but response lost");
		});
		const provider = createKieGenerationProvider({
			...options,
			fetch: fetcher,
		});
		const instance = await setup(
			{
				models: [
					{
						...call().model,
						parameters: (await import("../src/providers/kie"))
							.kieNanoBanana2Parameters,
					},
				],
			},
			provider,
		);
		const { job } = await instance.create();
		await instance.run();
		await instance.run();
		expect((await instance.get(job.id)).job.status).toBe(
			"needs_reconciliation",
		);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
});
