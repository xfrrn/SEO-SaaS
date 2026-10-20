import { APIError } from "better-auth";
import type { BlockLevel, Decision } from "./types";

/** Fail explicitly without reflecting prompts, URLs or credentials into errors. */
export function moderationError(
	code: string,
	message: string,
	details?: Record<string, unknown>,
) {
	return new APIError(
		code === "NOT_FOUND"
			? "NOT_FOUND"
			: code === "FORBIDDEN"
				? "FORBIDDEN"
				: code === "STATE_CONFLICT" ||
						code === "IN_PROGRESS" ||
						code === "IDEMPOTENCY_CONFLICT"
					? "CONFLICT"
					: "BAD_REQUEST",
		{ code, message, ...details },
	);
}
/** Stable JSON supports persisted idempotency and snapshot digests. */
export function canonical(value: unknown): string {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value))
		return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (
		typeof value === "object" &&
		Object.getPrototypeOf(value) === Object.prototype
	) {
		return `{${Object.entries(value)
			.filter(([, entry]) => entry !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
			.join(",")}}`;
	}
	throw moderationError(
		"INVALID_DATA",
		"Moderation data must be finite JSON values",
	);
}
/** Digest identifiers never contain user text; secrets are not accepted here. */
export async function digest(value: unknown): Promise<string> {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(canonical(value)),
	);
	return Array.from(new Uint8Array(bytes), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
/** Bound even a custom adapter which fails to honor its abort signal. */
export async function bounded<T>(
	timeout_ms: number,
	work: (signal: AbortSignal) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	const controller = new AbortController();
	const abort = () => controller.abort(signal?.reason);
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	let timer: ReturnType<typeof setTimeout> | undefined;
	let rejectAbort: (() => void) | undefined;
	try {
		return await Promise.race([
			Promise.resolve().then(() => {
				controller.signal.throwIfAborted();
				return work(controller.signal);
			}),
			new Promise<never>((_resolve, reject) => {
				rejectAbort = () =>
					reject(
						moderationError(
							"DETECTOR_UNAVAILABLE",
							"Moderation operation interrupted",
						),
					);
				controller.signal.addEventListener("abort", rejectAbort, {
					once: true,
				});
				timer = setTimeout(() => controller.abort(), timeout_ms);
				if (controller.signal.aborted) rejectAbort();
			}),
		]);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
		if (rejectAbort)
			controller.signal.removeEventListener("abort", rejectAbort);
	}
}
export function rank(decision: Decision, level: BlockLevel): number {
	return decision === "legal_hold"
		? 4
		: decision === "block"
			? level === "hard"
				? 3
				: 2
			: decision === "review"
				? 1
				: 0;
}
