import * as z from "zod";
import { digest, generationProviderError } from "../primitives";
import type { GenerationProvider } from "../types";
import { parametersSchema } from "../validation";
import type { ProviderHTTPOptions } from "./http";
import { providerHTTP } from "./http";

/** Further restrict these parameters per registered model. */
export const openAIImageParameters = z.strictObject({
	size: z.string().max(32).optional(),
	quality: z.enum(["auto", "low", "medium", "high"]).optional(),
	background: z.enum(["auto", "transparent", "opaque"]).optional(),
	output_format: z.enum(["png", "jpeg", "webp"]).optional(),
	output_compression: z.number().int().min(0).max(100).optional(),
	n: z.number().int().min(1).max(10).optional(),
	moderation: z.enum(["auto", "low"]).optional(),
	input_fidelity: z.enum(["low", "high"]).optional(),
});
export interface OpenAIGenerationOptions extends ProviderHTTPOptions {
	id?: string;
}

/** OpenAI Images generations and multipart edits; synchronous results use durable staging. */
export function createOpenAIGenerationProvider(
	options: OpenAIGenerationOptions,
): GenerationProvider {
	const http = providerHTTP(
		options,
		"https://api.openai.com/v1/",
		{ Authorization: `Bearer ${options.apiKey}` },
		[],
	);
	return {
		id: options.id ?? "openai",
		readOutput: http.readOutput,
		async submit({ model, request, inputs, userId, signal }) {
			if (model.kind !== "image") throw generationProviderError("rejected");
			const parsed = openAIImageParameters.safeParse(request.parameters);
			if (!parsed.success) throw generationProviderError("rejected");
			const parameters = parsed.data;
			const fields = {
				...parameters,
				model: model.model,
				prompt: request.prompt,
				safety_identifier: await digest(userId),
			};
			let body: object | FormData = fields;
			if (inputs.length) {
				const form = new FormData();
				for (const [key, value] of Object.entries(fields))
					if (value !== undefined) form.set(key, String(value));
				for (const [index, image] of inputs.entries())
					form.append(
						"image[]",
						new Blob([new Uint8Array(image.bytes)], { type: image.mediaType }),
						`input-${index}`,
					);
				body = form;
			}
			const response = z
				.object({
					data: z
						.array(
							z.object({
								b64_json: z.string().optional(),
								url: z.url().optional(),
							}),
						)
						.min(1)
						.max(10),
					usage: parametersSchema.optional(),
				})
				.parse(
					await http.request(
						inputs.length ? "images/edits" : "images/generations",
						signal,
						body,
					),
				);
			return {
				status: "succeeded",
				outputs: response.data.map((image) => ({
					mediaType: `image/${parameters.output_format ?? "png"}`,
					...(image.b64_json ? { base64: image.b64_json } : { url: image.url }),
				})),
				...(response.usage ? { usage: response.usage } : {}),
			};
		},
	};
}
