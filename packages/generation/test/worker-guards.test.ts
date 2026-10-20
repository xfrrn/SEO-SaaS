import { describe, expect, it, vi } from "vitest";
import type {
	GenerationPolicy,
	GenerationProvider,
	ProviderResult,
} from "../src/types";
import { setup } from "./fixture";

describe("generation processing boundaries", () => {
	it("resumes overdue saved results without resubmitting a synchronous provider", async () => {
		const instance = await setup();
		const { job } = await instance.create();
		await instance.run();
		await instance.adapter.updateMany({
			model: "generationJob",
			where: [{ field: "id", value: job.id }],
			update: { expiresAt: new Date(0), nextRunAt: new Date(0) },
		});
		await instance.run();
		const state = await instance.auth.api.inspectGenerationTask({
			body: { jobId: job.id },
		});
		expect(state.job.status).toBe("needs_reconciliation");
		await instance.auth.api.reconcileGenerationTask({
			body: {
				jobId: job.id,
				expectedRevision: state.revision,
				outcome: "resume",
			},
		});
		await instance.run();
		expect((await instance.get(job.id)).job.deliveryStatus).toBe("ready");
		expect(instance.provider.submit).toHaveBeenCalledTimes(1);
	});

	it("enforces download limits even without Content-Length", async () => {
		const provider: GenerationProvider = {
			id: "test-provider",
			submit: vi.fn(async () => ({
				status: "succeeded" as const,
				outputs: [{ mediaType: "image/png", url: "https://cdn.example/image" }],
			})),
			readOutput: vi.fn(
				async () =>
					new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(new Uint8Array(32));
								controller.close();
							},
						}),
					),
			),
		};
		const instance = await setup({ limits: { maxOutputBytes: 8 } }, provider);
		const { job } = await instance.create();
		await instance.run();
		await instance.run(job.id);
		expect(await instance.get(job.id)).toMatchObject({
			job: { deliveryStatus: "pending", lastError: "GENERATION_STORAGE_ERROR" },
			assets: [],
		});
		expect(provider.submit).toHaveBeenCalledTimes(1);
	});

	it("stops a provider that ignores its abort signal without issuing another submission", async () => {
		const provider: GenerationProvider = {
			id: "test-provider",
			submit: vi.fn(() => new Promise<ProviderResult>(() => {})),
		};
		const instance = await setup(
			{ limits: { operationTimeoutMs: 10, leaseMs: 1000 } },
			provider,
		);
		const { job } = await instance.create();
		await instance.run();
		expect((await instance.get(job.id)).job.status).toBe(
			"needs_reconciliation",
		);
		await instance.run();
		expect(provider.submit).toHaveBeenCalledTimes(1);
	});

	it("fails closed when input ownership resolution or moderation fails", async () => {
		const moderation: GenerationPolicy = {
			beforeGenerate: vi.fn(async () => {
				throw new Error("moderation unavailable");
			}),
			beforeDeliver: vi.fn(async () => "allow" as const),
			authorizeDelivery: vi.fn(async () => true),
		};
		const instance = await setup({ policy: moderation });
		const { job } = await instance.create();
		await instance.run();
		expect((await instance.get(job.id)).job.lastError).toBe(
			"GENERATION_POLICY_ERROR",
		);
		vi.mocked(instance.assets.readInput).mockRejectedValueOnce(
			new Error("not owned"),
		);
		const other = await instance.create({
			mode: "image-to-image",
			inputAssets: ["another-users-asset"],
		});
		await instance.run(other.job.id);
		expect((await instance.get(other.job.id)).job.lastError).toBe(
			"GENERATION_INPUT_UNAVAILABLE",
		);
		expect(instance.provider.submit).not.toHaveBeenCalled();
	});

	it("does not accept a poll response bound to another native task", async () => {
		const provider: GenerationProvider = {
			id: "test-provider",
			submit: vi.fn(async () => ({
				status: "running" as const,
				taskId: "original",
			})),
			poll: vi.fn(async () => ({
				status: "succeeded" as const,
				taskId: "different",
				outputs: [{ mediaType: "image/png", base64: "aW1hZ2U=" }],
			})),
		};
		const instance = await setup({}, provider);
		const { job } = await instance.create();
		await instance.run();
		await instance.run(job.id);
		expect(await instance.get(job.id)).toMatchObject({
			job: {
				status: "needs_reconciliation",
				lastError: "GENERATION_INVALID_PROVIDER_RESULT",
			},
			assets: [],
		});
	});
});
