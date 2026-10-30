import * as z from "zod";
import type { MediaUserContext } from "./media-engine-types";
import {
	mediaAssetSchema,
	mediaDerivativeSchema,
	mediaSoundtrackSchema,
} from "./media-engine-types";

type Request = <T>(
	method: string,
	path: string,
	context: MediaUserContext,
	schema: z.ZodType<T>,
	body?: unknown,
) => Promise<T>;
const prepareSchema = z.object({
	variant: z.enum(["muted", "soundtrack"]),
	max_size_bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

/** Task-scoped file delivery; the host keeps every Engine key server-side. */
export function createMediaDeliveryClient(
	request: Request,
	jobPath: (id: string) => string,
	identifier: z.ZodType<string>,
) {
	const derivativePath = (generationId: string, id?: string) =>
		`${jobPath(generationId)}/derivatives${id === undefined ? "" : `/${encodeURIComponent(identifier.parse(id))}`}`;
	return {
		/** Obtain current audio authorization, never an administrator asset-library grant. */
		soundtrackURL: (context: MediaUserContext, generationId: string) =>
			request(
				"GET",
				`${jobPath(generationId)}/soundtrack-url`,
				context,
				z.object({
					url: z.url(),
					expires_in: z.number().int().positive(),
					asset_id: z.string().min(1),
					content_revision: z.string().min(1),
					mime_type: z.enum(["audio/mpeg", "audio/wav"]),
					soundtrack: mediaSoundtrackSchema,
				}),
			),
		/** List independently prepared files without changing the original generation. */
		derivatives: (context: MediaUserContext, generationId: string) =>
			request(
				"GET",
				derivativePath(generationId),
				context,
				z.object({ items: z.array(mediaDerivativeSchema) }),
			),
		/** Reuse the Engine's fixed source identity; repeated requests cannot enlarge its byte cap. */
		prepareDerivative: (
			context: MediaUserContext,
			generationId: string,
			input: z.input<typeof prepareSchema>,
		) =>
			request(
				"POST",
				derivativePath(generationId),
				context,
				z.object({
					derivative: mediaDerivativeSchema,
					upload: z
						.object({
							url: z.url(),
							headers: z.record(z.string(), z.string()),
							expires_in: z.number().int().positive(),
							max_size_bytes: z.number().int().positive(),
						})
						.optional(),
				}),
				prepareSchema.parse(input),
			),
		/** Seal uploaded bytes; readiness still requires the Engine's inspection and publication policy. */
		completeDerivative: (
			context: MediaUserContext,
			generationId: string,
			id: string,
		) =>
			request(
				"POST",
				`${derivativePath(generationId, id)}/complete`,
				context,
				mediaDerivativeSchema,
				{},
			),
		/** Refresh current source and derivative authorization before preview or download. */
		derivativeURL: (
			context: MediaUserContext,
			generationId: string,
			id: string,
		) =>
			request(
				"GET",
				`${derivativePath(generationId, id)}/url`,
				context,
				z.object({
					derivative: mediaDerivativeSchema,
					asset: mediaAssetSchema,
					url: z.url(),
					expires_in: z.number().int().positive(),
				}),
			),
	};
}
