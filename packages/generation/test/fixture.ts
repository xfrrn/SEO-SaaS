import { getTestInstance } from "better-auth/test";
import { vi } from "vitest";
import * as z from "zod";
import { generation } from "../src";
import { generationClient } from "../src/client";
import type { GenerationOptions, GenerationProvider } from "../src/types";

export async function setup(
	overrides: Partial<GenerationOptions> = {},
	supplied?: GenerationProvider,
) {
	const provider: GenerationProvider = supplied ?? {
		id: "test-provider",
		submit: vi.fn(async () => ({
			status: "succeeded" as const,
			outputs: [{ mediaType: "image/png", base64: "aW1hZ2U=" }],
		})),
	};
	const assets: GenerationOptions["assets"] = {
		readInput: vi.fn(async () => ({
			bytes: new TextEncoder().encode("input-image"),
			mediaType: "image/png",
		})),
		put: vi.fn(async ({ key, body }) => {
			await new Response(body).arrayBuffer();
			return { ref: `private/${key}` };
		}),
	};
	const config: GenerationOptions = {
		providers: [provider],
		models: [
			{
				id: "picture",
				providerId: provider.id,
				model: "native-image",
				version: "1",
				kind: "image",
				modes: ["text-to-image", "image-to-image"],
				maxInputAssets: 2,
				parameters: z.strictObject({
					size: z.enum(["square", "wide"]).optional(),
				}),
			},
		],
		assets,
		...overrides,
	};
	const instance = await getTestInstance(
		{ plugins: [generation(config)], advanced: { disableOriginCheck: false } },
		{ transaction: true, clientOptions: { plugins: [generationClient()] } },
	);
	const { headers, user } = await instance.signInWithTestUser();
	headers.set("origin", "http://localhost:3000");
	const { adapter } = await instance.auth.$context;
	const fetchOptions = { headers, throw: true as const };
	const create = (
		extra: Partial<
			Parameters<typeof instance.client.generation.create>[0]
		> = {},
	) =>
		instance.client.generation.create({
			model: "picture",
			mode: "text-to-image",
			prompt: "a tree",
			idempotencyKey: crypto.randomUUID(),
			...extra,
			fetchOptions,
		});
	async function run(jobId?: string) {
		if (jobId) {
			const row = await adapter.findOne<{ nextRunAt: Date | null }>({
				model: "generationJob",
				where: [{ field: "id", value: jobId }],
			});
			if (row?.nextRunAt)
				await adapter.updateMany({
					model: "generationJob",
					where: [{ field: "id", value: jobId }],
					update: { nextRunAt: new Date(0) },
				});
		}
		return instance.auth.api.runGenerationTasks();
	}
	const get = (jobId: string) =>
		instance.client.generation.get({ query: { jobId }, fetchOptions });
	return {
		...instance,
		adapter,
		headers,
		user,
		fetchOptions,
		provider,
		assets: config.assets,
		config,
		create,
		run,
		get,
	};
}
