import * as z from "zod";
import { generationProviderError } from "../primitives";
import type {
	GenerationInput,
	GenerationOutput,
	GenerationProvider,
	Parameters,
	ProviderCall,
	ProviderResult,
} from "../types";
import { parametersSchema } from "../validation";
import type { ProviderHTTPOptions } from "./http";
import { endpointPath, providerHTTP } from "./http";

/** Every fal endpoint has its own schema and output shape; map each explicitly. */
export interface FalModelAdapter {
	/** Queue status/result root, e.g. fal-ai/flux-pro for a versioned endpoint. */
	queueModel: string;
	mapInput(input: ProviderCall & { inputs: GenerationInput[] }): Parameters;
	parseOutput(input: unknown): GenerationOutput[];
}
export interface FalGenerationOptions extends ProviderHTTPOptions {
	id?: string;
	models: Record<string, FalModelAdapter>;
}

/** fal queue transport with explicit per-model input/output mapping. */
export function createFalGenerationProvider(
	options: FalGenerationOptions,
): GenerationProvider {
	const http = providerHTTP(
		options,
		"https://queue.fal.run/",
		{ Authorization: `Key ${options.apiKey}` },
		["fal.media", ".fal.media"],
	);
	for (const [model, adapter] of Object.entries(options.models)) {
		endpointPath(model);
		endpointPath(adapter.queueModel);
	}
	function configured(model: string) {
		const mapping = options.models[model];
		if (!mapping) throw generationProviderError("rejected");
		return mapping;
	}
	return {
		id: options.id ?? "fal",
		readOutput: http.readOutput,
		async submit(input) {
			const mapping = configured(input.model.model);
			let body: Parameters;
			try {
				body = parametersSchema.parse(mapping.mapInput(input));
			} catch {
				throw generationProviderError("rejected");
			}
			const response = z
				.object({ request_id: z.string().min(1) })
				.parse(
					await http.request(
						endpointPath(input.model.model),
						input.signal,
						body,
					),
				);
			return { status: "running", taskId: response.request_id };
		},
		async poll({ model, taskId, signal }): Promise<ProviderResult> {
			const mapping = configured(model.model);
			if (!/^[A-Za-z0-9_-]+$/.test(taskId))
				throw new Error("Invalid fal request identifier");
			const root = `${mapping.queueModel}/requests/${taskId}`;
			const response = z
				.object({
					status: z.enum(["IN_QUEUE", "IN_PROGRESS", "COMPLETED", "CANCELLED"]),
				})
				.parse(await http.request(`${root}/status`, signal));
			if (response.status === "CANCELLED")
				return { status: "cancelled", taskId };
			if (response.status !== "COMPLETED") return { status: "running", taskId };
			let result: unknown;
			try {
				result = await http.request(root, signal);
			} catch (error) {
				if (
					error &&
					typeof error === "object" &&
					"status" in error &&
					error.status === 422
				)
					return { status: "failed", taskId, code: "provider_failed" };
				throw error;
			}
			return {
				status: "succeeded",
				taskId,
				outputs: mapping.parseOutput(result),
			};
		},
		async cancel({ model, taskId, signal }) {
			if (!/^[A-Za-z0-9_-]+$/.test(taskId))
				throw new Error("Invalid fal request identifier");
			await http.request(
				`${configured(model.model).queueModel}/requests/${taskId}/cancel`,
				signal,
				undefined,
				"PUT",
			);
			return { status: "running", taskId };
		},
	};
}
