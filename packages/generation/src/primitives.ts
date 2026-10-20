import { APIError } from "better-auth";
import * as z from "zod";
import type {
	GenerationJob,
	GenerationJobRow,
	GenerationLimits,
	GenerationRequest,
	ModelSnapshot,
} from "./types";
import { createBody } from "./validation";

export function generationError(
	status: "BAD_REQUEST" | "CONFLICT" | "NOT_FOUND",
	code: string,
) {
	return new APIError(status, { code, message: code });
}

/** Mark explicit provider rejection separately from an ambiguous submission. */
export function generationProviderError(
	outcome: "rejected" | "unknown",
	status?: number,
) {
	return Object.assign(new Error("Generation provider request failed"), {
		generationOutcome: outcome,
		status,
	});
}
export function canonical(value: unknown): string {
	const json = z.json().parse(value);
	function ordered(input: typeof json): typeof json {
		if (Array.isArray(input)) return input.map(ordered);
		if (input && typeof input === "object")
			return Object.fromEntries(
				Object.keys(input)
					.sort()
					.map((key) => [key, ordered(input[key]!)]),
			);
		return input;
	}
	return JSON.stringify(ordered(json));
}
export async function digest(value: string) {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(bytes), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
export function requestOf(job: GenerationJobRow): GenerationRequest {
	return createBody.parse(JSON.parse(job.request));
}
export function modelOf(job: GenerationJobRow): ModelSnapshot {
	return JSON.parse(job.modelSnapshot) as ModelSnapshot;
}
export function publicJob(job: GenerationJobRow): GenerationJob {
	return {
		id: job.id,
		model: job.modelId,
		mode: requestOf(job).mode,
		status: job.status,
		deliveryStatus: job.deliveryStatus,
		cancelRequested: job.cancelRequested,
		lastError: job.lastError,
		createdAt: job.createdAt,
		updatedAt: job.updatedAt,
	};
}
export function limitsOf(
	input: Partial<GenerationLimits> = {},
): GenerationLimits {
	const limits = {
		operationTimeoutMs: 120_000,
		leaseMs: 180_000,
		pollIntervalMs: 10_000,
		taskTimeoutMs: 86_400_000,
		batchSize: 20,
		maxInputBytes: 20 * 1024 * 1024,
		maxOutputBytes: 256 * 1024 * 1024,
		maxResultBytes: 40 * 1024 * 1024,
		...input,
	};
	if (
		Object.values(limits).some(
			(value) => !Number.isSafeInteger(value) || value <= 0,
		) ||
		limits.leaseMs <= limits.operationTimeoutMs ||
		limits.batchSize > 100 ||
		limits.operationTimeoutMs > 2_147_483_647
	)
		throw new Error(
			"Invalid generation limits; leaseMs must exceed operationTimeoutMs",
		);
	return limits;
}
export function bytesFromBase64(value: string, maxBytes: number): Uint8Array {
	if (
		value.length > Math.ceil(maxBytes / 3) * 4 ||
		value.length % 4 !== 0 ||
		!/^[A-Za-z0-9+/]*={0,2}$/.test(value)
	)
		throw new Error("Invalid or oversized generated file");
	const result = Uint8Array.from(atob(value), (character) =>
		character.charCodeAt(0),
	);
	if (result.length === 0 || result.length > maxBytes)
		throw new Error("Invalid or oversized generated file");
	return result;
}
export function base64FromBytes(bytes: Uint8Array) {
	let binary = "";
	for (let start = 0; start < bytes.length; start += 8192)
		binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
	return btoa(binary);
}

export async function bounded<T>(
	signal: AbortSignal,
	work: () => Promise<T>,
): Promise<T> {
	signal.throwIfAborted();
	let abort: () => void = () => {};
	const timeout = new Promise<never>((_resolve, reject) => {
		abort = () => reject(new Error("Generation operation deadline exceeded"));
		signal.addEventListener("abort", abort, { once: true });
	});
	try {
		return await Promise.race([work(), timeout]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}
