import * as z from "zod";

export const identifier = z.string().trim().min(1).max(128);
const taskIdentifier = z.string().min(1).max(512);
export const modeSchema = z.enum([
	"text-to-image",
	"image-to-image",
	"text-to-video",
	"image-to-video",
]);
export const parametersSchema = z.record(z.string(), z.json());
export const createBody = z.strictObject({
	model: identifier,
	mode: modeSchema,
	prompt: z
		.string()
		.min(1)
		.max(32_000)
		.refine((value) => value.trim().length > 0),
	inputAssets: z.array(z.string().min(1).max(1024)).max(16).default([]),
	parameters: parametersSchema.default({}),
	idempotencyKey: z.uuid(),
});
export const detailQuery = z.strictObject({ jobId: identifier });
export const listQuery = z.strictObject({
	limit: z.coerce.number().int().min(1).max(100).default(20),
	offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export const notificationBody = z.strictObject({
	providerId: identifier,
	taskId: taskIdentifier,
	eventId: identifier,
});
export const reconcileBody = z
	.strictObject({
		jobId: identifier,
		expectedRevision: z.number().int().nonnegative(),
		taskId: taskIdentifier.optional(),
		outcome: z.enum(["running", "failed", "resume"]),
	})
	.refine((input) => input.outcome !== "running" || !!input.taskId);
export const outputSchema = z
	.strictObject({
		mediaType: z.enum([
			"image/png",
			"image/jpeg",
			"image/webp",
			"video/mp4",
			"video/webm",
		]),
		url: z.url().max(8192).optional(),
		base64: z.string().min(4).optional(),
		width: z.number().int().positive().optional(),
		height: z.number().int().positive().optional(),
		durationSeconds: z.number().finite().positive().optional(),
	})
	.refine(
		(value) => (value.url !== undefined) !== (value.base64 !== undefined),
	);
export const resultSchema = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("running"), taskId: taskIdentifier }),
	z.strictObject({
		status: z.literal("succeeded"),
		taskId: taskIdentifier.optional(),
		outputs: z.array(outputSchema).min(1).max(16),
		usage: parametersSchema.optional(),
	}),
	z.strictObject({
		status: z.enum(["failed", "cancelled"]),
		taskId: taskIdentifier.optional(),
		code: z.enum(["policy_refused", "provider_failed"]).optional(),
	}),
]);
