import * as z from "zod";
import type { GenerationInput, GenerationOutput, ProviderCall } from "../types";
import type { KieModelAdapter } from "./kie";

/** Conservative Nano Banana 2 settings; narrow/extend for the account's model version. */
export const kieNanoBanana2Parameters = z.strictObject({
	aspect_ratio: z
		.enum(["auto", "1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"])
		.default("auto"),
	resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
	output_format: z.literal("png").default("png"),
});
/** The documented six-second Grok example; no unsupported durations are implied. */
export const kieGrokVideoParameters = z.strictObject({
	aspect_ratio: z.enum(["1:1", "2:3", "3:2", "9:16", "16:9"]).default("16:9"),
	mode: z.literal("normal").default("normal"),
	duration: z.literal("6").default("6"),
	resolution: z.enum(["480p", "720p"]).default("480p"),
});
function inputURLs(
	input: ProviderCall & { inputs: GenerationInput[] },
	maximum: number,
	modes: string[],
) {
	const reference = input.request.mode.startsWith("image-to-");
	if (
		!modes.includes(input.request.mode) ||
		input.inputs.length > maximum ||
		(reference ? !input.inputs.length : input.inputs.length !== 0)
	)
		throw new Error("Unsupported Kie input");
	return input.inputs.map((asset) => {
		const url = new URL(asset.url ?? "");
		if (url.protocol !== "https:" || url.username || url.password || url.hash)
			throw new Error("Kie requires authorized HTTPS input assets");
		return url.href;
	});
}
/** Parse native result URLs; storage enforces MIME and downloads enforce the host allowlist. */
function output(input: unknown, mediaType: string): GenerationOutput[] {
	const native = z
		.object({ resultUrls: z.array(z.url()).min(1).max(16) })
		.parse(input);
	return native.resultUrls.map((url) => {
		const parsed = new URL(url);
		if (
			parsed.protocol !== "https:" ||
			parsed.username ||
			parsed.password ||
			parsed.hash
		)
			throw new Error("Invalid Kie output URL");
		return { url, mediaType };
	});
}
/** Ready-to-register example for nano-banana-2 with PNG output. */
export const kieNanoBanana2Adapter: KieModelAdapter = {
	mapInput(input) {
		const parameters = kieNanoBanana2Parameters.parse(input.request.parameters);
		return {
			...parameters,
			prompt: input.request.prompt,
			image_input: inputURLs(input, 1, ["text-to-image", "image-to-image"]),
		};
	},
	parseOutput: (input) => output(input, "image/png"),
};
/** Ready-to-register example for grok-imagine/text-to-video. */
export const kieGrokTextToVideoAdapter: KieModelAdapter = {
	mapInput(input) {
		inputURLs(input, 0, ["text-to-video"]);
		return {
			...kieGrokVideoParameters.parse(input.request.parameters),
			prompt: input.request.prompt,
		};
	},
	parseOutput: (input) => output(input, "video/mp4"),
};
/** Ready-to-register example for grok-imagine/image-to-video. */
export const kieGrokImageToVideoAdapter: KieModelAdapter = {
	mapInput(input) {
		return {
			...kieGrokVideoParameters.parse(input.request.parameters),
			prompt: input.request.prompt,
			image_urls: inputURLs(input, 1, ["image-to-video"]),
		};
	},
	parseOutput: (input) => output(input, "video/mp4"),
};
