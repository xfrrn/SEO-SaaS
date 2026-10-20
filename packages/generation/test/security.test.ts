import { describe, expect, it } from "vitest";
import { setup } from "./fixture";

describe("generation authorization and validation", () => {
	it("rejects anonymous, forged ownership, unknown parameters and untrusted origins", async () => {
		const { auth, client, headers } = await setup();
		const anonymous = await auth.handler(
			new Request("http://localhost:3000/api/auth/generation/models"),
		);
		expect(anonymous.status).toBe(401);
		expect(anonymous.headers.get("cache-control")).toBe("no-store");
		const body = {
			model: "picture",
			mode: "text-to-image",
			prompt: "a tree",
			idempotencyKey: crypto.randomUUID(),
		};
		for (const extra of [
			{ userId: "victim" },
			{ parameters: { apiKey: "forged" } },
			{ mode: "image-to-image" },
			{ parameters: { size: "unsupported" } },
			{ inputAssets: ["https://internal.example/secret"] },
		]) {
			const result = await client.$fetch("/generation/create", {
				method: "POST",
				headers,
				body: { ...body, ...extra },
			});
			expect(result.error?.status).toBe(400);
		}
		const untrusted = new Headers(headers);
		untrusted.set("origin", "https://untrusted.example");
		expect(
			(
				await client.$fetch("/generation/create", {
					method: "POST",
					headers: untrusted,
					body,
				})
			).error?.status,
		).toBe(403);
		for (const path of [
			"/generation/run",
			"/generation/notify",
			"/generation/reconcile",
			"/generation/inspect",
		]) {
			const result = await auth.handler(
				new Request(`http://localhost:3000/api/auth${path}`, {
					method: "POST",
					headers,
					body: "{}",
				}),
			);
			expect(result.status).toBe(404);
		}
	});

	it("isolates task detail, history and cancellation by the authenticated owner", async () => {
		const instance = await setup();
		const { job } = await instance.create();
		await instance.auth.api.signUpEmail({
			body: {
				email: "other@generation.example",
				password: "password-123456",
				name: "Other",
			},
		});
		const { headers } = await instance.signInWithUser(
			"other@generation.example",
			"password-123456",
		);
		headers.set("origin", "http://localhost:3000");
		expect(
			(
				await instance.client.generation.get({
					query: { jobId: job.id },
					fetchOptions: { headers },
				})
			).error?.status,
		).toBe(404);
		expect(
			(
				await instance.client.generation.cancel({
					jobId: job.id,
					fetchOptions: { headers },
				})
			).error?.status,
		).toBe(404);
		const listed = await instance.client.generation.list({
			query: {},
			fetchOptions: { headers, throw: true },
		});
		expect(listed).toMatchObject({ jobs: [], total: 0 });
		expect((await instance.get(job.id)).job.id).toBe(job.id);
	});

	it("replays before consulting retired models, but conflicts on a changed payload", async () => {
		const instance = await setup();
		const idempotencyKey = crypto.randomUUID();
		const { job } = await instance.create({
			idempotencyKey,
			parameters: { size: "square" },
		});
		const conflict = await instance.client.generation.create({
			model: "picture",
			mode: "text-to-image",
			prompt: "changed",
			idempotencyKey,
			parameters: { size: "square" },
			fetchOptions: { headers: instance.headers },
		});
		expect(conflict.error?.status).toBe(409);
		const { createGenerationService } = await import("../src");
		const service = createGenerationService(instance.adapter, {
			...instance.config,
			models: [],
		});
		expect(
			(
				await service.create(instance.user.id, {
					model: "picture",
					mode: "text-to-image",
					prompt: "a tree",
					idempotencyKey,
					parameters: { size: "square" },
				})
			).job.id,
		).toBe(job.id);
	});

	it("lists model capability schemas without exposing credentials or private task data", async () => {
		const instance = await setup();
		const models = await instance.client.generation.models({
			fetchOptions: instance.fetchOptions,
		});
		expect(models.models[0]).toMatchObject({
			id: "picture",
			modes: ["text-to-image", "image-to-image"],
			cancelSupported: false,
		});
		expect(models.models[0]?.parameters).toHaveProperty("properties.size");
		const { job } = await instance.create();
		await instance.run();
		const data = await instance.get(job.id);
		expect(data.assets).toEqual([]);
		const json = JSON.stringify(data);
		for (const privateField of [
			"requestHash",
			"leaseToken",
			"providerTaskId",
			"base64",
			"aW1hZ2U=",
		])
			expect(json).not.toContain(privateField);
	});
});
