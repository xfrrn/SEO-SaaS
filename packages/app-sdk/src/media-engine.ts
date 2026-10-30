import * as z from "zod";
import { createMediaDeliveryClient } from "./media-engine-delivery";
import type {
	MediaUserContext,
	MediaWebhookSecret,
} from "./media-engine-types";
import {
	mediaActionEventSchema,
	mediaAssetSchema,
	mediaEventSchema,
	mediaGenerationSchema,
	mediaNotificationSchema,
	mediaWebhookSecretSchema,
} from "./media-engine-types";

export {
	applyMediaEngineAction,
	mediaEngineActionReceiptSchema,
} from "./media-engine-actions";
export type * from "./media-engine-types";
export {
	mediaActionEventSchema,
	mediaAssetSchema,
	mediaDerivativeSchema,
	mediaEventSchema,
	mediaGenerationSchema,
	mediaNotificationSchema,
	mediaSoundtrackSchema,
	mediaWebhookSecretSchema,
} from "./media-engine-types";

function failure(code: string, status?: number) {
	return Object.assign(new Error(code), { code, status });
}
const identifier = z
	.string()
	.min(1)
	.max(255)
	.refine((value) => value === value.trim() && !/[\r\n\0]/.test(value));
const page = <T extends z.ZodType>(item: T) =>
	z.object({ items: z.array(item), next_cursor: z.string() });

/** Read bounded JSON without including credentials or upstream bodies in exceptions. */
async function responseJSON(
	response: Response,
	maximum: number,
): Promise<unknown> {
	if (!response.body) throw failure("MEDIA_RESPONSE_EMPTY");
	const reader = response.body.getReader(),
		chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			length += next.value.byteLength;
			if (length > maximum) throw failure("MEDIA_RESPONSE_TOO_LARGE");
			chunks.push(next.value);
		}
	} finally {
		await reader.cancel();
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw failure("MEDIA_RESPONSE_INVALID_JSON");
	}
}

