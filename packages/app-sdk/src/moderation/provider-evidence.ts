import * as z from "zod";

const labels = z.array(z.string().min(1).max(128)).max(64);
/** Bound additive provider evidence before it reaches persisted audit records. */
export const providerEvidenceSchema = z.strictObject({
	parameters: z.record(
		z.string().min(1).max(64),
		z.union([z.number().finite(), z.boolean()]),
	),
	labels,
	video: z
		.strictObject({
			scope: z.literal("sampled_frames"),
			report_schema_version: z.number().int().nonnegative(),
			requested_frames: z.number().int().min(8).max(32),
			checked_frames: z.number().int().nonnegative().max(32),
			sampling_complete: z.boolean(),
			frames: z
				.array(
					z.strictObject({
						frame_number: z.number().int().positive(),
						timestamp_seconds: z.number().finite().min(0).max(30),
						nsfw_detected: z.boolean(),
						nsfw: labels,
						special: labels.optional(),
					}),
				)
				.max(32),
		})
		.optional(),
});
