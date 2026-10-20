import { describe, expect, it } from "vitest";
import { setup } from "./fixture";

describe("generation jobs", () => {
	it("persists an owner-scoped idempotent job and delivers a stored result", async () => {
		const instance = await setup();
		const { headers, provider } = instance;
		const input = {
			model: "picture",
			mode: "text-to-image" as const,
			prompt: "a tree",
			idempotencyKey: crypto.randomUUID(),
		};
		const first = await instance.client.generation.create({
			...input,
			fetchOptions: { headers, throw: true },
		});
		const again = await instance.client.generation.create({
			...input,
			fetchOptions: { headers, throw: true },
		});
		expect(again.job.id).toBe(first.job.id);
		await instance.auth.api.runGenerationTasks();
		await instance.auth.api.runGenerationTasks();
		const result = await instance.client.generation.get({
			query: { jobId: first.job.id },
			fetchOptions: { headers, throw: true },
		});
		expect(result.job).toMatchObject({
			status: "succeeded",
			deliveryStatus: "ready",
		});
		expect(result.assets).toHaveLength(1);
		expect(provider.submit).toHaveBeenCalledTimes(1);
	});
});
