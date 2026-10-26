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

export {
	kieGrokImageToVideoAdapter,
	kieGrokTextToVideoAdapter,
	kieGrokVideoParameters,
	kieNanoBanana2Adapter,
	kieNanoBanana2Parameters,
} from "./kie-models";

/** Each Market model must explicitly map its supported inputs and native result. */
export interface KieModelAdapter {
	mapInput(input: ProviderCall & { inputs: GenerationInput[] }): Parameters;
	parseOutput(input: unknown): GenerationOutput[];
}
/** Server-owned model registry and exact/subdomain output host allowlist. */
export interface KieGenerationOptions extends ProviderHTTPOptions {
	id?: string;
	downloadHosts: string[];
	models: Record<string, KieModelAdapter>;
}
const envelope = z.object({
	code: z.number().int(),
	data: z.unknown().optional(),
});
const taskIdSchema = z
	.string()
	.min(1)
	.max(512)
	.regex(/^[A-Za-z0-9_-]+$/);
const taskSchema = z.object({
	taskId: taskIdSchema,
	model: z.string(),
	state: z.enum(["waiting", "queuing", "generating", "success", "fail"]),
	resultJson: z.string().nullable().optional(),
});

/** Market tasks use authenticated polling; unknown submissions must be reconciled. */
export function createKieGenerationProvider(
	options: KieGenerationOptions,
): GenerationProvider {
	if (!options.downloadHosts?.length)
		throw new Error("Kie output download hosts must be configured");
	const http = providerHTTP(
		options,
		"https://api.kie.ai/api/v1/",
		{ Authorization: `Bearer ${options.apiKey}` },
		[],
	);
	for (const model of Object.keys(options.models)) endpointPath(model);
	function configured(model: string) {
		const adapter = options.models[model];
		if (!adapter) throw generationProviderError("rejected");
		return adapter;
	}
	async function request(path: string, signal: AbortSignal, body?: object) {
		const parsed = envelope.safeParse(await http.request(path, signal, body));
		if (!parsed.success) throw generationProviderError("unknown");
		if (parsed.data.code !== 200) {
			const rejected = [400, 401, 402, 403, 404, 422, 429].includes(
				parsed.data.code,
			);
			throw generationProviderError(
				rejected ? "rejected" : "unknown",
				parsed.data.code,
			);
		}
		return parsed.data.data;
	}
	return {
		id: options.id ?? "kie",
		readOutput: http.readOutput,
		async submit(input) {
			const adapter = configured(input.model.model);
			let mapped: Parameters;
			try {
				mapped = parametersSchema.parse(adapter.mapInput(input));
			} catch {
				throw generationProviderError("rejected");
			}
			const parsed = z.object({ taskId: taskIdSchema }).safeParse(
				await request("jobs/createTask", input.signal, {
					model: input.model.model,
					input: mapped,
				}),
			);
			if (!parsed.success) throw generationProviderError("unknown");
			return { status: "running", taskId: parsed.data.taskId };
		},
		async poll(input): Promise<ProviderResult> {
			const adapter = configured(input.model.model);
			const taskId = taskIdSchema.parse(input.taskId);
			const task = taskSchema.parse(
				await request(
					`jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
					input.signal,
				),
			);
			if (task.taskId !== taskId || task.model !== input.model.model)
				throw generationProviderError("unknown");
			if (task.state === "fail")
				return { status: "failed", taskId, code: "provider_failed" };
			if (task.state !== "success") return { status: "running", taskId };
			if (!task.resultJson) throw generationProviderError("unknown");
			let native: unknown;
			try {
				native = JSON.parse(task.resultJson);
			} catch {
				throw generationProviderError("unknown");
			}
			return {
				status: "succeeded",
				taskId,
				outputs: adapter.parseOutput(native),
			};
		},
	};
}
