import * as z from "zod";

export const inferenceSchema = z.object({
	id: z
		.string()
		.min(1)
		.max(256)
		.regex(/^[A-Za-z0-9_-]+$/),
	object: z.literal("inference"),
	model: z.string(),
	endpoint: z.string(),
	provider: z.literal("seeapi"),
	status: z.enum([
		"queued",
		"processing",
		"succeeded",
		"failed",
		"canceled",
		"refunded",
		"expired",
	]),
	result: z.unknown(),
	error: z.unknown().optional(),
});
export type SeeAPIInference = z.infer<typeof inferenceSchema>;
export function seeAPIFailure(code: string, taskId?: string) {
	return Object.assign(new Error("SeeAPI moderation could not be completed"), {
		seeapiCode: code,
		taskId,
	});
}
export function httpsURL(value: string) {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.hash ||
		(url.port && url.port !== "443")
	)
		throw seeAPIFailure("SEEAPI_INVALID_URL");
	return url;
}
async function wait(ms: number, signal: AbortSignal) {
	signal.throwIfAborted();
	await new Promise<void>((resolve, reject) => {
		const abort = () => {
			clearTimeout(timer);
			reject(seeAPIFailure("SEEAPI_ABORTED"));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, ms);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
	});
}
function delay(response: Response, minimum: number) {
	const header = response.headers.get("Retry-After");
	if (!header) return minimum;
	const seconds = Number(header);
	const value = Number.isFinite(seconds)
		? seconds * 1000
		: Date.parse(header) - Date.now();
	if (!Number.isFinite(value) || value < 0) return minimum;
	if (value > 2_147_483_647) throw seeAPIFailure("SEEAPI_RETRY_DELAY_TOO_LONG");
	return Math.max(minimum, value);
}
async function readJSON(response: Response, maximum: number): Promise<unknown> {
	if (
		!response.body ||
		Number(response.headers.get("Content-Length")) > maximum
	) {
		await response.body?.cancel();
		throw seeAPIFailure("SEEAPI_RESPONSE_TOO_LARGE");
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > maximum) throw seeAPIFailure("SEEAPI_RESPONSE_TOO_LARGE");
			chunks.push(chunk.value);
		}
	} finally {
		await reader.cancel();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return JSON.parse(new TextDecoder().decode(bytes));
}
/** POST replay uses the identical serialized body and idempotency key. */
export function seeAPIHTTP(options: {
	api_key: string;
	base_url: string;
	fetch?: typeof fetch;
	poll_interval_ms: number;
	max_response_bytes: number;
}) {
	const base = httpsURL(options.base_url);
	if (
		base.search ||
		!options.api_key.trim() ||
		!Number.isSafeInteger(options.poll_interval_ms) ||
		options.poll_interval_ms <= 0 ||
		options.poll_interval_ms > 2_147_483_647 ||
		!Number.isSafeInteger(options.max_response_bytes) ||
		options.max_response_bytes <= 0
	)
		throw seeAPIFailure("SEEAPI_INVALID_CONFIGURATION");
	if (!base.pathname.endsWith("/")) base.pathname += "/";
	const fetcher = options.fetch ?? globalThis.fetch;
	async function request(
		path: string,
		signal: AbortSignal,
		body?: string,
		key?: string,
	) {
		for (let attempt = 0; ; attempt++) {
			signal.throwIfAborted();
			const response = await fetcher(new URL(path, base), {
				method: body ? "POST" : "GET",
				signal,
				redirect: "error",
				headers: {
					Authorization: `Bearer ${options.api_key}`,
					...(body
						? { "Content-Type": "application/json", "Idempotency-Key": key! }
						: {}),
				},
				...(body ? { body } : {}),
			});
			if ((response.status === 429 || response.status === 503) && attempt < 2) {
				const ms = delay(response, options.poll_interval_ms * 2 ** attempt);
				await response.body?.cancel();
				await wait(ms, signal);
				continue;
			}
			if (!response.ok) {
				await response.body?.cancel();
				throw seeAPIFailure(`SEEAPI_HTTP_${response.status}`);
			}
			const nextDelay = delay(response, options.poll_interval_ms);
			return {
				task: inferenceSchema.parse(
					await readJSON(response, options.max_response_bytes),
				),
				nextDelay,
			};
		}
	}
	return async (
		body: { model: string; endpoint: string; input: object },
		key: string,
		signal: AbortSignal,
	): Promise<SeeAPIInference> => {
		let taskId: string | undefined;
		try {
			let response = await request(
				"v1/inferences",
				signal,
				JSON.stringify({ ...body, provider: "seeapi" }),
				key,
			);
			taskId = response.task.id;
			for (;;) {
				const task = response.task;
				if (
					task.id !== taskId ||
					task.model !== body.model ||
					task.endpoint !== body.endpoint
				)
					throw seeAPIFailure("SEEAPI_TASK_MISMATCH");
				if (task.status === "succeeded") {
					if (task.error != null || task.result == null)
						throw seeAPIFailure("SEEAPI_RESULT_MISSING");
					return task;
				}
				if (task.status !== "queued" && task.status !== "processing")
					throw seeAPIFailure(`SEEAPI_TASK_${task.status.toUpperCase()}`);
				await wait(response.nextDelay, signal);
				response = await request(
					`v1/inferences/${encodeURIComponent(taskId)}`,
					signal,
				);
			}
		} catch (error) {
			const code =
				error &&
				typeof error === "object" &&
				"seeapiCode" in error &&
				typeof error.seeapiCode === "string"
					? error.seeapiCode
					: signal.aborted
						? "SEEAPI_ABORTED"
						: "SEEAPI_FAILED";
			throw seeAPIFailure(code, taskId);
		}
	};
}
