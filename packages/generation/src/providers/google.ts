import * as z from "zod";
import { base64FromBytes, generationProviderError } from "../primitives";
import type { GenerationProvider, ProviderResult } from "../types";
import type { ProviderHTTPOptions } from "./http";

export type { GoogleInteractionsGenerationOptions } from "./google-interactions";
export {
	createGoogleInteractionsGenerationProvider,
	googleInteractionImageParameters,
	googleInteractionVideoParameters,
} from "./google-interactions";

import { endpointPath, providerHTTP } from "./http";

/** Image generationConfig.imageConfig fields; validate model-specific enums in configuration. */
export const googleImageParameters = z.strictObject({
	aspectRatio: z.string().max(16).optional(),
	imageSize: z.string().max(16).optional(),
});
/** predictLongRunning parameters, distinct from generateContent image configuration. */
export const googleVideoParameters = z.strictObject({
	aspectRatio: z.string().max(16).optional(),
	durationSeconds: z.number().int().positive().max(60).optional(),
	resolution: z.string().max(16).optional(),
	negativePrompt: z.string().max(32_000).optional(),
	personGeneration: z.string().max(32).optional(),
	sampleCount: z.number().int().min(1).max(4).optional(),
	seed: z.number().int().nonnegative().optional(),
});
export interface GoogleGenerationOptions extends ProviderHTTPOptions {
	id?: string;
}

/** Gemini generateContent images and Veo predictLongRunning videos; models are explicit. */
export function createGoogleGenerationProvider(
	options: GoogleGenerationOptions,
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
	return {
		id: options.id ?? "google",
		readOutput: http.readOutput,
		async submit({ model, request, inputs, signal }) {
			const native = endpointPath(model.model);
			if (native.includes("/")) throw generationProviderError("rejected");
			if (model.kind === "video") {
				const parameters = googleVideoParameters.safeParse(request.parameters);
				if (!parameters.success || inputs.length > 1)
					throw generationProviderError("rejected");
				const image = inputs[0];
				const response = z.object({ name: z.string().min(1) }).parse(
					await http.request(`models/${native}:predictLongRunning`, signal, {
						instances: [
							{
								prompt: request.prompt,
								...(image
									? {
											image: {
												bytesBase64Encoded: base64FromBytes(image.bytes),
												mimeType: image.mediaType,
											},
										}
									: {}),
							},
						],
						parameters: parameters.data,
					}),
				);
				return { status: "running", taskId: response.name };
			}
			const parameters = googleImageParameters.safeParse(request.parameters);
			if (!parameters.success) throw generationProviderError("rejected");
			const response = z
				.object({
					promptFeedback: z
						.object({ blockReason: z.string().optional() })
						.optional(),
					candidates: z
						.array(
							z.object({
								finishReason: z.string().optional(),
								content: z
									.object({
										parts: z.array(
											z.object({
												inlineData: z
													.object({ mimeType: z.string(), data: z.string() })
													.optional(),
											}),
										),
									})
									.optional(),
							}),
						)
						.optional(),
				})
				.parse(
					await http.request(`models/${native}:generateContent`, signal, {
						contents: [
							{
								parts: [
									{ text: request.prompt },
									...inputs.map((input) => ({
										inlineData: {
											mimeType: input.mediaType,
											data: base64FromBytes(input.bytes),
										},
									})),
								],
							},
						],
						generationConfig: {
							responseModalities: ["IMAGE"],
							imageConfig: parameters.data,
						},
					}),
				);
			const outputs =
				response.candidates?.flatMap(
					(candidate) =>
						candidate.content?.parts.flatMap((part) =>
							part.inlineData
								? [
										{
											mediaType: part.inlineData.mimeType,
											base64: part.inlineData.data,
										},
									]
								: [],
						) ?? [],
				) ?? [];
			if (!outputs.length) {
				if (
					response.promptFeedback?.blockReason ||
					response.candidates?.some((candidate) =>
						["SAFETY", "IMAGE_SAFETY", "PROHIBITED_CONTENT"].includes(
							candidate.finishReason ?? "",
						),
					)
				)
					return { status: "failed", code: "policy_refused" };
				throw generationProviderError("unknown");
			}
			return { status: "succeeded", outputs };
		},
		async poll({ taskId, model, signal }): Promise<ProviderResult> {
			endpointPath(taskId);
			if (
				!/^(?:models\/[A-Za-z0-9_.-]+\/)?operations\/[A-Za-z0-9_.-]+$/.test(
					taskId,
				) ||
				(taskId.startsWith("models/") &&
					!taskId.startsWith(`models/${model.model}/operations/`))
			)
				throw new Error("Invalid Google operation");
			const response = z
				.object({
					name: z.string(),
					done: z.boolean().optional(),
					error: z.unknown().optional(),
					response: z
						.object({
							generateVideoResponse: z.object({
								generatedSamples: z
									.array(z.object({ video: z.object({ uri: z.url() }) }))
									.optional(),
								raiMediaFilteredCount: z.number().optional(),
							}),
						})
						.optional(),
				})
				.parse(await http.request(taskId, signal));
			if (response.name !== taskId)
				throw new Error("Google operation mismatch");
			if (!response.done) return { status: "running", taskId };
			if (response.error)
				return { status: "failed", taskId, code: "provider_failed" };
			const result = response.response?.generateVideoResponse;
			if (result?.generatedSamples?.length)
				return {
					status: "succeeded",
					taskId,
					outputs: result.generatedSamples.map((sample) => ({
						mediaType: "video/mp4",
						url: sample.video.uri,
					})),
				};
			if (result?.raiMediaFilteredCount)
				return { status: "failed", taskId, code: "policy_refused" };
			throw new Error("Google operation has no video output");
		},
	};
}
