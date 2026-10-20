import type { BetterAuthOptions } from "@better-auth/core";
import type { DBAdapter } from "@better-auth/core/db/adapter";
import * as z from "zod";
import { canonical, limitsOf, modelOf, requestOf } from "./primitives";
import type {
	GenerationAttempt,
	GenerationJobRow,
	GenerationOptions,
	ModelSnapshot,
	PolicyContext,
} from "./types";
import { identifier, modeSchema } from "./validation";

export function createGenerationRuntime<Options extends BetterAuthOptions>(
	adapter: DBAdapter<Options>,
	options: GenerationOptions,
) {
	if (adapter.id === "memory" || !adapter.options?.adapterConfig.transaction)
		throw new Error(
			"Generation requires real database transactions and unique indexes",
		);
	const providers = new Map(
		options.providers.map((provider) => [provider.id, provider]),
	);
	const models = new Map(options.models.map((model) => [model.id, model]));
	if (
		providers.size !== options.providers.length ||
		models.size !== options.models.length ||
		!options.assets?.put ||
		!options.assets?.readInput
	)
		throw new Error("Invalid generation configuration");
	for (const provider of providers.values()) identifier.parse(provider.id);
	for (const model of models.values()) {
		identifier.parse(model.id);
		identifier.parse(model.version);
		if (
			!model.model ||
			model.model.length > 256 ||
			!providers.has(model.providerId) ||
			!["image", "video"].includes(model.kind) ||
			!Number.isSafeInteger(model.maxInputAssets) ||
			model.maxInputAssets < 0 ||
			model.maxInputAssets > 16 ||
			model.modes.length === 0 ||
			new Set(model.modes).size !== model.modes.length ||
			model.modes.some(
				(mode) =>
					!modeSchema.safeParse(mode).success || !mode.endsWith(model.kind),
			)
		)
			throw new Error("Invalid generation model configuration");
		z.toJSONSchema(model.parameters, { io: "input" });
	}
	const limits = limitsOf(options.limits);
	function snapshot(id: string): ModelSnapshot {
		const model = models.get(id)!;
		return JSON.parse(
			canonical({
				id: model.id,
				providerId: model.providerId,
				model: model.model,
				version: model.version,
				kind: model.kind,
				modes: model.modes,
				maxInputAssets: model.maxInputAssets,
			}),
		) as ModelSnapshot;
	}
	function context(
		job: GenerationJobRow,
		attempt: GenerationAttempt,
		signal: AbortSignal,
	): PolicyContext {
		return {
			jobId: job.id,
			attemptId: attempt.id,
			userId: job.userId,
			request: requestOf(job),
			signal,
		};
	}
	function call(
		job: GenerationJobRow,
		attempt: GenerationAttempt,
		signal: AbortSignal,
	) {
		return {
			model: modelOf(job),
			request: requestOf(job),
			userId: job.userId,
			submissionKey: attempt.id,
			signal,
		};
	}
	return {
		adapter,
		options,
		providers,
		models,
		limits,
		snapshot,
		context,
		call,
	};
}
export type GenerationRuntime<
	Options extends BetterAuthOptions = BetterAuthOptions,
> = ReturnType<typeof createGenerationRuntime<Options>>;
