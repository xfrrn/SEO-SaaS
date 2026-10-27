import * as z from "zod";

const webhookSecret = z
	.string()
	.min(32)
	.max(512)
	.refine((value) => value === value.trim() && !/[\r\n\0]/.test(value));
/** Explicit old-key deadlines bound a signing-key rotation overlap. */
export const mediaWebhookSecretSchema = z.union([
	webhookSecret,
	z
		.object({
			current: webhookSecret,
			previous: z
				.array(
					z
						.object({ secret: webhookSecret, expires_at: z.iso.datetime() })
						.strict(),
				)
				.max(2),
		})
		.strict(),
]);
export type MediaWebhookSecret = z.infer<typeof mediaWebhookSecretSchema>;

export const mediaAssetSchema = z.object({
	inspection_error: z.string().optional(),
	moderation_error: z.string().optional(),
	deletion_error: z.string().optional(),
	id: z.string().min(1),
	application_id: z.string().optional(),
	external_user_id: z.string().optional(),
	owner_scope: z.string(),
	content_revision: z.string(),
	revision: z.number().int().positive(),
	kind: z.string(),
	mime_type: z.string(),
	size_bytes: z.number().int().nonnegative(),
	status: z.string(),
	purpose: z.string(),
	inspection_status: z.string(),
	moderation_status: z.string(),
	media_info: z.record(z.string(), z.unknown()),
	metadata: z.record(z.string(), z.unknown()),
	created_at: z.string(),
	expires_at: z.string().nullable().optional(),
});
export const mediaRelationSchema = z.object({
	asset_id: z.string().min(1),
	role: z.enum(["input", "reference", "intermediate", "output"]),
	slot: z.string(),
	position: z.number().int().nonnegative(),
	step_id: z.string().optional(),
});
export const mediaGenerationSchema = z.object({
	id: z.string().min(1),
	external_user_id: z.string(),
	external_request_id: z.string(),
	revision: z.number().int().positive(),
	status: z.enum([
		"queued",
		"running",
		"reconciling",
		"succeeded",
		"failed",
		"cancelled",
	]),
	delivery_status: z.enum([
		"pending",
		"available",
		"review",
		"blocked",
		"unavailable",
	]),
	resolution: z.enum([
		"pending",
		"deliverable",
		"confirmed_no_delivery",
		"needs_reconciliation",
	]),
	reason_code: z.string().optional(),
	template_id: z.string().optional(),
	version: z.number().int().optional(),
	operation_id: z.string().optional(),
	mock: z.boolean(),
	assets: z.array(mediaRelationSchema),
	output: z.record(z.string(), z.unknown()).optional(),
	error: z.string().optional(),
	created_at: z.string().optional(),
});
export const mediaEventSchema = mediaGenerationSchema
	.omit({ id: true })
	.extend({
		event_version: z.literal(2),
		event_id: z.string().min(1).max(256),
		event: z.enum([
			"generation.queued",
			"generation.running",
			"generation.reconciling",
			"generation.succeeded",
			"generation.failed",
			"generation.cancelled",
		]),
		application_id: z.string().min(1),
		generation_id: z.string().min(1),
	});
export type MediaAsset = z.infer<typeof mediaAssetSchema>;
export type MediaGeneration = z.infer<typeof mediaGenerationSchema>;
export type MediaEngineEvent = z.infer<typeof mediaEventSchema>;
export const mediaActionEventSchema = z.object({
	event_version: z.literal(2),
	event_id: z.string().min(1).max(256),
	event: z.literal("moderation.action"),
	application_id: z.string().min(1),
	external_user_id: z.string().min(1),
	action_id: z.string().min(1).max(256),
	attempt_id: z.string().min(1),
	decision_id: z.string().min(1),
	type: z.enum(["ban", "revoke_session", "limit", "challenge"]),
	parameters: z.record(
		z.string(),
		z.union([z.string(), z.number(), z.boolean()]),
	),
	expires_at: z.iso.datetime(),
	reason_code: z.string(),
});
export const mediaNotificationSchema = z.union([
	mediaEventSchema,
	mediaActionEventSchema,
]);
export type MediaEngineActionEvent = z.infer<typeof mediaActionEventSchema>;
export type MediaEngineNotification = z.infer<typeof mediaNotificationSchema>;
export type MediaUserContext =
	| { user_id: string; actor_id?: never; purpose?: "user" }
	| {
			user_id?: string;
			actor_id: string;
			purpose: "manage" | "review" | "enforce";
			reason?: string;
	  };
export type MediaPage<T> = { items: T[]; next_cursor: string };
