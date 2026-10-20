import type { BetterAuthOptions } from "@better-auth/core";
import { bytesFromBase64, generationError } from "./primitives";
import type { GenerationRuntime } from "./runtime";
import { leaseWhere, listAssets } from "./storage";
import type {
	GenerationAttempt,
	GenerationJobRow,
	GenerationOutput,
	GenerationProvider,
	ProviderResult,
	StoredGenerationAsset,
} from "./types";

/** Bound streams even when Content-Length is absent or dishonest. */
async function fileBody(
	output: GenerationOutput,
	provider: GenerationProvider,
	signal: AbortSignal,
	maximum: number,
) {
	if (output.base64)
		return new Blob([
			new Uint8Array(bytesFromBase64(output.base64, maximum)),
		]).stream();
	if (!provider.readOutput)
		throw new Error("Provider does not support output downloads");
	const response = await provider.readOutput(output, signal);
	if (
		!response.ok ||
		!response.body ||
		Number(response.headers.get("content-length")) > maximum
	) {
		await response.body?.cancel();
		throw new Error("Invalid generation download");
	}
	const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim();
	if (
		mediaType &&
		mediaType !== output.mediaType &&
		mediaType !== "application/octet-stream"
	) {
		await response.body.cancel();
		throw new Error("Unexpected generation media type");
	}
	return response.body;
}

export async function storeOutputs<Options extends BetterAuthOptions>(
	runtime: GenerationRuntime<Options>,
	job: GenerationJobRow,
	attempt: GenerationAttempt,
	provider: GenerationProvider,
	result: Extract<ProviderResult, { status: "succeeded" }>,
	signal: AbortSignal,
) {
	const { adapter, limits, options } = runtime;
	const existing = await listAssets(adapter, job.id);
	for (const [position, output] of result.outputs.entries()) {
		if (existing.some((asset) => asset.position === position)) continue;
		let stored: { ref: string };
		let size = 0;
		let complete = false;
		try {
			const body = await fileBody(
				output,
				provider,
				signal,
				limits.maxOutputBytes,
			);
			const bounded = body.pipeThrough(
				new TransformStream<Uint8Array, Uint8Array>({
					transform(chunk, controller) {
						signal.throwIfAborted();
						size += chunk.byteLength;
						if (size > limits.maxOutputBytes)
							throw new Error("Generated file exceeds size limit");
						controller.enqueue(chunk);
					},
					flush() {
						complete = true;
					},
				}),
			);
			stored = await options.assets.put({
				key: `generation/${job.id}/${attempt.id}/${position}`,
				userId: job.userId,
				mediaType: output.mediaType,
				body: bounded,
				signal,
			});
			if (!complete || size === 0 || !stored.ref || stored.ref.length > 1024)
				throw new Error("Storage did not persist the complete generated file");
			signal.throwIfAborted();
		} catch {
			return false;
		}
		await adapter.transaction(async (db) => {
			const count = await db.updateMany({
				model: "generationJob",
				where: leaseWhere(job),
				update: { updatedAt: new Date() },
			});
			if (count !== 1)
				throw generationError("CONFLICT", "GENERATION_LEASE_LOST");
			await db.create<Omit<StoredGenerationAsset, "id">>({
				model: "generationAsset",
				data: {
					jobId: job.id,
					attemptId: attempt.id,
					position,
					ref: stored.ref,
					mediaType: output.mediaType,
					size,
					width: output.width ?? null,
					height: output.height ?? null,
					durationSeconds: output.durationSeconds ?? null,
					createdAt: new Date(),
				},
			});
		});
	}
	return true;
}
