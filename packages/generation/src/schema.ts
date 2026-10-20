import type { BetterAuthPluginDBSchema } from "@better-auth/core/db";

/** Unique keys, revisions and leases are required; migrate before accepting jobs. */
export const generationSchema = {
	generationJob: {
		fields: {
			userId: { type: "string", required: true, index: true },
			modelId: { type: "string", required: true },
			modelSnapshot: { type: "string", required: true, returned: false },
			request: { type: "string", required: true, returned: false },
			requestHash: { type: "string", required: true, returned: false },
			idempotencyKey: { type: "string", required: true, returned: false },
			status: { type: "string", required: true, index: true },
			deliveryStatus: { type: "string", required: true },
			revision: { type: "number", required: true },
			cancelRequested: { type: "boolean", required: true },
			lastError: { type: "string", required: false },
			nextRunAt: { type: "date", required: false, index: true },
			leaseToken: { type: "string", required: false, returned: false },
			leaseExpiresAt: { type: "date", required: true },
			expiresAt: { type: "date", required: true },
			createdAt: { type: "date", required: true },
			updatedAt: { type: "date", required: true },
		},
		indexes: [{ fields: ["userId", "idempotencyKey"], unique: true }],
	},
	generationAttempt: {
		fields: {
			jobId: { type: "string", required: true, unique: true },
			providerId: { type: "string", required: true },
			providerTaskId: { type: "string", required: false },
			providerTaskKey: { type: "string", required: true, unique: true },
			cancelAttempted: { type: "boolean", required: true },
			outputCount: { type: "number", required: true },
			result: { type: "string", required: false, returned: false },
			createdAt: { type: "date", required: true },
		},
	},
	generationAsset: {
		fields: {
			jobId: { type: "string", required: true, index: true },
			attemptId: { type: "string", required: true },
			position: { type: "number", required: true },
			ref: { type: "string", required: true },
			mediaType: { type: "string", required: true },
			size: { type: "number", required: true },
			width: { type: "number", required: false },
			height: { type: "number", required: false },
			durationSeconds: { type: "number", required: false },
			createdAt: { type: "date", required: true },
		},
		indexes: [{ fields: ["attemptId", "position"], unique: true }],
	},
	generationEvent: {
		fields: {
			jobId: { type: "string", required: true, index: true },
			eventKey: { type: "string", required: true, unique: true },
			kind: { type: "string", required: true },
			payload: { type: "string", required: true, returned: false },
			createdAt: { type: "date", required: true },
		},
	},
} satisfies BetterAuthPluginDBSchema;
