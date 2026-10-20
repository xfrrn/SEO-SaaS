import * as z from "zod";
import { base64FromBytes, generationProviderError } from "../primitives";
import type { GenerationProvider, ProviderResult } from "../types";
import type { ProviderHTTPOptions } from "./http";
import { providerHTTP } from "./http";

/** Interactions response_format fields; model registration can narrow them further. */
export const googleInteractionImageParameters = z.strictObject({
	aspect_ratio: z.string().max(16).optional(),
	image_size: z.enum(["1K", "2K", "4K"]).optional(),
	mime_type: z.enum(["image/png", "image/jpeg", "image/webp"]).optional(),
});
export const googleInteractionVideoParameters = z.strictObject({
	aspect_ratio: z.enum(["16:9", "9:16"]).optional(),
	resolution: z.enum(["360p", "720p", "1080p", "4k"]).optional(),
	duration: z
		.string()
		.regex(/^\d+s$/)
		.max(16)
		.optional(),
});
export interface GoogleInteractionsGenerationOptions
	extends ProviderHTTPOptions {
	id?: string;
}

const interactionSchema = z.object({
	id: z.string().min(1).max(512),
	model: z.string().optional(),
	status: z.enum([
		"queued",
		"in_progress",
		"completed",
		"failed",
		"cancelled",
		"incomplete",
		"requires_action",
	]),
	steps: z
		.array(
			z.object({
				type: z.string(),
				content: z
					.array(
						z.object({
							type: z.string(),
							mime_type: z.string().optional(),
							data: z.string().optional(),
							uri: z.url().optional(),
						}),
					)
					.optional(),
			}),
		)
		.optional(),
});

/** Current Gemini Interactions media protocol, including native background polling. */
export function createGoogleInteractionsGenerationProvider(
	options: GoogleInteractionsGenerationOptions,
): GenerationProvider {
	const http = providerHTTP(
		options,
		"https://generativelanguage.googleapis.com/v1beta/",
		{ "x-goog-api-key": options.apiKey },
		[
			"generativelanguage.googleapis.com",
			"storage.googleapis.com",
			".googleusercontent.com",
		],
	);
	function result(
		value: unknown,
		model: string,
		taskId?: string,
	): ProviderResult {
		const response = interactionSchema.parse(value);
		if (
			(taskId && response.id !== taskId) ||
			(response.model && response.model !== model)
		)
			throw new Error("Google interaction binding mismatch");
		if (response.status === "queued" || response.status === "in_progress")
			return { status: "running", taskId: response.id };
		if (response.status === "cancelled")
			return { status: "cancelled", taskId: response.id };
		if (response.status === "failed" || response.status === "incomplete")
			return { status: "failed", taskId: response.id, code: "provider_failed" };
		if (response.status !== "completed")
			throw new Error("Google interaction requires unsupported action");
		const outputs =
			response.steps
				?.filter((step) => step.type === "model_output")
				.flatMap(
					(step) =>
						step.content?.flatMap((part) => {
							if (
								!["image", "video"].includes(part.type) ||
								!part.mime_type ||
								(!part.data && !part.uri)
							)
								return [];
							return [
								{
									mediaType: part.mime_type,
									...(part.data ? { base64: part.data } : { url: part.uri }),
								},
							];
						}) ?? [],
				) ?? [];
		if (!outputs.length)
			throw new Error("Google interaction has no generated media");
		return { status: "succeeded", taskId: response.id, outputs };
	}
	function taskPath(taskId: string) {
		if (!/^[A-Za-z0-9_-]+$/.test(taskId))
			throw new Error("Invalid Google interaction identifier");
		return `interactions/${taskId}`;
	}
	return {
		id: options.id ?? "google-interactions",
		readOutput: http.readOutput,
		async submit({ model, request, inputs, signal }) {
			const parameters = (
				model.kind === "video"
					? googleInteractionVideoParameters
					: googleInteractionImageParameters
			).safeParse(request.parameters);
			if (!parameters.success) throw generationProviderError("rejected");
			const input = inputs.length
				? [
						...inputs.map((image) => ({
							type: "image",
							mime_type: image.mediaType,
							data: base64FromBytes(image.bytes),
						})),
						{ type: "text", text: request.prompt },
					]
				: request.prompt;
			return result(
				await http.request("interactions", signal, {
					model: model.model,
					input,
					background: true,
					store: true,
					response_format: {
						type: model.kind,
						...(model.kind === "video" ? { delivery: "uri" } : {}),
						...parameters.data,
					},
				}),
				model.model,
			);
		},
		async poll({ model, taskId, signal }) {
			return result(
				await http.request(taskPath(taskId), signal),
				model.model,
				taskId,
			);
		},
		async cancel({ model, taskId, signal }) {
			return result(
				await http.request(`${taskPath(taskId)}/cancel`, signal, {}, "POST"),
				model.model,
				taskId,
			);
		},
	};
}