/** Server-only transport. The host supplies a verified session or administrator context. */
export function createMediaEngineClient(config: {
	base_url: string;
	api_key: string;
	fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	timeout_ms?: number;
	max_response_bytes?: number;
	/** Pin the server-side application environment before any other API call. */
	expected_environment?: "live" | "sandbox";
}) {
	const origin = new URL(config.base_url);
	if (
		(origin.protocol !== "https:" &&
			!(
				origin.protocol === "http:" &&
				["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
			)) ||
		origin.username ||
		origin.password ||
		origin.pathname !== "/" ||
		origin.search ||
		origin.hash
	)
		throw failure("MEDIA_ENGINE_INVALID_ORIGIN");
	identifier.parse(config.api_key);
	const timeout = z
		.number()
		.int()
		.min(100)
		.max(120000)
		.parse(config.timeout_ms ?? 15000);
	const maximum = z
		.number()
		.int()
		.min(1024)
		.max(8388608)
		.parse(config.max_response_bytes ?? 1048576);
	const transport = config.fetch ?? globalThis.fetch;
	const expected = config.expected_environment;
	if (expected !== undefined && !["live", "sandbox"].includes(expected))
		throw failure("MEDIA_ENGINE_ENVIRONMENT_MISMATCH");
	const applicationSchema = z.object({
		id: z.string().min(1),
		user_scoped: z.boolean(),
		media_permissions: z.array(z.string()),
		environment: z.enum(["live", "sandbox"]).optional(),
	});
	let identityCheck: Promise<void> | undefined;
	function checkEnvironment(value: unknown) {
		if (!expected || !value || typeof value !== "object") return;
		if (
			"id" in value &&
			(("environment" in value ? value.environment : undefined) ?? "live") !==
				expected
		)
			throw failure("MEDIA_ENGINE_ENVIRONMENT_MISMATCH");
		if ("items" in value && Array.isArray(value.items))
			value.items.forEach(checkEnvironment);
		if ("asset" in value) checkEnvironment(value.asset);
		if ("derivative" in value) checkEnvironment(value.derivative);
	}
	async function request<T>(
		method: string,
		path: string,
		context: MediaUserContext | undefined,
		schema: z.ZodType<T>,
		body?: unknown,
		key?: string,
	) {
		if (expected && path !== "/v1/application") {
			identityCheck ??= request(
				"GET",
				"/v1/application",
				undefined,
				applicationSchema,
			).then(() => {});
			await identityCheck;
		}
		const headers: Record<string, string> = {
			Authorization: `Bearer ${config.api_key}`,
			"Content-Type": "application/json",
		};
		if (context?.user_id)
			headers["X-Media-User-ID"] = identifier.parse(context.user_id);
		if (
			context?.purpose === "manage" ||
			context?.purpose === "review" ||
			context?.purpose === "enforce"
		) {
			headers["X-Media-Actor-ID"] = identifier.parse(context.actor_id);
			headers["X-Media-Access-Purpose"] = context.purpose;
			if (context.reason) {
				const reason = context.reason.trim();
				if (
					reason.length < 3 ||
					new TextEncoder().encode(reason).length > 500 ||
					/[\r\n\0]/.test(reason)
				)
					throw failure("MEDIA_REVIEW_REASON_INVALID", 400);
				headers["X-Media-Access-Reason"] = encodeURIComponent(reason);
			}
		} else if (context) {
			identifier.parse(context.user_id);
			headers["X-Media-Access-Purpose"] = "user";
		}
		if (key) headers["Idempotency-Key"] = identifier.parse(key);
		let response: Response;
		try {
			response = await transport(new URL(path, origin), {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(timeout),
				redirect: "error",
			});
		} catch {
			throw failure("MEDIA_ENGINE_UNAVAILABLE");
		}
		const result = await responseJSON(response, maximum);
		if (!response.ok) {
			const error = z
				.object({
					error: z.object({ code: z.string().regex(/^[A-Za-z0-9_]{1,100}$/) }),
				})
				.safeParse(result);
			throw failure(
				error.success ? error.data.error.code : "MEDIA_ENGINE_HTTP_ERROR",
				response.status,
			);
		}
		const parsed = schema.safeParse(result);
		if (!parsed.success) {
			throw failure("MEDIA_ENGINE_CONTRACT_MISMATCH");
		}
		if (/^\/v1\/(application|assets|generations)(\/|\?|$)/.test(path))
			checkEnvironment(parsed.data);
		return parsed.data;
	}
	const assetPath = (id: string) =>
		`/v1/assets/${encodeURIComponent(identifier.parse(id))}`;
	const jobPath = (id: string) =>
		`/v1/generations/${encodeURIComponent(identifier.parse(id))}`;
	const query = (values: Record<string, string | number | undefined>) =>
		new URLSearchParams(
			Object.entries(values)
				.filter(
					(entry): entry is [string, string | number] => entry[1] !== undefined,
				)
				.map(([key, value]) => [key, String(value)]),
		).toString();
	return {
		...createMediaDeliveryClient(request, jobPath, identifier),
		enforcementAction: (context: MediaUserContext, id: string) =>
			request(
				"GET",
				`/v1/moderation/actions/${encodeURIComponent(identifier.parse(id))}`,
				context,
				mediaActionEventSchema,
			),
		acknowledgeAction: (
			context: MediaUserContext,
			id: string,
			receipt: { status: "succeeded" | "failed"; reason_code: string },
		) =>
			request(
				"POST",
				`/v1/moderation/actions/${encodeURIComponent(identifier.parse(id))}/ack`,
				context,
				z.object({ received: z.literal(true) }),
				receipt,
			),
		/** Discover application identity through the authenticated connection, without a fourth env key. */
		application: () =>
			request("GET", "/v1/application", undefined, applicationSchema),
		template: (context: MediaUserContext, id: string) =>
			request(
				"GET",
				`/v1/templates/${encodeURIComponent(identifier.parse(id))}`,
				context,
				z.object({
					id: z.string(),
					version: z.number().int().positive(),
					family_id: z.string().min(1).optional(),
					parent_template_id: z.string().optional(),
					variant_targets: z
						.array(z.enum(["subject", "background"]))
						.optional(),
					status: z.literal("published"),
					supported_output_resolutions: z
						.array(z.string())
						.optional()
						.default([]),
					input_schema: z.array(
						z
							.object({
								key: z.string(),
								type: z.string(),
								required: z.boolean().optional(),
							})
							.passthrough(),
					),
				}),
			),
		templates: (context: MediaUserContext) =>
			request(
				"GET",
				"/v1/templates",
				context,
				z.object({
					items: z.array(
						z.object({
							id: z.string(),
							name: z.string(),
							family_id: z.string().min(1).optional(),
							parent_template_id: z.string().optional(),
							variant_targets: z
								.array(z.enum(["subject", "background"]))
								.optional(),
							version: z.number().int().positive(),
							status: z.string(),
							supported_output_resolutions: z
								.array(z.string())
								.optional()
								.default([]),
							input_schema: z.array(
								z
									.object({
										key: z.string(),
										type: z.string(),
										required: z.boolean().optional(),
									})
									.passthrough(),
							),
						}),
					),
				}),
			),
		/** Reserve a direct upload; bytes go from the browser to the returned storage URL. */
		upload(
			context: MediaUserContext,
			input: {
				name: string;
				content_type: string;
				size_bytes: number;
				purpose: "input" | "reference";
			},
			key: string,
		) {
			return request(
				"POST",
				"/v1/assets/upload-url",
				context,
				z.object({
					asset: mediaAssetSchema,
					upload_url: z.string().optional(),
					method: z.string().optional(),
					headers: z.record(z.string(), z.string()).optional(),
				}),
				{ ...input, external_user_id: context.user_id },
				key,
			);
		},
		complete: (context: MediaUserContext, id: string) =>
			request(
				"POST",
				`${assetPath(id)}/complete`,
				context,
				mediaAssetSchema,
				{},
			),
		asset: (context: MediaUserContext, id: string) =>
			request("GET", assetPath(id), context, mediaAssetSchema),
		assets: (
			context: MediaUserContext,
			filters: Record<string, string | number | undefined> = {},
		) =>
			request(
				"GET",
				`/v1/assets?${query(filters)}`,
				context,
				page(mediaAssetSchema),
			),
		assetURL: (context: MediaUserContext, id: string) =>
			request(
				"GET",
				`${assetPath(id)}/url`,
				context,
				z.object({
					url: z.url(),
					expires_in: z.number().int().positive(),
					asset: mediaAssetSchema,
				}),
			),
		deleteAsset: (context: MediaUserContext, id: string) =>
			request(
				"DELETE",
				assetPath(id),
				context,
				z.object({ status: z.string() }).passthrough(),
			),
		generate(
			context: MediaUserContext,
			input: {
				external_request_id: string;
				template_id: string;
				version: number;
				inputs: Record<string, unknown>;
			},
		) {
			return request(
				"POST",
				"/v1/generations",
				context,
				mediaGenerationSchema,
				{ ...input, external_user_id: context.user_id },
				input.external_request_id,
			);
		},
		generation: (context: MediaUserContext, id: string) =>
			request("GET", jobPath(id), context, mediaGenerationSchema),
		generations: (
			context: MediaUserContext,
			filters: Record<string, string | number | undefined> = {},
		) =>
			request(
				"GET",
				`/v1/generations?${query(filters)}`,
				context,
				page(mediaGenerationSchema),
			),
		cancel: (context: MediaUserContext, id: string) =>
			request(
				"POST",
				`${jobPath(id)}/cancel`,
				context,
				mediaGenerationSchema,
				{},
			),
	};
}

/** Verify the Engine's timestamp + '.' + raw bytes HMAC before parsing an inbox event. */
export async function verifyMediaEngineNotification(input: {
	body: Uint8Array;
	headers: Headers;
	secret: MediaWebhookSecret;
	application_id: string;
	now_ms?: number;
	tolerance_ms?: number;
	max_bytes?: number;
	expected_environment?: "live" | "sandbox";
}) {
	const signing = mediaWebhookSecretSchema.safeParse(input.secret);
	if (!signing.success || input.body.byteLength > (input.max_bytes ?? 1048576))
		throw failure("MEDIA_WEBHOOK_INVALID");
	const now = input.now_ms ?? Date.now();
	const secrets =
		typeof signing.data === "string"
			? [signing.data]
			: [
					signing.data.current,
					...signing.data.previous
						.filter((entry) => Date.parse(entry.expires_at) > now)
						.map((entry) => entry.secret),
				];
	const timestamp = input.headers.get("X-Media-Timestamp") ?? "",
		signature = input.headers.get("X-Media-Signature") ?? "";
	if (
		!/^\d{10}$/.test(timestamp) ||
		!/^sha256=[0-9a-f]{64}$/.test(signature) ||
		Math.abs(now - Number(timestamp) * 1000) > (input.tolerance_ms ?? 300000)
	)
		throw failure("MEDIA_WEBHOOK_INVALID");
	const prefix = new TextEncoder().encode(`${timestamp}.`),
		bytes = new Uint8Array(prefix.length + input.body.length);
	bytes.set(prefix);
	bytes.set(input.body, prefix.length);
	const mac = Uint8Array.from(signature.slice(7).match(/../g)!, (part) =>
		Number.parseInt(part, 16),
	);
	const matches = await Promise.all(
		secrets.map(async (secret) => {
			const key = await crypto.subtle.importKey(
				"raw",
				new TextEncoder().encode(secret),
				{ name: "HMAC", hash: "SHA-256" },
				false,
				["verify"],
			);
			return crypto.subtle.verify("HMAC", key, mac, bytes);
		}),
	);
	if (!matches.some(Boolean)) throw failure("MEDIA_WEBHOOK_INVALID");
	let event: z.infer<typeof mediaNotificationSchema>;
	try {
		event = mediaNotificationSchema.parse(
			JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.body)),
		);
	} catch {
		throw failure("MEDIA_WEBHOOK_CONTRACT_MISMATCH");
	}
	if (
		event.application_id !== input.application_id ||
		event.event_id !== input.headers.get("X-Media-Event-ID") ||
		(event.event !== "moderation.action" &&
			event.event !== `generation.${event.status}`) ||
		!event.external_user_id ||
		(event.event !== "moderation.action" && !event.external_request_id)
	)
		throw failure("MEDIA_WEBHOOK_BINDING_MISMATCH");
	if (
		input.expected_environment &&
		(("environment" in event ? event.environment : undefined) ?? "live") !==
			input.expected_environment
	)
		throw failure("MEDIA_ENGINE_ENVIRONMENT_MISMATCH");
	return event;
}

export async function verifyMediaEngineEvent(
	input: Parameters<typeof verifyMediaEngineNotification>[0],
) {
	const event = await verifyMediaEngineNotification(input);
	if (event.event === "moderation.action")
		throw failure("MEDIA_WEBHOOK_CONTRACT_MISMATCH");
	return mediaEventSchema.parse(event);
}
