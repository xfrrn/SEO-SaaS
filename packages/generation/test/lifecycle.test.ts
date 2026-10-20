import { describe, expect, it, vi } from "vitest";
import { createGenerationService, generationProviderError } from "../src";
import type {
	GenerationPolicy,
	GenerationProvider,
	ProviderResult,
} from "../src/types";
import { setup } from "./fixture";

const success: ProviderResult = {
	status: "succeeded",
	outputs: [{ mediaType: "image/png", base64: "aW1hZ2U=" }],
};
const asynchronous = (): GenerationProvider => ({
	id: "test-provider",
	submit: vi.fn(async () => ({
		status: "running" as const,
		taskId: "native-task",
	})),
	poll: vi.fn(async () => ({ ...success, taskId: "native-task" })),
});
const policy = (): GenerationPolicy => ({
	beforeGenerate: vi.fn(async () => "allow" as const),
	beforeDeliver: vi.fn(async () => "allow" as const),
	authorizeDelivery: vi.fn(async () => true),
});

describe("generation task recovery", () => {
	it("stages synchronous outputs and retries storage without another paid submission", async () => {
		const instance = await setup();
		const put = vi.mocked(instance.assets.put);
		put.mockRejectedValueOnce(new Error("storage unavailable"));
		const { job } = await instance.create();
		await instance.run();
		await instance.run(job.id);
		expect((await instance.get(job.id)).job.lastError).toBe(
			"GENERATION_STORAGE_ERROR",
		);
		await instance.adapter.updateMany({
			model: "generationJob",
			where: [{ field: "id", value: job.id }],
			update: { nextRunAt: new Date(0) },
		});
		await createGenerationService(instance.adapter, instance.config).run();
		expect((await instance.get(job.id)).job.deliveryStatus).toBe("ready");
		expect(instance.provider.submit).toHaveBeenCalledTimes(1);
		expect(put.mock.calls[0]?.[0].key).toBe(put.mock.calls[1]?.[0].key);
		const attempt = await instance.adapter.findOne<{ result: string | null }>({
			model: "generationAttempt",
			where: [{ field: "jobId", value: job.id }],
		});
		expect(attempt?.result).toBeNull();
	});

	it("pauses ambiguous submissions, and resumes only after trusted reconciliation", async () => {
		const provider = asynchronous();
		vi.mocked(provider.submit).mockRejectedValueOnce(
			new Error("secret credential and provider body"),
		);
		const instance = await setup({}, provider);
		const { job } = await instance.create();
		await instance.run();
		await instance.run();
		expect((await instance.get(job.id)).job).toMatchObject({
			status: "needs_reconciliation",
			lastError: "GENERATION_SUBMISSION_UNKNOWN",
		});
		expect(provider.submit).toHaveBeenCalledTimes(1);
		const state = await instance.auth.api.inspectGenerationTask({
			body: { jobId: job.id },
		});
		await expect(
			instance.auth.api.reconcileGenerationTask({
				body: {
					jobId: job.id,
					expectedRevision: state.revision + 1,
					outcome: "running",
					taskId: "native-task",
				},
			}),
		).rejects.toMatchObject({ status: "CONFLICT" });
		await instance.auth.api.reconcileGenerationTask({
			body: {
				jobId: job.id,
				expectedRevision: state.revision,
				outcome: "running",
				taskId: "native-task",
			},
		});
		await instance.run(job.id);
		await instance.run(job.id);
		expect((await instance.get(job.id)).job.deliveryStatus).toBe("ready");
		expect(provider.submit).toHaveBeenCalledTimes(1);
	});

	it("records explicit rejection as failed without masking it as a timeout", async () => {
		const provider = asynchronous();
		vi.mocked(provider.submit).mockRejectedValueOnce(
			generationProviderError("rejected", 422),
		);
		const instance = await setup({}, provider);
		const { job } = await instance.create();
		await instance.run();
		expect((await instance.get(job.id)).job).toMatchObject({
			status: "failed",
			lastError: "GENERATION_SUBMISSION_REJECTED",
		});
	});

	it("recovers an abandoned submission and prevents the late worker overwriting it", async () => {
		let resolve!: (result: ProviderResult) => void;
		let started!: () => void;
		const ready = new Promise<void>((done) => {
			started = done;
		});
		const provider = asynchronous();
		vi.mocked(provider.submit).mockImplementationOnce(() => {
			started();
			return new Promise((done) => {
				resolve = done;
			});
		});
		const instance = await setup({}, provider);
		const { job } = await instance.create();
		const original = instance.run();
		await ready;
		await instance.adapter.updateMany({
			model: "generationJob",
			where: [{ field: "id", value: job.id }],
			update: { leaseExpiresAt: new Date(0), nextRunAt: new Date(0) },
		});
		await instance.run();
		resolve(success);
		await original;
		expect((await instance.get(job.id)).job.status).toBe(
			"needs_reconciliation",
		);
		expect(provider.submit).toHaveBeenCalledTimes(1);
	});

	it("deduplicates notifications and authenticates results through polling", async () => {
		const provider = asynchronous();
		const instance = await setup({}, provider);
		const { job } = await instance.create();
		await instance.run();
		const body = {
			providerId: provider.id,
			taskId: "native-task",
			eventId: "event-one",
		};
		await instance.auth.api.notifyGenerationTask({ body });
		await instance.auth.api.notifyGenerationTask({ body });
		await instance.run(job.id);
		expect(provider.poll).toHaveBeenCalledTimes(1);
		expect(
			await instance.adapter.count({
				model: "generationEvent",
				where: [{ field: "kind", value: "provider_notification" }],
			}),
		).toBe(1);
		await instance.run(job.id);
		await instance.auth.api.notifyGenerationTask({
			body: { ...body, eventId: "late-event" },
		});
		await instance.run();
		expect((await instance.get(job.id)).job).toMatchObject({
			status: "succeeded",
			deliveryStatus: "ready",
		});
		expect(provider.poll).toHaveBeenCalledTimes(1);
	});

	it("cancels queued jobs and waits for provider confirmation on running jobs", async () => {
		const provider = asynchronous();
		provider.cancel = vi.fn(async () => ({
			status: "running" as const,
			taskId: "native-task",
		}));
		vi.mocked(provider.poll!).mockResolvedValue({
			status: "cancelled",
			taskId: "native-task",
		});
		const instance = await setup({}, provider);
		const queued = await instance.create();
		await instance.client.generation.cancel({
			jobId: queued.job.id,
			fetchOptions: instance.fetchOptions,
		});
		await instance.run();
		expect((await instance.get(queued.job.id)).job.status).toBe("cancelled");
		expect(provider.submit).not.toHaveBeenCalled();
		const { job } = await instance.create();
		await instance.run();
		await instance.client.generation.cancel({
			jobId: job.id,
			fetchOptions: instance.fetchOptions,
		});
		await instance.run(job.id);
		expect((await instance.get(job.id)).job.status).toBe("running");
		await instance.run(job.id);
		expect((await instance.get(job.id)).job.status).toBe("cancelled");
		expect(provider.cancel).toHaveBeenCalledTimes(1);
	});

	it("serializes racing submissions through database leases", async () => {
		const instance = await setup();
		const idempotencyKey = crypto.randomUUID();
		const [first, second] = await Promise.all([
			instance.create({ idempotencyKey }),
			instance.create({ idempotencyKey }),
		]);
		expect(first.job.id).toBe(second.job.id);
		await Promise.all([instance.run(), instance.run()]);
		expect(instance.provider.submit).toHaveBeenCalledTimes(1);
	});

	it("propagates persistence failures and reuses the same storage key after recovery", async () => {
		const instance = await setup();
		const { job } = await instance.create();
		await instance.run();
		const transaction = vi
			.spyOn(instance.adapter, "transaction")
			.mockRejectedValueOnce(new Error("database unavailable"));
		await expect(instance.run(job.id)).rejects.toThrow("database unavailable");
		transaction.mockRestore();
		await instance.adapter.updateMany({
			model: "generationJob",
			where: [{ field: "id", value: job.id }],
			update: { leaseExpiresAt: new Date(0), nextRunAt: new Date(0) },
		});
		await instance.run();
		expect((await instance.get(job.id)).job.deliveryStatus).toBe("ready");
		expect(instance.provider.submit).toHaveBeenCalledTimes(1);
	});

	it("does not treat overdue running tasks as confirmed failures", async () => {
		const instance = await setup({}, asynchronous());
		const { job } = await instance.create();
		await instance.run();
		await instance.adapter.updateMany({
			model: "generationJob",
			where: [{ field: "id", value: job.id }],
			update: { expiresAt: new Date(0), nextRunAt: new Date(0) },
		});
		await instance.run();
		expect((await instance.get(job.id)).job.status).toBe(
			"needs_reconciliation",
		);
	});

	it("respects input review, blocks output delivery and rechecks revocation", async () => {
		const moderation = policy();
		vi.mocked(moderation.beforeGenerate).mockResolvedValueOnce("review");
		const instance = await setup({ policy: moderation });
		const { job } = await instance.create();
		await instance.run();
		expect(instance.provider.submit).not.toHaveBeenCalled();
		expect((await instance.get(job.id)).job.deliveryStatus).toBe("review");
		await instance.run(job.id);
		await instance.run(job.id);
		expect((await instance.get(job.id)).assets).toHaveLength(1);
		vi.mocked(moderation.authorizeDelivery).mockResolvedValue(false);
		expect(await instance.get(job.id)).toMatchObject({
			job: { deliveryStatus: "blocked" },
			assets: [],
		});
		vi.mocked(moderation.beforeDeliver).mockResolvedValue("block");
		const blocked = await instance.create();
		await instance.run();
		await instance.run(blocked.job.id);
		expect(await instance.get(blocked.job.id)).toMatchObject({
			job: { deliveryStatus: "blocked", status: "succeeded" },
			assets: [],
		});
	});

	it("does not submit a job cancelled during input authorization", async () => {
		const moderation = policy();
		let proceed!: () => void;
		let started!: () => void;
		const ready = new Promise<void>((done) => {
			started = done;
		});
		vi.mocked(moderation.beforeGenerate).mockImplementationOnce(async () => {
			started();
			await new Promise<void>((done) => {
				proceed = done;
			});
			return "allow";
		});
		const instance = await setup({ policy: moderation });
		const { job } = await instance.create();
		const running = instance.run();
		await ready;
		await instance.client.generation.cancel({
			jobId: job.id,
			fetchOptions: instance.fetchOptions,
		});
		proceed();
		await running;
		expect(instance.provider.submit).not.toHaveBeenCalled();
		expect((await instance.get(job.id)).job.status).toBe("cancelled");
	});
});
