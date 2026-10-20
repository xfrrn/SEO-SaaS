import type { BetterAuthOptions } from "@better-auth/core";
import { APIError } from "better-auth";
import { storeOutputs } from "./assets";
import { bounded, canonical, digest, modelOf } from "./primitives";
import type { GenerationRuntime } from "./runtime";
import { commitJob, findAttempt, findJob, listAssets } from "./storage";
import type {
	GenerationAttempt,
	GenerationInput,
	GenerationJobRow,
	GenerationProvider,
	PolicyDecision,
	ProviderResult,
} from "./types";
import { resultSchema } from "./validation";

const policyDecision = (decision: PolicyDecision) => {
	if (!["allow", "block", "review"].includes(decision))
		throw new Error("Invalid generation policy decision");
	return decision;
};

export function createGenerationWorker<Options extends BetterAuthOptions>(
	runtime: GenerationRuntime<Options>,
) {
	const { adapter, limits, providers, options } = runtime;
	const later = () => new Date(Date.now() + limits.pollIntervalMs);
	async function saveResult(
		job: GenerationJobRow,
		attempt: GenerationAttempt,
		value: ProviderResult,
		cancelling = false,
	) {
		const parsed = resultSchema.safeParse(value);
		if (
			!parsed.success ||
			(attempt.providerTaskId &&
				parsed.data.taskId &&
				parsed.data.taskId !== attempt.providerTaskId)
		) {
			await commitJob(
				adapter,
				job,
				{
					status: "needs_reconciliation",
					nextRunAt: null,
					lastError: "GENERATION_INVALID_PROVIDER_RESULT",
				},
				"needs_reconciliation",
			);
			return;
		}
		const result = parsed.data;
		const serialized = canonical(result);
		if (
			new TextEncoder().encode(serialized).length > limits.maxResultBytes ||
			(result.status === "succeeded" &&
				result.outputs.some(
					(output) => !output.mediaType.startsWith(`${modelOf(job).kind}/`),
				))
		) {
			await commitJob(
				adapter,
				job,
				{
					status: "needs_reconciliation",
					nextRunAt: null,
					lastError: "GENERATION_INVALID_PROVIDER_RESULT",
				},
				"needs_reconciliation",
			);
			return;
		}
		const taskId = result.taskId ?? attempt.providerTaskId;
		await commitJob(
			adapter,
			job,
			{
				status: result.status,
				nextRunAt:
					result.status === "running"
						? later()
						: result.status === "succeeded"
							? new Date()
							: null,
				lastError:
					result.status === "failed"
						? result.code === "policy_refused"
							? "GENERATION_POLICY_REFUSED"
							: "GENERATION_PROVIDER_FAILED"
						: null,
			},
			"provider_result",
			{
				providerTaskId: taskId,
				providerTaskKey: taskId
					? await digest(canonical([attempt.providerId, taskId]))
					: attempt.providerTaskKey,
				result: serialized,
				outputCount: result.status === "succeeded" ? result.outputs.length : 0,
				cancelAttempted: cancelling || attempt.cancelAttempted,
			},
		);
	}
	async function submit(
		job: GenerationJobRow,
		attempt: GenerationAttempt,
		provider: GenerationProvider,
		signal: AbortSignal,
	) {
		const call = runtime.call(job, attempt, signal);
		let inputs: GenerationInput[];
		let decision: PolicyDecision;
		try {
			inputs = await bounded(signal, () =>
				Promise.all(
					call.request.inputAssets.map((ref) =>
						options.assets.readInput({ userId: job.userId, ref, signal }),
					),
				),
			);
			if (
				inputs.some(
					(input) =>
						!(input.bytes instanceof Uint8Array) ||
						input.bytes.byteLength === 0 ||
						input.bytes.byteLength > limits.maxInputBytes ||
						!["image/png", "image/jpeg", "image/webp"].includes(
							input.mediaType,
						),
				)
			)
				throw new Error("Invalid input image");
		} catch {
			await commitJob(
				adapter,
				job,
				{
					status: "failed",
					nextRunAt: null,
					lastError: "GENERATION_INPUT_UNAVAILABLE",
				},
				"input_failed",
			);
			return;
		}
		try {
			decision = options.policy
				? policyDecision(
						await bounded(signal, () =>
							options.policy!.beforeGenerate({
								...runtime.context(job, attempt, signal),
								inputs,
							}),
						),
					)
				: "allow";
		} catch {
			await commitJob(
				adapter,
				job,
				{ nextRunAt: later(), lastError: "GENERATION_POLICY_ERROR" },
				"policy_error",
			);
			return;
		}
		if (decision !== "allow") {
			await commitJob(
				adapter,
				job,
				{
					status: decision === "block" ? "failed" : "queued",
					deliveryStatus: decision === "block" ? "blocked" : "review",
					nextRunAt: decision === "block" ? null : later(),
					lastError: decision === "block" ? "GENERATION_INPUT_BLOCKED" : null,
				},
				"input_policy",
			);
			return;
		}
		job = await commitJob(
			adapter,
			job,
			{ status: "submitting", deliveryStatus: "pending", lastError: null },
			"submitting",
			undefined,
			false,
		);
		let result: ProviderResult;
		try {
			result = await bounded(signal, () =>
				provider.submit({ ...call, inputs }),
			);
		} catch (error) {
			const rejected =
				error !== null &&
				typeof error === "object" &&
				"generationOutcome" in error &&
				error.generationOutcome === "rejected";
			await commitJob(
				adapter,
				job,
				{
					status: rejected ? "failed" : "needs_reconciliation",
					nextRunAt: null,
					lastError: rejected
						? "GENERATION_SUBMISSION_REJECTED"
						: "GENERATION_SUBMISSION_UNKNOWN",
				},
				"submission_error",
			);
			return;
		}
		await saveResult(job, attempt, result);
	}
	async function poll(
		job: GenerationJobRow,
		attempt: GenerationAttempt,
		provider: GenerationProvider,
		signal: AbortSignal,
	) {
		if (!attempt.providerTaskId || !provider.poll) {
			await commitJob(
				adapter,
				job,
				{
					status: "needs_reconciliation",
					nextRunAt: null,
					lastError: "GENERATION_POLL_UNAVAILABLE",
				},
				"needs_reconciliation",
			);
			return;
		}
		const cancelling =
			job.cancelRequested && !!provider.cancel && !attempt.cancelAttempted;
		let result: ProviderResult;
		try {
			const call = {
				...runtime.call(job, attempt, signal),
				taskId: attempt.providerTaskId,
			};
			result = await bounded(signal, () =>
				cancelling ? provider.cancel!(call) : provider.poll!(call),
			);
		} catch {
			await commitJob(
				adapter,
				job,
				{
					nextRunAt: later(),
					lastError: cancelling
						? "GENERATION_CANCEL_FAILED"
						: "GENERATION_POLL_FAILED",
				},
				"poll_error",
				cancelling ? { cancelAttempted: true } : undefined,
			);
			return;
		}
		await saveResult(job, attempt, result, cancelling);
	}
	async function deliver(
		job: GenerationJobRow,
		attempt: GenerationAttempt,
		provider: GenerationProvider,
		signal: AbortSignal,
	) {
		if (attempt.result) {
			const result = resultSchema.parse(JSON.parse(attempt.result));
			if (result.status !== "succeeded")
				throw new Error("Generation result state is inconsistent");
			const stored = await bounded(signal, () =>
				storeOutputs(runtime, job, attempt, provider, result, signal),
			);
			if (!stored) {
				await commitJob(
					adapter,
					job,
					{ nextRunAt: later(), lastError: "GENERATION_STORAGE_ERROR" },
					"storage_error",
				);
				return;
			}
		}
		const assets = await listAssets(adapter, job.id);
		if (assets.length !== attempt.outputCount || assets.length === 0)
			throw new Error("Generation output metadata is incomplete");
		let decision: PolicyDecision;
		try {
			decision = options.policy
				? policyDecision(
						await bounded(signal, () =>
							options.policy!.beforeDeliver({
								...runtime.context(job, attempt, signal),
								assets,
							}),
						),
					)
				: "allow";
		} catch {
			await commitJob(
				adapter,
				job,
				{ nextRunAt: later(), lastError: "GENERATION_POLICY_ERROR" },
				"policy_error",
				{ result: null },
			);
			return;
		}
		await commitJob(
			adapter,
			job,
			{
				deliveryStatus:
					decision === "allow"
						? "ready"
						: decision === "block"
							? "blocked"
							: "review",
				nextRunAt: decision === "review" ? later() : null,
				lastError: decision === "block" ? "GENERATION_OUTPUT_BLOCKED" : null,
			},
			"delivery_policy",
			{ result: null },
		);
	}
	async function process(job: GenerationJobRow) {
		const attempt = await findAttempt(adapter, job.id);
		if (job.status === "submitting" || job.expiresAt.getTime() <= Date.now()) {
			await commitJob(
				adapter,
				job,
				{
					status: job.status === "queued" ? "failed" : "needs_reconciliation",
					nextRunAt: null,
					lastError:
						job.status === "submitting"
							? "GENERATION_SUBMISSION_UNKNOWN"
							: "GENERATION_DEADLINE_EXCEEDED",
				},
				"needs_reconciliation",
			);
			return;
		}
		if (job.cancelRequested && job.status === "queued") {
			await commitJob(
				adapter,
				job,
				{ status: "cancelled", nextRunAt: null, lastError: null },
				"cancelled",
			);
			return;
		}
		const provider = providers.get(attempt.providerId);
		if (!provider) {
			await commitJob(
				adapter,
				job,
				{
					status: job.status === "queued" ? "failed" : "needs_reconciliation",
					nextRunAt: null,
					lastError: "GENERATION_PROVIDER_UNAVAILABLE",
				},
				"provider_unavailable",
			);
			return;
		}
		const signal = AbortSignal.timeout(limits.operationTimeoutMs);
		if (job.status === "queued") await submit(job, attempt, provider, signal);
		else if (job.status === "running")
			await poll(job, attempt, provider, signal);
		else if (job.status === "succeeded")
			await deliver(job, attempt, provider, signal);
		else throw new Error("Unexpected schedulable generation status");
	}
	return async function run() {
		const now = new Date();
		const jobs = await adapter.findMany<GenerationJobRow>({
			model: "generationJob",
			where: [
				{ field: "nextRunAt", value: now, operator: "lte" },
				{ field: "leaseExpiresAt", value: now, operator: "lte" },
			],
			limit: limits.batchSize,
			sortBy: { field: "nextRunAt", direction: "asc" },
		});
		let processed = 0;
		for (const candidate of jobs) {
			const count = await adapter.updateMany({
				model: "generationJob",
				where: [
					{ field: "id", value: candidate.id },
					{ field: "revision", value: candidate.revision },
					{ field: "leaseExpiresAt", value: new Date(), operator: "lte" },
				],
				update: {
					revision: candidate.revision + 1,
					leaseToken: crypto.randomUUID(),
					leaseExpiresAt: new Date(Date.now() + limits.leaseMs),
				},
			});
			if (count !== 1) continue;
			try {
				await process(await findJob(adapter, candidate.id));
			} catch (error) {
				if (
					error instanceof APIError &&
					error.body?.code === "GENERATION_LEASE_LOST"
				)
					continue;
				throw error;
			}
			processed++;
		}
		return { processed };
	};
}
